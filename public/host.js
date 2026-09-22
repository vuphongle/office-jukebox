// Host projector page: control the YouTube player from the server queue and
// report playback events so the server can advance to the next song.

let player = null;
let playerReady = false;
let started = false;
const myTabId = Math.random().toString(36).slice(2) + Date.now().toString(36);
const hostCoordinationChannel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("jukebox_host_coordination") : null;
if (hostCoordinationChannel) {
  hostCoordinationChannel.onmessage = (e) => {
    if (e.data && e.data.type === "host_claimed_playback" && e.data.tabId !== myTabId) {
      if (started) {
        console.warn("[host] Một cửa sổ Host khác đã nhận quyền phát nhạc; tạm dừng cửa sổ này.");
        started = false;
        if (player?.stopVideo) player.stopVideo();
        if (spotifyPlayer?.pause) spotifyPlayer.pause();
        if (scWidget?.pause) { try { scWidget.pause(); } catch {} }
        const scIframe = document.getElementById("sc-widget-iframe");
        if (scIframe && scIframe.src && scIframe.src.includes("auto_play=true")) {
          scIframe.src = "https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/293&auto_play=false";
        }
        document.getElementById("start-overlay").classList.remove("hidden");
        document.getElementById("stage").classList.add("hidden");
      }
    }
  };
}
let currentVideoId = null;
let currentPlaybackToken = null;
let terminalReportedForToken = null;
let playbackEventHandlers = null;
let latestState = { nowPlaying: null, queue: [] };

// Multi-platform state
let activePlayerProvider = "youtube";
let spotifyPlayer = null;
let spotifyReady = false;
let spotifyDeviceId = null;
let spotifyPlayerState = null;
let spotifyWasPlaying = false;
let spotifyProgressTimer = null;
let spotifyStatus = { connected: false, configured: false };
let scWidget = null;
let scReady = false;
let scIsPlaying = false;
let filterOn = false;
let moderationMode = "default"; // "default" | "strict" (protocol values)
let moderationConfigured = false;
let cooldownSeconds = 15;
let eventContext = "";
let queueLimitOn = false;
let queueLimit = 10;
let requireName = false;
let voteSortOn = true;
let hostToken = null; // null until Host authentication has been verified
let ws = null;
let draggedQueueId = null;
let orderNetworkHostStatusTimer = null;
let orderNetworkHostRefreshTimer = null;
let orderNetworkHostUpdateIsManual = false;
const ORDER_NETWORK_HOST_REFRESH_MS = 15 * 60 * 1000;
const NO_THUMB = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E';

function safeImageUrl(value) {
  if (typeof value !== "string" || !value.trim()) return NO_THUMB;
  try {
    const url = new URL(value, location.origin);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : NO_THUMB;
  } catch {
    return NO_THUMB;
  }
}

// ---- WebSocket connection --------------------------------------------------
function sendAuth() {
  if (hostToken && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "auth", token: hostToken }));
}

function setOrderNetworkHostStatus(message) {
  const status = document.getElementById("order-network-host-status");
  status.textContent = message;
  status.classList.remove("hidden");
  if (message.includes("Đã lưu") || message.includes("thành công") || message.includes("đã cập nhật")) {
    status.classList.add("ok");
    status.classList.remove("bad");
  } else {
    status.classList.add("bad");
    status.classList.remove("ok");
  }
  clearTimeout(orderNetworkHostStatusTimer);
  orderNetworkHostStatusTimer = setTimeout(() => status.classList.add("hidden"), 5000);
}

function registerOrderNetworkHost({ manual = false } = {}) {
  // Only the projector that has started playback can refresh automatically.
  if (!manual && (hostToken === null || !started)) return false;
  if (!send({ type: "registerOrderNetworkHost" })) {
    if (manual) setOrderNetworkHostStatus("Mất kết nối Host. Vui lòng thử lại.");
    return false;
  }
  orderNetworkHostUpdateIsManual = manual;
  if (manual) setOrderNetworkHostStatus("Đang cập nhật mạng host…");
  return true;
}

function startOrderNetworkHostRefresh() {
  if (hostToken === null || !started || orderNetworkHostRefreshTimer) return;
  orderNetworkHostRefreshTimer = setInterval(() => registerOrderNetworkHost(), ORDER_NETWORK_HOST_REFRESH_MS);
}

// If a song ends while the WebSocket is disconnected, the "ended" message may
// be lost and the server may keep it as the current song; resync on reconnect.
function reportIfEnded() {
  if (
    currentVideoId && currentPlaybackToken &&
    terminalReportedForToken !== currentPlaybackToken
  ) {
    let ended = false;
    let playedSeconds = null;
    if (activePlayerProvider === "youtube" && playerReady && player?.getPlayerState && player.getPlayerState() === YT.PlayerState.ENDED) {
      ended = true;
      playedSeconds = player.getCurrentTime ? player.getCurrentTime() : null;
    } else if (activePlayerProvider === "spotify" && spotifyPlayerState) {
      if (spotifyPlayerState.paused && spotifyPlayerState.position === 0 && spotifyWasPlaying) {
        ended = true;
        playedSeconds = spotifyPlayerState.duration ? spotifyPlayerState.duration / 1000 : null;
      }
    }
    if (ended) {
      if (send({
        type: "ended",
        videoId: currentVideoId,
        playbackToken: currentPlaybackToken,
        playedSeconds,
      })) {
        terminalReportedForToken = currentPlaybackToken;
      }
    }
  }
}

function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${proto}://${location.host}`);
  ws = socket;
  socket.onopen = () => {
    // A terminal send can be acknowledged locally by WebSocket.send() and
    // still be lost while the connection is closing. Re-arm reporting on each
    // reconnect; the server-side playback token makes duplicate reports safe.
    terminalReportedForToken = null;
    sendAuth(); // re-authenticate after every connection/reconnection
    registerOrderNetworkHost();
    reportIfEnded();
    if (currentVideoId && currentPlaybackToken) {
      armPlaybackWatchdog(currentVideoId, currentPlaybackToken);
    }
  };
  socket.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
    if (msg.type === "orderNetworkHostUpdated") {
      const button = document.getElementById("order-network-host");
      if (orderNetworkHostUpdateIsManual) {
        button.textContent = "Mạng host đã cập nhật";
        button.classList.add("on");
        setTimeout(() => {
          button.textContent = "Cập nhật ngay";
          button.classList.remove("on");
        }, 2500);
      } else {
        setOrderNetworkHostStatus("Mạng Internet của Host đã được tự động cập nhật.");
      }
      orderNetworkHostUpdateIsManual = false;
      return;
    }
    if (msg.type === "orderNetworkHostError") {
      setOrderNetworkHostStatus(msg.reason || "Không thể cập nhật mạng host.");
      return;
    }
    if (msg.type === "state" && msg.state && typeof msg.state === "object") {
      latestState = msg.state;
      if (typeof msg.filterOn === "boolean") filterOn = msg.filterOn;
      if (typeof msg.moderationMode === "string") moderationMode = msg.moderationMode;
      if (typeof msg.cooldownSeconds === "number") cooldownSeconds = msg.cooldownSeconds;
      if (typeof msg.eventContext === "string") eventContext = msg.eventContext;
      if (typeof msg.queueLimitOn === "boolean") queueLimitOn = msg.queueLimitOn;
      if (typeof msg.queueLimit === "number") queueLimit = msg.queueLimit;
      if (typeof msg.requireName === "boolean") requireName = msg.requireName;
      if (typeof msg.voteSortOn === "boolean") voteSortOn = msg.voteSortOn;
      render();
      renderFilter();
      renderCooldown();
      renderContext();
      renderQueueLimit();
      renderRequireName();
      renderVoteSort();
      syncPlayer();
    }
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    terminalReportedForToken = null;
    clearTimeout(playbackWatchdog);
    setTimeout(() => {
      if (!ws) connectWs();
    }, 1500);
  }; // reconnect automatically
}
function send(obj) {
  if (!ws || ws.readyState !== 1) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

// ---- Queue drag and drop ---------------------------------------------------
function queueItemFromEvent(event) {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const item = target.closest("#queue li[data-id]");
  return item && item.parentElement === document.getElementById("queue") ? item : null;
}

function clearQueueDragState() {
  const ul = document.getElementById("queue");
  if (ul) {
    ul.querySelectorAll(".q-dragging, .q-drop-before, .q-drop-after").forEach((item) => {
      item.classList.remove("q-dragging", "q-drop-before", "q-drop-after");
    });
  }
  draggedQueueId = null;
}

function dropBeforeId(target, event) {
  const rect = target.getBoundingClientRect();
  const dropAfter = event.clientY >= rect.top + rect.height / 2;
  const anchor = dropAfter ? target.nextElementSibling : target;
  return anchor?.dataset.id || null;
}

function wireQueueDrag() {
  const ul = document.getElementById("queue");

  ul.addEventListener("dragstart", (event) => {
    const item = queueItemFromEvent(event);
    const source = event.target instanceof Element ? event.target : null;
    if (!item || source?.closest("button")) {
      event.preventDefault();
      return;
    }

    draggedQueueId = item.dataset.id;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggedQueueId);
    }
    requestAnimationFrame(() => {
      if (draggedQueueId === item.dataset.id) item.classList.add("q-dragging");
    });
  });

  ul.addEventListener("dragover", (event) => {
    const target = queueItemFromEvent(event);
    if (!draggedQueueId || !target || target.dataset.id === draggedQueueId) return;

    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    ul.querySelectorAll(".q-drop-before, .q-drop-after").forEach((item) => {
      item.classList.remove("q-drop-before", "q-drop-after");
    });
    const rect = target.getBoundingClientRect();
    target.classList.add(event.clientY >= rect.top + rect.height / 2 ? "q-drop-after" : "q-drop-before");
  });

  ul.addEventListener("drop", (event) => {
    const target = queueItemFromEvent(event);
    if (!draggedQueueId || !target || target.dataset.id === draggedQueueId) return;

    event.preventDefault();
    send({ type: "reorder", id: draggedQueueId, beforeId: dropBeforeId(target, event) });
    clearQueueDragState();
  });

  ul.addEventListener("dragend", clearQueueDragState);
}

// ---- YouTube IFrame API ----------------------------------------------------
window.onYouTubeIframeAPIReady = function () {
  player = new YT.Player("player", {
    height: "100%",
    width: "100%",
    playerVars: { autoplay: 0, controls: 1, rel: 0, modestbranding: 1, playsinline: 1 },
    events: {
      onReady: () => {
        playerReady = true;
        syncPlayer();
      },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.PLAYING) {
          clearTimeout(playbackWatchdog);
          hidePlaybackRecovery();
        }
        updatePlayPauseIcon();
      },
      onAutoplayBlocked: () => showPlaybackRecovery(),
      onError: () => {},
    },
  });
};

// ---- Real-time Synced Lyrics (LRCLIB & Local API) --------------------------
let currentLyrics = null;
let currentLyricsActiveIndex = -1;
let isLyricsMode = false;
let currentLyricsTrackKey = "";

async function loadLyrics(rawTitle, rawArtist, duration) {
  const lyricsClient = window.JukeboxLyrics;
  const cleaned = lyricsClient
    ? lyricsClient.cleanLyricsQuery(rawTitle, rawArtist)
    : { title: (rawTitle || "").trim(), artist: (rawArtist || "").trim() };
  const trackKey = `${cleaned.artist.toLowerCase()}:::${cleaned.title.toLowerCase()}`;
  if (trackKey === currentLyricsTrackKey && currentLyrics) {
    return;
  }
  currentLyricsTrackKey = trackKey;
  currentLyrics = null;
  currentLyricsActiveIndex = -1;

  const contentEl = document.getElementById("spotify-lyrics-content");
  if (contentEl) {
    contentEl.innerHTML = `<div class="spotify-lyrics-loading">Đang tải lời bài hát đồng bộ…</div>`;
  }

  let durSec = null;
  if (typeof duration === "string" && duration.includes(":")) {
    const p = duration.split(":").map(Number);
    if (p.length === 2) durSec = p[0] * 60 + p[1];
  } else if (typeof duration === "number") {
    durSec = duration;
  }

  const data = lyricsClient
    ? await lyricsClient.fetchLyricsClient({ title: rawTitle, artist: rawArtist, durationSec: durSec })
    : null;

  if (trackKey !== currentLyricsTrackKey) return;

  if (!data || !data.lines || data.lines.length === 0) {
    currentLyrics = null;
    if (contentEl) {
      contentEl.innerHTML = `<div class="spotify-lyrics-empty"><span>🎵</span><span>Chưa có lời bài hát đồng bộ cho bài hát này.</span></div>`;
    }
    return;
  }

  currentLyrics = data;
  renderLyricsLines(data.lines);
}

function renderLyricsLines(lines) {
  const contentEl = document.getElementById("spotify-lyrics-content");
  if (!contentEl) return;
  contentEl.innerHTML = "";

  const frag = document.createDocumentFragment();
  lines.forEach((line, idx) => {
    const lineEl = document.createElement("div");
    lineEl.className = "spotify-lyric-line";
    lineEl.dataset.index = idx;
    lineEl.dataset.time = line.time;
    lineEl.textContent = line.text;
    lineEl.addEventListener("click", () => {
      seekSpotifyTo(line.time);
      syncLyricsPosition(line.time, true);
    });
    frag.appendChild(lineEl);
  });
  contentEl.appendChild(frag);

  // Sync with current player position immediately
  const curPos = (spotifyPlayerState?.position || 0) / 1000;
  syncLyricsPosition(curPos, true);
}

function syncLyricsPosition(curSec, forceScroll = false) {
  if (!currentLyrics || !Array.isArray(currentLyrics.lines) || currentLyrics.lines.length === 0) return;
  const lines = currentLyrics.lines;

  // Find index of current active line: largest index where line.time <= curSec
  let activeIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= curSec + 0.25) {
      activeIdx = i;
    } else {
      break;
    }
  }

  if (activeIdx === currentLyricsActiveIndex && !forceScroll) return;
  currentLyricsActiveIndex = activeIdx;

  const contentEl = document.getElementById("spotify-lyrics-content");
  if (!contentEl) return;
  const lineEls = contentEl.children;

  for (let i = 0; i < lineEls.length; i++) {
    const el = lineEls[i];
    if (i === activeIdx) {
      el.classList.add("active");
      el.classList.remove("passed");
    } else if (i < activeIdx) {
      el.classList.remove("active");
      el.classList.add("passed");
    } else {
      el.classList.remove("active");
      el.classList.remove("passed");
    }
  }

  if (activeIdx >= 0 && lineEls[activeIdx]) {
    const activeEl = lineEls[activeIdx];
    const scroller = document.getElementById("spotify-lyrics-scroller");
    if (scroller) {
      const scrollerHeight = scroller.clientHeight;
      const targetScroll = activeEl.offsetTop - scrollerHeight / 2 + activeEl.clientHeight / 2;
      scroller.scrollTo({
        top: Math.max(0, targetScroll),
        behavior: forceScroll ? "auto" : "smooth",
      });
    }
  }
}

function toggleLyricsMode(forceState) {
  const playerSpotifyEl = document.getElementById("player-spotify");
  const lyricsBtn = document.getElementById("spotify-btn-lyrics");
  if (!playerSpotifyEl) return;

  isLyricsMode = typeof forceState === "boolean" ? forceState : !isLyricsMode;
  playerSpotifyEl.classList.toggle("lyrics-mode-active", isLyricsMode);
  if (lyricsBtn) lyricsBtn.classList.toggle("active", isLyricsMode);

  if (isLyricsMode) {
    const curPos = (spotifyPlayerState?.position || 0) / 1000;
    syncLyricsPosition(curPos, true);
  }
}

function resetLyrics() {
  currentLyrics = null;
  currentLyricsActiveIndex = -1;
  currentLyricsTrackKey = "";
  const contentEl = document.getElementById("spotify-lyrics-content");
  if (contentEl) {
    contentEl.innerHTML = `<div class="spotify-lyrics-loading">Đang tải lời bài hát…</div>`;
  }
}

// ---- Spotify Web Playback SDK ----------------------------------------------
function formatSpotifyTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem < 10 ? "0" : ""}${rem}`;
}

let isSpotifyScrubbing = false;

function updateSpotifyPlayPauseUI(isPaused) {
  const playerSpotifyEl = document.getElementById("player-spotify");
  if (playerSpotifyEl) playerSpotifyEl.classList.toggle("is-paused", isPaused);

  // Center play/pause button inside artwork
  const centerBtn = document.getElementById("spotify-center-play-btn");
  if (centerBtn) {
    const cPlay = centerBtn.querySelector(".center-icon-play");
    const cPause = centerBtn.querySelector(".center-icon-pause");
    if (cPlay && cPause) {
      cPlay.classList.toggle("hidden", !isPaused);
      cPause.classList.toggle("hidden", isPaused);
    }
    centerBtn.title = isPaused ? "Phát (Space)" : "Tạm dừng (Space)";
  }

  // Artwork click tooltip
  const artCenter = document.getElementById("spotify-art-center");
  if (artCenter) {
    artCenter.title = isPaused ? "Nhấp để Phát (Space)" : "Nhấp để Tạm dừng (Space)";
  }

  // Bottom bar play/pause button
  const btnPlayPause = document.getElementById("spotify-btn-playpause");
  if (btnPlayPause) {
    const iconPlay = btnPlayPause.querySelector(".icon-play");
    const iconPause = btnPlayPause.querySelector(".icon-pause");
    if (iconPlay && iconPause) {
      iconPlay.classList.toggle("hidden", !isPaused);
      iconPause.classList.toggle("hidden", isPaused);
    }
    btnPlayPause.title = isPaused ? "Phát (Space)" : "Tạm dừng (Space)";
  }
}

function updateSpotifyProgressUI(state) {
  if (!state) return;
  const fillEl = document.getElementById("spotify-progress-fill");
  const thumbEl = document.getElementById("spotify-scrubber-thumb");
  const curEl = document.getElementById("spotify-time-cur");
  const totalEl = document.getElementById("spotify-time-total");

  const pos = (state.position || 0) / 1000;
  const dur = (state.duration || 0) / 1000;
  if (!isSpotifyScrubbing && fillEl && dur > 0) {
    const pct = Math.min(100, Math.max(0, (pos / dur) * 100));
    fillEl.style.width = `${pct.toFixed(1)}%`;
    if (thumbEl) thumbEl.style.left = `${pct.toFixed(1)}%`;
  }
  if (!isSpotifyScrubbing && curEl) curEl.textContent = formatSpotifyTime(pos);
  if (totalEl && dur > 0) totalEl.textContent = formatSpotifyTime(dur);
  if (!isSpotifyScrubbing) syncLyricsPosition(pos);

  const isPaused = Boolean(state.paused);
  updateSpotifyPlayPauseUI(isPaused);

  const sdkThumb = state.track_window?.current_track?.album?.images?.[0]?.url;
  if (sdkThumb) {
    const coverEl = document.getElementById("spotify-cover");
    if (coverEl && (!coverEl.getAttribute("src") || coverEl.getAttribute("src").startsWith("data:") || coverEl.getAttribute("src") === "")) {
      coverEl.src = sdkThumb;
    }
    const glowEl = document.getElementById("spotify-ambient-glow");
    if (glowEl && (!glowEl.style.backgroundImage || glowEl.style.backgroundImage.includes("data:"))) {
      glowEl.style.backgroundImage = `url("${sdkThumb}")`;
    }
  }
}

function broadcastSpotifyTick({ seek = false } = {}) {
  if (activePlayerProvider === "spotify" && spotifyPlayerState) {
    send({
      type: "playbackTick",
      position: Math.max(0, Math.floor(spotifyPlayerState.position || 0)),
      paused: Boolean(spotifyPlayerState.paused),
      seek: Boolean(seek),
      videoId: currentVideoId,
    });
  }
}

window.onSpotifyWebPlaybackSDKReady = function () {
  if (!window.Spotify) return;
  spotifyPlayer = new window.Spotify.Player({
    name: "Office Jukebox Projector",
    getOAuthToken: async (cb) => {
      try {
        const res = await fetch("/api/spotify/token");
        const data = await res.json();
        if (data.ok && data.access_token) {
          cb(data.access_token);
        }
      } catch (err) {
        console.warn("[spotify] Token retrieval error:", err);
      }
    },
    volume: 0.8,
  });

  spotifyPlayer.addListener("ready", ({ device_id }) => {
    spotifyDeviceId = device_id;
    spotifyReady = true;
    console.log("[spotify] Player ready with device ID:", device_id);
    updateSpotifyStatus();
    if (activePlayerProvider === "spotify" && started && latestState?.nowPlaying?.videoId === currentVideoId) {
      playSpotify(currentVideoId);
    }
  });

  spotifyPlayer.addListener("not_ready", ({ device_id }) => {
    console.warn("[spotify] Device ID is offline:", device_id);
    spotifyReady = false;
  });

  spotifyPlayer.addListener("player_state_changed", (state) => {
    spotifyPlayerState = state;
    if (!state) return;
    if (activePlayerProvider === "spotify") {
      updatePlayPauseIcon();
      updateSpotifyProgressUI(state);
      broadcastSpotifyTick({ seek: true });
      clearInterval(spotifyProgressTimer);
      if (!state.paused) {
        clearTimeout(playbackWatchdog);
        hidePlaybackRecovery();
        spotifyWasPlaying = true;
        spotifyProgressTimer = setInterval(() => {
          if (spotifyPlayerState && !spotifyPlayerState.paused && activePlayerProvider === "spotify") {
            spotifyPlayerState.position = (spotifyPlayerState.position || 0) + 1000;
            updateSpotifyProgressUI(spotifyPlayerState);
            broadcastSpotifyTick({ seek: false });
          }
        }, 1000);
      } else if (
        state.paused &&
        state.position === 0 &&
        spotifyWasPlaying &&
        latestState?.nowPlaying?.videoId === currentVideoId &&
        currentPlaybackToken &&
        terminalReportedForToken !== currentPlaybackToken
      ) {
        if (send({
          type: "ended",
          videoId: currentVideoId,
          playbackToken: currentPlaybackToken,
          playedSeconds: state.duration ? state.duration / 1000 : null,
        })) {
          terminalReportedForToken = currentPlaybackToken;
        }
      }
    }
  });

  spotifyPlayer.addListener("initialization_error", ({ message }) => {
    console.error("[spotify] Init error:", message);
  });
  spotifyPlayer.addListener("authentication_error", ({ message }) => {
    console.error("[spotify] Auth error:", message);
    updateSpotifyStatus();
  });
  spotifyPlayer.addListener("account_error", ({ message }) => {
    console.error("[spotify] Account error (Spotify Premium required):", message);
    if (activePlayerProvider === "spotify" && currentPlaybackToken && terminalReportedForToken !== currentPlaybackToken) {
      if (send({ type: "error", videoId: currentVideoId, playbackToken: currentPlaybackToken, code: "spotify_premium_required" })) {
        terminalReportedForToken = currentPlaybackToken;
      }
    }
  });
  spotifyPlayer.addListener("playback_error", ({ message }) => {
    console.error("[spotify] Playback error:", message);
    if (activePlayerProvider === "spotify" && currentPlaybackToken && terminalReportedForToken !== currentPlaybackToken) {
      if (send({ type: "error", videoId: currentVideoId, playbackToken: currentPlaybackToken, code: "playback_error" })) {
        terminalReportedForToken = currentPlaybackToken;
      }
    }
  });

  spotifyPlayer.connect();
};

async function playSpotify(trackId) {
  if (!started) return;
  if (!spotifyDeviceId) {
    console.warn("[spotify] Device ID is not ready yet");
    return;
  }
  try {
    const tokenRes = await fetch("/api/spotify/token");
    const tokenData = await tokenRes.json();
    if (!tokenData.ok || !tokenData.access_token) {
      console.warn("[spotify] No valid token available");
      showPlaybackRecovery();
      return;
    }
    const token = tokenData.access_token;
    spotifyWasPlaying = false;
    const playRes = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${spotifyDeviceId}`, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        uris: [`spotify:track:${trackId}`],
      }),
    });
    if (!playRes.ok && playRes.status !== 204) {
      await fetch("https://api.spotify.com/v1/me/player", {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ device_ids: [spotifyDeviceId], play: true }),
      });
      await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${spotifyDeviceId}`, {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ uris: [`spotify:track:${trackId}`] }),
      });
    }
  } catch (err) {
    console.error("[spotify] Failed to start Spotify playback:", err);
  }
}

// ---- SoundCloud Widget API -------------------------------------------------
function initSoundCloudWidget() {
  const iframe = document.getElementById("sc-widget-iframe");
  if (!iframe || !window.SC || !window.SC.Widget || scWidget) return;
  scWidget = window.SC.Widget(iframe);
  scWidget.bind(window.SC.Widget.Events.READY, () => {
    scReady = true;
  });
  scWidget.bind(window.SC.Widget.Events.PLAY, () => {
    scIsPlaying = true;
    clearTimeout(playbackWatchdog);
    hidePlaybackRecovery();
    updatePlayPauseIcon();
  });
  scWidget.bind(window.SC.Widget.Events.PAUSE, () => {
    scIsPlaying = false;
    updatePlayPauseIcon();
  });
  scWidget.bind(window.SC.Widget.Events.FINISH, () => {
    scIsPlaying = false;
    if (activePlayerProvider === "soundcloud" && currentPlaybackToken && terminalReportedForToken !== currentPlaybackToken) {
      if (send({
        type: "ended",
        videoId: currentVideoId,
        playbackToken: currentPlaybackToken,
        playedSeconds: null,
      })) {
        terminalReportedForToken = currentPlaybackToken;
      }
    }
  });
  scWidget.bind(window.SC.Widget.Events.ERROR, (err) => {
    console.warn("[soundcloud] playback error:", err);
    if (activePlayerProvider === "soundcloud" && currentPlaybackToken && terminalReportedForToken !== currentPlaybackToken) {
      if (send({
        type: "error",
        videoId: currentVideoId,
        playbackToken: currentPlaybackToken,
        code: "soundcloud_error",
      })) {
        terminalReportedForToken = currentPlaybackToken;
      }
    }
  });
}
window.initSoundCloudWidget = initSoundCloudWidget;

function playSoundCloud(url) {
  if (!started) return;
  initSoundCloudWidget();
  scIsPlaying = false;

  const cleanUrl = typeof url === "string" ? url.split("?")[0] : url;

  if (scWidget) {
    scWidget.load(cleanUrl, {
      auto_play: true,
      show_artwork: true,
      visual: true,
      callback: () => {
        if (!started) {
          try { scWidget.pause(); } catch {}
          return;
        }
        try { scWidget.play(); } catch {}
      },
    });
  } else {
    const iframe = document.getElementById("sc-widget-iframe");
    if (iframe) {
      iframe.src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(cleanUrl)}&color=%23ff5500&auto_play=true&show_artwork=true&visual=true`;
    }
  }
}

function getCurrentPlayerTime() {
  if (activePlayerProvider === "youtube" && playerReady && player?.getCurrentTime) {
    const t = Number(player.getCurrentTime());
    return Number.isFinite(t) ? t : null;
  }
  if (activePlayerProvider === "spotify" && spotifyPlayerState?.position) {
    const t = Number(spotifyPlayerState.position) / 1000;
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// Synchronize the player with the song the server reports as current.
function syncPlayer() {
  if (!started) return;
  const np = latestState.nowPlaying;
  const idle = document.getElementById("idle");
  const playerYtEl = document.getElementById("player");
  const playerSpotifyEl = document.getElementById("player-spotify");
  const playerSoundCloudEl = document.getElementById("player-soundcloud");

  if (!np) {
    clearTimeout(playbackWatchdog);
    clearInterval(spotifyProgressTimer);
    if (playbackEventHandlers && player?.removeEventListener) {
      player.removeEventListener("onStateChange", playbackEventHandlers.onStateChange);
      player.removeEventListener("onError", playbackEventHandlers.onError);
    }
    currentVideoId = null;
    currentPlaybackToken = null;
    terminalReportedForToken = null;
    spotifyWasPlaying = false;
    scIsPlaying = false;
    if (player?.stopVideo) player.stopVideo();
    if (spotifyPlayer?.pause) spotifyPlayer.pause();
    if (scWidget?.pause) { try { scWidget.pause(); } catch {} }
    const scIframe = document.getElementById("sc-widget-iframe");
    if (scIframe && scIframe.src && scIframe.src.includes("auto_play=true")) {
      scIframe.src = "https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/293&auto_play=false";
    }
    hidePlaybackRecovery();
    playerYtEl.classList.add("hidden");
    playerSpotifyEl.classList.add("hidden");
    playerSoundCloudEl.classList.add("hidden");
    resetLyrics();
    idle.classList.remove("hidden");
    return;
  }

  idle.classList.add("hidden");
  const provider = (np.provider || "youtube").toLowerCase();
  activePlayerProvider = provider;

  if (np.videoId !== currentVideoId || np.playbackToken !== currentPlaybackToken) {
    if (playbackEventHandlers && player?.removeEventListener) {
      player.removeEventListener("onStateChange", playbackEventHandlers.onStateChange);
      player.removeEventListener("onError", playbackEventHandlers.onError);
    }
    currentVideoId = np.videoId;
    currentPlaybackToken = np.playbackToken || null;
    currentProvider = provider;
    terminalReportedForToken = null;
    spotifyWasPlaying = false;
    scIsPlaying = false;
    const eventVideoId = np.videoId;
    const eventPlaybackToken = np.playbackToken || null;
    let terminalReported = false;

    const sendTerminal = (type, code = null) => {
      if (terminalReported || !eventPlaybackToken) return;
      const payload = {
        type,
        videoId: eventVideoId,
        playbackToken: eventPlaybackToken,
      };
      if (type === "ended") payload.playedSeconds = getCurrentPlayerTime();
      if (type === "error") payload.code = code;
      if (send(payload)) {
        terminalReported = true;
        if (eventPlaybackToken === currentPlaybackToken) terminalReportedForToken = eventPlaybackToken;
      }
    };

    if (provider === "youtube") {
      clearInterval(spotifyProgressTimer);
      playerYtEl.classList.remove("hidden");
      playerSpotifyEl.classList.add("hidden");
      playerSoundCloudEl.classList.add("hidden");
      if (spotifyPlayer?.pause) spotifyPlayer.pause();
      if (scWidget?.pause) { try { scWidget.pause(); } catch {} }
      const scIframe = document.getElementById("sc-widget-iframe");
      if (scIframe && scIframe.src && scIframe.src.includes("auto_play=true")) {
        scIframe.src = "https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/293&auto_play=false";
      }

      if (!playerReady) return;

      playbackEventHandlers = {
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.ENDED) sendTerminal("ended");
        },
        onError: (e) => {
          console.warn("Player error", e.data, "for", eventVideoId);
          sendTerminal("error", e.data);
        },
      };
      if (player.addEventListener) {
        player.addEventListener("onStateChange", playbackEventHandlers.onStateChange);
        player.addEventListener("onError", playbackEventHandlers.onError);
      }
      player.loadVideoById(np.videoId);
      player.playVideo();
      armPlaybackWatchdog(np.videoId, currentPlaybackToken);
    } else if (provider === "spotify") {
      playerYtEl.classList.add("hidden");
      playerSpotifyEl.classList.remove("hidden");
      playerSoundCloudEl.classList.add("hidden");
      if (player?.stopVideo) player.stopVideo();
      if (scWidget?.pause) { try { scWidget.pause(); } catch {} }
      const scIframe = document.getElementById("sc-widget-iframe");
      if (scIframe && scIframe.src && scIframe.src.includes("auto_play=true")) {
        scIframe.src = "https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/293&auto_play=false";
      }

      const coverUrl = safeImageUrl(np.thumbnail);
      const coverEl = document.getElementById("spotify-cover");
      if (coverEl) coverEl.src = coverUrl;
      const vinylCover = document.getElementById("spotify-vinyl-cover");
      if (vinylCover) vinylCover.src = coverUrl;
      const glowEl = document.getElementById("spotify-ambient-glow");
      if (glowEl) {
        glowEl.style.backgroundImage = coverUrl && coverUrl !== NO_THUMB ? `url("${coverUrl}")` : "";
      }
      const titleEl = document.getElementById("spotify-title");
      if (titleEl) titleEl.textContent = np.title || "—";
      const artistEl = document.getElementById("spotify-artist");
      if (artistEl) artistEl.textContent = np.channel || "—";

      const reqPill = document.getElementById("spotify-requester-pill");
      const reqName = document.getElementById("spotify-requester-name");
      if (reqPill && reqName) {
        if (np.addedBy) {
          reqName.textContent = `Yêu cầu: ${np.addedBy}`;
          reqPill.classList.remove("hidden");
        } else {
          reqPill.classList.add("hidden");
        }
      }

      const fillEl = document.getElementById("spotify-progress-fill");
      if (fillEl) fillEl.style.width = "0%";
      const curEl = document.getElementById("spotify-time-cur");
      if (curEl) curEl.textContent = "0:00";
      const totalEl = document.getElementById("spotify-time-total");
      if (totalEl) totalEl.textContent = np.duration || "0:00";

      updateSpotifyPlayPauseUI(false);
      loadLyrics(np.title, np.channel, np.duration);
      playSpotify(np.videoId);
      armPlaybackWatchdog(np.videoId, currentPlaybackToken);
    } else if (provider === "soundcloud") {
      clearInterval(spotifyProgressTimer);
      playerYtEl.classList.add("hidden");
      playerSpotifyEl.classList.add("hidden");
      playerSoundCloudEl.classList.remove("hidden");
      if (player?.stopVideo) player.stopVideo();
      if (spotifyPlayer?.pause) spotifyPlayer.pause();

      playSoundCloud(np.videoId);
      armPlaybackWatchdog(np.videoId, currentPlaybackToken);
    }
  }
}

// Some broken embeds show only a black frame without firing onError. If a newly
// loaded video has not started after 20 seconds (and is not merely paused),
// report an error so the server skips to the next song.
let playbackWatchdog = null;
function showPlaybackRecovery() {
  if (!started || !latestState.nowPlaying) return;
  clearTimeout(playbackWatchdog);
  document.getElementById("playback-recovery").classList.remove("hidden");
}

function hidePlaybackRecovery() {
  document.getElementById("playback-recovery").classList.add("hidden");
}

function armPlaybackWatchdog(videoId, playbackToken) {
  clearTimeout(playbackWatchdog);
  playbackWatchdog = setTimeout(() => {
    if (currentVideoId !== videoId || currentPlaybackToken !== playbackToken) return;
    if (activePlayerProvider === "youtube") {
      if (!playerReady) return;
      const t = player.getCurrentTime ? player.getCurrentTime() : 0;
      const s = player.getPlayerState ? player.getPlayerState() : -1;
      if (t >= 1 || s === YT.PlayerState.PLAYING || s === YT.PlayerState.PAUSED) return;
      if (document.hidden || s === YT.PlayerState.BUFFERING) {
        armPlaybackWatchdog(videoId, playbackToken);
        return;
      }
    } else if (activePlayerProvider === "spotify") {
      if (spotifyWasPlaying || (spotifyPlayerState && !spotifyPlayerState.paused)) return;
      if (document.hidden) {
        armPlaybackWatchdog(videoId, playbackToken);
        return;
      }
    } else if (activePlayerProvider === "soundcloud") {
      if (scIsPlaying) return;
      if (document.hidden) {
        armPlaybackWatchdog(videoId, playbackToken);
        return;
      }
    }
    console.warn(`[watchdog] ${videoId} (${activePlayerProvider}) has not started — skipping`);
    if (
      currentPlaybackToken && terminalReportedForToken !== currentPlaybackToken &&
      send({ type: "error", videoId, playbackToken: currentPlaybackToken, code: "watchdog" })
    ) {
      terminalReportedForToken = currentPlaybackToken;
    }
  }, 20000);
}

// A page restored from the back-forward cache may lose autoplay permission:
// playVideo() fails silently, the player never starts, and the watchdog would
// skip every song. Stop player control and require another Start button click.
window.addEventListener("pageshow", (e) => {
  if (!e.persisted) return;
  clearTimeout(playbackWatchdog);
  if (playbackEventHandlers && player?.removeEventListener) {
    player.removeEventListener("onStateChange", playbackEventHandlers.onStateChange);
    player.removeEventListener("onError", playbackEventHandlers.onError);
  }
  started = false;
  currentVideoId = null;
  currentPlaybackToken = null;
  terminalReportedForToken = null;
  playbackEventHandlers = null;
  spotifyWasPlaying = false;
  scIsPlaying = false;
  hidePlaybackRecovery();
  document.getElementById("start-overlay").classList.remove("hidden");
  document.getElementById("stage").classList.add("hidden");
});

// ---- Rendering -------------------------------------------------------------
function updateMarqueeTitle(el) {
  if (!el) return;
  const text = el.textContent.trim();
  let track = el.querySelector(":scope > .marquee-track");
  if (!track) {
    track = document.createElement("span");
    track.className = "marquee-track";
    el.textContent = "";
    el.appendChild(track);
  }
  track.textContent = text;
  el.classList.add("marquee-title");
  requestAnimationFrame(() => {
    const distance = el.clientWidth - track.scrollWidth;
    const overflowing = distance < -1;
    el.classList.toggle("is-overflowing", overflowing);
    el.style.setProperty("--marquee-distance", `${Math.min(0, distance)}px`);
    if (overflowing) el.title = text;
    else el.removeAttribute("title");
  });
}

window.addEventListener("resize", () => {
  document.querySelectorAll(".marquee-title").forEach(updateMarqueeTitle);
});

function render() {
  const np = latestState.nowPlaying;
  document.getElementById("now-label").classList.toggle("hidden", !np);
  const nowTitle = document.getElementById("now-title");
  nowTitle.textContent = np ? np.title : "—";
  updateMarqueeTitle(nowTitle);
  document.getElementById("now-channel").textContent = np
    ? np.channel + (np.addedBy ? ` · Yêu cầu: ${np.addedBy}` : "")
    : "";

  const queue = latestState.queue || [];
  document.getElementById("queue-count").textContent = queue.length;
  document.getElementById("queue-count").classList.toggle("limit-reached", queueLimitOn && queue.length >= queueLimit);
  const ul = document.getElementById("queue");
  // Server state is authoritative. Cancel a drag if another state update
  // rebuilds the list while the pointer is still down.
  clearQueueDragState();
  ul.innerHTML = "";
  if (queue.length === 0) {
    ul.innerHTML = '<li class="q-empty">Hàng đợi đang trống — quét mã QR để thêm bài hát.</li>';
    return;
  }
  for (const item of queue) {
    const li = document.createElement("li");
    li.className = "q-item";
    li.dataset.id = item.id;
    li.draggable = true;
    const thumb = `<img src="${safeImageUrl(item.thumbnail)}" alt="" />`;

    const isPinned = item.pinned === true;
    const voteScore = item.voteScore || 0;
    const providerBadge = item.provider === "spotify"
      ? '<span class="q-platform-badge spotify" title="Spotify Direct Playback">Spotify</span>'
      : item.provider === "soundcloud"
        ? '<span class="q-platform-badge soundcloud" title="SoundCloud">SoundCloud</span>'
        : '';

    li.innerHTML = `
      <span class="q-drag-handle" title="Kéo để sắp xếp" aria-hidden="true">⠿</span>
      ${thumb}
      <div class="q-meta">
        <div class="q-title-row">
          <div class="q-title"></div>
          ${providerBadge}
          ${isPinned ? '<span class="q-pinned-badge" title="Bài do host ghim vị trí">📌 Ghim</span>' : ''}
          ${voteScore > 0 ? `<span class="q-vote-badge" title="${voteScore} lượt vote">❤️ ${voteScore}</span>` : ''}
        </div>
        <div class="q-sub">
          <span class="q-requester-avatar"></span>
          <span class="q-sub-label"></span>
        </div>
      </div>
      ${isPinned ? '<button class="q-unpin" title="Bỏ ghim">✕ Ghim</button>' : ''}
      <button class="q-remove" title="Xóa">✕</button>`;
    li.querySelector(".q-title").textContent = item.title;
    updateMarqueeTitle(li.querySelector(".q-title"));
    li.querySelector(".q-sub-label").textContent = item.addedBy ? `Yêu cầu: ${item.addedBy}` : item.channel;
    window.JukeboxAvatars?.apply(li.querySelector(".q-requester-avatar"), {
      avatarUrl: item.avatarUrl,
      name: item.addedBy,
      fallback: false,
    });
    if (item.rank?.badge) {
      const rank = document.createElement("span");
      rank.className = "q-rank-badge";
      rank.textContent = `${item.rank.badge} ${item.rank.name || ""}`.trim();
      rank.title = item.rank.name || "Hạng hoạt động";
      li.querySelector(".q-sub").append(" ", rank);
    }

    if (isPinned) {
      li.querySelector(".q-unpin").onclick = () => send({ type: "unpin", id: item.id });
    }
    li.querySelector(".q-remove").onclick = () => send({ type: "remove", id: item.id });
    ul.appendChild(li);
  }
}

const SHIELD_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.6-3 7.6-7 9-4-1.4-7-4.4-7-9V6l7-3z"/><path d="M9 12l2 2 4-4.5"/></svg>';
const CLOCK_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12.5" r="8"/><path d="M12 8.5v4.5l3 2"/><path d="M9.5 2.5h5"/></svg>';

function renderFilter() {
  const btn = document.getElementById("filter-toggle");
  const strict = filterOn && moderationMode === "strict";
  const label = !filterOn ? "Tắt" : strict ? "Nghiêm ngặt" : "Bật";
  btn.innerHTML = `${SHIELD_SVG}<span>Bộ lọc: ${label}</span>`;
  btn.classList.toggle("on", filterOn && !strict);
  btn.classList.toggle("strict", strict);
  // Warn when the filter is enabled without an LLM key (it approves everything).
  document.getElementById("filter-hint").classList.toggle("hidden", !(filterOn && !moderationConfigured));
}

function renderCooldown() {
  const btn = document.getElementById("cooldown-toggle");
  btn.innerHTML = `${CLOCK_SVG}<span>Thời gian chờ: ${cooldownSeconds ? cooldownSeconds + " giây" : "Tắt"}</span>`;
  btn.classList.toggle("on", cooldownSeconds > 0);
}

function renderQueueLimit() {
  const btn = document.getElementById("queue-limit-toggle");
  btn.innerHTML = `<span>Hàng đợi: ${queueLimitOn ? queueLimit : "Tắt"}</span>`;
  btn.classList.toggle("on", queueLimitOn);
}

function renderRequireName() {
  const btn = document.getElementById("require-name-toggle");
  btn.innerHTML = `<span>Tên order: ${requireName ? "Bắt buộc" : "Tắt"}</span>`;
  btn.classList.toggle("on", requireName);
}

function renderContext() {
  const input = document.getElementById("context-input");
  // Do not overwrite host input with state updates from the server.
  if (document.activeElement !== input) input.value = eventContext;
}

function renderVoteSort() {
  const btn = document.getElementById("vote-sort-toggle");
  if (!btn) return;
  btn.innerHTML = `<span>Xếp theo vote: ${voteSortOn ? "Bật" : "Tắt"}</span>`;
  btn.classList.toggle("on", voteSortOn);
}

const PAUSE_SVG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4.5" height="14" rx="1.5"/><rect x="13.5" y="5" width="4.5" height="14" rx="1.5"/></svg>';
const PLAY_SVG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

function updatePlayPauseIcon() {
  let playing = false;
  if (activePlayerProvider === "youtube") {
    if (playerReady && player?.getPlayerState) {
      playing = player.getPlayerState() === YT.PlayerState.PLAYING;
    }
  } else if (activePlayerProvider === "spotify") {
    playing = Boolean(spotifyPlayerState && !spotifyPlayerState.paused);
    updateSpotifyPlayPauseUI(!playing);
  } else if (activePlayerProvider === "soundcloud") {
    playing = scIsPlaying;
  }
  document.getElementById("playpause").innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
}

// ---- Controls --------------------------------------------------------------
async function updateSpotifyStatus() {
  const btn = document.getElementById("spotify-connect-btn");
  if (!btn) return;
  try {
    const res = await fetch("/api/spotify/status");
    const data = await res.json();
    spotifyStatus = data;
    if (data.connected) {
      btn.textContent = "🟢 Spotify: Đã kết nối";
      btn.classList.add("connected");
      btn.title = "Tài khoản Spotify Premium đã kết nối. Nhấp để ngắt kết nối.";
    } else {
      btn.textContent = "⚪ Kết nối Spotify";
      btn.classList.remove("connected");
      btn.title = "Nhấp để liên kết tài khoản Spotify Premium cho Host phát nhạc.";
    }
  } catch {
    btn.textContent = "⚪ Kết nối Spotify";
    btn.classList.remove("connected");
  }
}

function wireSpotifyConnect() {
  const btn = document.getElementById("spotify-connect-btn");
  if (!btn) return;
  btn.onclick = async () => {
    if (spotifyStatus.connected) {
      if (confirm("Host đang kết nối Spotify Premium. Bạn có muốn ngắt kết nối không?")) {
        try {
          await fetch("/api/spotify/disconnect", { method: "POST" });
          await updateSpotifyStatus();
        } catch (e) {
          console.error("Disconnect error", e);
        }
      }
    } else {
      const popup = window.open("/api/spotify/login", "spotify_login", "width=600,height=720");
      const pollTimer = setInterval(() => {
        if (!popup || popup.closed) {
          clearInterval(pollTimer);
          updateSpotifyStatus();
        }
      }, 1000);
    }
  };

  window.addEventListener("message", (e) => {
    if (e.data && (e.data.type === "spotify_connected" || e.data.type === "spotify_error")) {
      updateSpotifyStatus();
    }
  });
  window.addEventListener("focus", () => {
    updateSpotifyStatus();
  });
}

function wireControls() {
  document.getElementById("resume-playback").onclick = () => {
    const np = latestState.nowPlaying;
    if (!np) return;
    hidePlaybackRecovery();
    currentVideoId = np.videoId;
    if (activePlayerProvider === "youtube" && playerReady) {
      player.loadVideoById(np.videoId);
      player.playVideo();
    } else if (activePlayerProvider === "spotify") {
      playSpotify(np.videoId);
    } else if (activePlayerProvider === "soundcloud") {
      playSoundCloud(np.videoId);
    }
    armPlaybackWatchdog(np.videoId, currentPlaybackToken);
  };
  document.getElementById("playpause").onclick = () => {
    if (activePlayerProvider === "youtube") {
      if (!playerReady) return;
      const s = player.getPlayerState();
      if (s === YT.PlayerState.PLAYING) player.pauseVideo();
      else player.playVideo();
    } else if (activePlayerProvider === "spotify") {
      if (spotifyPlayer?.togglePlay) spotifyPlayer.togglePlay();
    } else if (activePlayerProvider === "soundcloud") {
      if (scWidget?.toggle) scWidget.toggle();
    }
  };
  document.getElementById("skip").onclick = () => {
    const playedSeconds = getCurrentPlayerTime();
    send({ type: "skip", playedSeconds: Number.isFinite(playedSeconds) ? playedSeconds : null });
  };
  wireSpotifyConnect();
  wireSpotifyInteractiveControls();
  // Cycle the filter: off → on (normal) → strict (family-safe only) → off.
  document.getElementById("filter-toggle").onclick = () => {
    if (!filterOn) send({ type: "setFilter", on: true, mode: "default" });
    else if (moderationMode !== "strict") send({ type: "setFilter", on: true, mode: "strict" });
    else send({ type: "setFilter", on: false, mode: "default" });
  };
  // Cycle through available cooldown values; the server returns the value in state.
  const COOLDOWN_STEPS = [0, 5, 10, 15, 30, 60];
  document.getElementById("cooldown-toggle").onclick = () => {
    const i = COOLDOWN_STEPS.indexOf(cooldownSeconds);
    send({ type: "setCooldown", seconds: COOLDOWN_STEPS[(i + 1) % COOLDOWN_STEPS.length] });
  };
  const QUEUE_LIMIT_STEPS = [5, 10, 15, 20];
  document.getElementById("queue-limit-toggle").onclick = () => {
    if (!queueLimitOn) {
      send({ type: "setQueueLimit", on: true, limit: QUEUE_LIMIT_STEPS[0] });
      return;
    }
    const i = QUEUE_LIMIT_STEPS.indexOf(queueLimit);
    if (i === QUEUE_LIMIT_STEPS.length - 1) send({ type: "setQueueLimit", on: false, limit: queueLimit });
    else send({ type: "setQueueLimit", on: true, limit: QUEUE_LIMIT_STEPS[Math.max(0, i + 1)] });
  };
  document.getElementById("require-name-toggle").onclick = () => {
    send({ type: "setRequireName", on: !requireName });
  };
  document.getElementById("order-network-host").onclick = () => {
    registerOrderNetworkHost({ manual: true });
  };
  document.getElementById("vote-sort-toggle").onclick = () => {
    send({ type: "setVoteSort", on: !voteSortOn });
  };
  // Event-context editor: the context control reveals the input and Save sends its contents.
  const ctxRow = document.getElementById("context-row");
  const ctxInput = document.getElementById("context-input");
  document.getElementById("context-toggle").onclick = () => {
    ctxRow.classList.toggle("hidden");
    if (!ctxRow.classList.contains("hidden")) ctxInput.focus();
  };
  document.getElementById("context-save").onclick = () => {
    send({ type: "setEventContext", context: ctxInput.value.trim() });
    ctxRow.classList.add("hidden");
  };
  ctxInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("context-save").click();
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return; // typing in the context input
    if (e.code === "Space") { e.preventDefault(); document.getElementById("playpause").click(); }
    if (e.key.toLowerCase() === "n") document.getElementById("skip").click();
    if (e.key === "ArrowLeft" || e.key.toLowerCase() === "j") {
      e.preventDefault();
      seekPlayerRelative(-10);
    }
    if (e.key === "ArrowRight" || e.key.toLowerCase() === "l") {
      e.preventDefault();
      seekPlayerRelative(10);
    }
    if (e.key.toLowerCase() === "f") {
      e.preventDefault();
      toggleWrapFullscreen();
    }
    if (e.key === "Escape" && isLyricsMode) {
      e.preventDefault();
      toggleLyricsMode(false);
    }
  });

  wireSpotifyInteractiveControls();
}

function seekSpotifyTo(targetSec) {
  if (!spotifyPlayer) return;
  const durSec = spotifyPlayerState?.duration ? spotifyPlayerState.duration / 1000 : 9999;
  const newPos = Math.max(0, Math.min(durSec, targetSec));
  const ms = Math.floor(newPos * 1000);
  if (spotifyPlayer.seek) {
    spotifyPlayer.seek(ms);
  }
  if (spotifyPlayerState) {
    spotifyPlayerState.position = ms;
    updateSpotifyProgressUI(spotifyPlayerState);
    broadcastSpotifyTick({ seek: true });
  }
}

function seekSpotifyRelative(deltaSec) {
  if (!spotifyPlayer || !spotifyPlayerState?.duration) return;
  const curPos = (spotifyPlayerState.position || 0) / 1000;
  const durSec = spotifyPlayerState.duration / 1000;
  const newPos = Math.max(0, Math.min(durSec - 1, curPos + deltaSec));
  const ms = Math.floor(newPos * 1000);
  spotifyPlayer.seek(ms);
  if (spotifyPlayerState) {
    spotifyPlayerState.position = ms;
    updateSpotifyProgressUI(spotifyPlayerState);
    broadcastSpotifyTick({ seek: true });
  }
}

function seekSoundCloudRelative(deltaSec) {
  if (!scWidget) return;
  try {
    scWidget.getPosition((posMs) => {
      scWidget.getDuration((durMs) => {
        const dur = durMs || 0;
        const newPos = Math.max(0, Math.min(dur, (posMs || 0) + deltaSec * 1000));
        scWidget.seekTo(newPos);
      });
    });
  } catch {}
}

function seekPlayerRelative(deltaSec) {
  if (activePlayerProvider === "spotify") {
    seekSpotifyRelative(deltaSec);
  } else if (activePlayerProvider === "soundcloud") {
    seekSoundCloudRelative(deltaSec);
  } else if (activePlayerProvider === "youtube" && playerReady && player?.getCurrentTime) {
    try {
      const cur = player.getCurrentTime() || 0;
      const dur = player.getDuration() || 0;
      const target = Math.max(0, Math.min(dur, cur + deltaSec));
      player.seekTo(target, true);
    } catch {}
  }
}

function toggleWrapFullscreen() {
  const wrap = document.getElementById("player-wrap");
  if (!wrap) return;
  if (!document.fullscreenElement) {
    wrap.requestFullscreen?.().catch(console.warn);
  } else {
    document.exitFullscreen?.().catch(console.warn);
  }
}

function updateFullscreenIcons() {
  const isFs = Boolean(document.fullscreenElement);
  document.querySelectorAll(".icon-fullscreen").forEach((el) => el.classList.toggle("hidden", isFs));
  document.querySelectorAll(".icon-exit-fullscreen").forEach((el) => el.classList.toggle("hidden", !isFs));
}

document.addEventListener("fullscreenchange", updateFullscreenIcons);

function wireSpotifyInteractiveControls() {
  const scrubberWrap = document.getElementById("spotify-scrubber-wrap");
  const scrubberTooltip = document.getElementById("spotify-scrubber-tooltip");
  const scrubberThumb = document.getElementById("spotify-scrubber-thumb");
  const fillEl = document.getElementById("spotify-progress-fill");
  const curEl = document.getElementById("spotify-time-cur");
  const playerSpotifyEl = document.getElementById("player-spotify");

  function getScrubTimeFromEvent(e) {
    if (!scrubberWrap || !spotifyPlayerState?.duration) return 0;
    const rect = scrubberWrap.getBoundingClientRect();
    const clickX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const ratio = rect.width > 0 ? clickX / rect.width : 0;
    return (spotifyPlayerState.duration / 1000) * ratio;
  }

  if (scrubberWrap) {
    scrubberWrap.addEventListener("mousemove", (e) => {
      const durSec = (spotifyPlayerState?.duration || 0) / 1000;
      if (durSec <= 0) return;
      const rect = scrubberWrap.getBoundingClientRect();
      const offsetX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const ratio = rect.width > 0 ? offsetX / rect.width : 0;
      const targetSec = durSec * ratio;

      if (scrubberTooltip) {
        scrubberTooltip.textContent = formatSpotifyTime(targetSec);
        scrubberTooltip.style.left = `${offsetX}px`;
        scrubberTooltip.classList.add("visible");
      }

      if (isSpotifyScrubbing) {
        const pct = (ratio * 100).toFixed(1);
        if (fillEl) fillEl.style.width = `${pct}%`;
        if (scrubberThumb) scrubberThumb.style.left = `${pct}%`;
        if (curEl) curEl.textContent = formatSpotifyTime(targetSec);
        syncLyricsPosition(targetSec);
      }
    });

    scrubberWrap.addEventListener("mouseleave", () => {
      if (scrubberTooltip) scrubberTooltip.classList.remove("visible");
    });

    scrubberWrap.addEventListener("mousedown", (e) => {
      isSpotifyScrubbing = true;
      scrubberWrap.classList.add("is-dragging");
      const targetSec = getScrubTimeFromEvent(e);
      const durSec = (spotifyPlayerState?.duration || 0) / 1000;
      if (durSec > 0) {
        const pct = Math.min(100, Math.max(0, (targetSec / durSec) * 100));
        if (fillEl) fillEl.style.width = `${pct}%`;
        if (scrubberThumb) scrubberThumb.style.left = `${pct}%`;
        if (curEl) curEl.textContent = formatSpotifyTime(targetSec);
      }
    });

    window.addEventListener("mouseup", (e) => {
      if (!isSpotifyScrubbing) return;
      isSpotifyScrubbing = false;
      scrubberWrap.classList.remove("is-dragging");
      const targetSec = getScrubTimeFromEvent(e);
      seekSpotifyTo(targetSec);
      syncLyricsPosition(targetSec, true);
    });
  }

  // Play/Pause button on player
  const btnPlayPause = document.getElementById("spotify-btn-playpause");
  if (btnPlayPause) {
    btnPlayPause.onclick = (e) => {
      e.stopPropagation();
      if (spotifyPlayer?.togglePlay) {
        spotifyPlayer.togglePlay();
        if (spotifyPlayerState) {
          spotifyPlayerState.paused = !spotifyPlayerState.paused;
          updateSpotifyPlayPauseUI(spotifyPlayerState.paused);
          broadcastSpotifyTick({ seek: true });
        }
      }
    };
  }

  // Clicking artwork or center play button toggles play/pause
  const artCenter = document.getElementById("spotify-art-center");
  if (artCenter) {
    artCenter.onclick = () => {
      if (spotifyPlayer?.togglePlay) {
        spotifyPlayer.togglePlay();
        if (spotifyPlayerState) {
          spotifyPlayerState.paused = !spotifyPlayerState.paused;
          updateSpotifyPlayPauseUI(spotifyPlayerState.paused);
          broadcastSpotifyTick({ seek: true });
        }
      }
    };
  }

  // Tua lùi 10s & tua tới 10s
  const btnRewind = document.getElementById("spotify-btn-rewind");
  if (btnRewind) {
    btnRewind.onclick = (e) => {
      e.stopPropagation();
      seekSpotifyRelative(-10);
    };
  }
  const btnForward = document.getElementById("spotify-btn-forward");
  if (btnForward) {
    btnForward.onclick = (e) => {
      e.stopPropagation();
      seekSpotifyRelative(10);
    };
  }

  // Volume slider & mute toggle
  const volSlider = document.getElementById("spotify-vol-slider");
  let lastVolume = 0.8;
  if (volSlider) {
    volSlider.addEventListener("input", (e) => {
      const vol = parseFloat(e.target.value);
      lastVolume = vol;
      if (spotifyPlayer?.setVolume) spotifyPlayer.setVolume(vol);
      updateVolumeIcons(vol);
    });
  }

  const btnVol = document.getElementById("spotify-btn-vol");
  if (btnVol) {
    btnVol.onclick = (e) => {
      e.stopPropagation();
      if (!volSlider) return;
      if (parseFloat(volSlider.value) > 0) {
        lastVolume = parseFloat(volSlider.value) || 0.8;
        volSlider.value = 0;
        if (spotifyPlayer?.setVolume) spotifyPlayer.setVolume(0);
        updateVolumeIcons(0);
      } else {
        const restore = lastVolume || 0.8;
        volSlider.value = restore;
        if (spotifyPlayer?.setVolume) spotifyPlayer.setVolume(restore);
        updateVolumeIcons(restore);
      }
    };
  }

  function updateVolumeIcons(vol) {
    if (!btnVol) return;
    const isMute = vol <= 0;
    const iconHigh = btnVol.querySelector(".icon-vol-high");
    const iconMute = btnVol.querySelector(".icon-vol-mute");
    if (iconHigh && iconMute) {
      iconHigh.classList.toggle("hidden", isMute);
      iconMute.classList.toggle("hidden", !isMute);
    }
  }

  // Fullscreen buttons
  const fsBtn = document.getElementById("player-fullscreen-btn");
  if (fsBtn) {
    fsBtn.onclick = (e) => {
      e.stopPropagation();
      toggleWrapFullscreen();
    };
  }
  const scFsBtn = document.getElementById("sc-fullscreen-btn");
  if (scFsBtn) {
    scFsBtn.onclick = (e) => {
      e.stopPropagation();
      toggleWrapFullscreen();
    };
  }

  // Auto-hide controls when idle
  let spotifyControlsTimeout = null;
  function showSpotifyControls() {
    if (!playerSpotifyEl) return;
    playerSpotifyEl.classList.remove("controls-idle");
    clearTimeout(spotifyControlsTimeout);
    spotifyControlsTimeout = setTimeout(() => {
      if (spotifyPlayerState && !spotifyPlayerState.paused && !isSpotifyScrubbing) {
        playerSpotifyEl.classList.add("controls-idle");
      }
    }, 2500);
  }

  if (playerSpotifyEl) {
    playerSpotifyEl.addEventListener("mousemove", showSpotifyControls);
    playerSpotifyEl.addEventListener("click", showSpotifyControls);
    playerSpotifyEl.addEventListener("mouseleave", () => {
      if (spotifyPlayerState && !spotifyPlayerState.paused && !isSpotifyScrubbing) {
        playerSpotifyEl.classList.add("controls-idle");
      }
    });
  }

  // Lyrics overlay toggles
  const btnLyrics = document.getElementById("spotify-btn-lyrics");
  if (btnLyrics) {
    btnLyrics.onclick = (e) => {
      e.stopPropagation();
      toggleLyricsMode();
    };
  }

  const btnLyricsClose = document.getElementById("spotify-lyrics-close");
  if (btnLyricsClose) {
    btnLyricsClose.onclick = (e) => {
      e.stopPropagation();
      toggleLyricsMode(false);
    };
  }
}

// ---- Initialization --------------------------------------------------------
async function loadInfo() {
  try {
    const info = await (await fetch("/api/info")).json();
    document.getElementById("qr").src = info.qr;
    document.getElementById("guest-url").textContent = info.guestUrl.replace(/^https?:\/\//, "");
    filterOn = !!info.filterOn;
    if (typeof info.moderationMode === "string") moderationMode = info.moderationMode;
    moderationConfigured = !!info.moderationConfigured;
    queueLimitOn = !!info.queueLimitOn;
    if (typeof info.queueLimit === "number") queueLimit = info.queueLimit;
    requireName = !!info.requireName;
    renderFilter();
    renderQueueLimit();
    renderRequireName();
    updateSpotifyStatus();
  } catch (err) {
    document.getElementById("guest-url").textContent = "Không thể tải liên kết dành cho khách";
  }
  try {
    // The browser reuses this page's Basic Auth credentials for the request.
    const hostAuth = await (await fetch("/api/host-token")).json();
    hostToken = typeof hostAuth.token === "string" ? hostAuth.token : null;
    sendAuth(); // the WebSocket may have connected before the token arrived
    registerOrderNetworkHost();
    startOrderNetworkHostRefresh();
  } catch {
    /* no password or offline — controls remain available or inactive */
  }
}

document.getElementById("start-btn").onclick = () => {
  started = true;
  if (hostCoordinationChannel) {
    hostCoordinationChannel.postMessage({ type: "host_claimed_playback", tabId: myTabId });
  }
  document.getElementById("start-overlay").classList.add("hidden");
  document.getElementById("stage").classList.remove("hidden");
  registerOrderNetworkHost();
  startOrderNetworkHostRefresh();
  syncPlayer();
};

loadInfo();
wireControls();
wireQueueDrag();
connectWs();
initSoundCloudWidget();
