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
        if (tiktokAudio) { try { tiktokAudio.pause(); } catch {} }
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
let spotifyCurrentlyPlayingTrackId = null;
let spotifyProgressTimer = null;
let spotifyAnchorPos = 0; // ms
let spotifyAnchorTime = 0; // performance.now()
let spotifyMaxPositionMs = 0; // ms high-water mark reached
let spotifyRafId = null;
let spotifyReAnchorTimer = null;
let spotifyTickBroadcastTimer = null;
let isSeekPending = false;
let seekTargetMs = 0;
let lastBroadcastTickTime = 0;
let spotifyStatus = { connected: false, configured: false };
let isSpotifyLoadingTrack = false;
let isSpotifyAutoplayBlocked = false;
let spotifyAutoPlayTimer = null;
let silentAudioEl = null;
let unattendedModeEnabled = false;
let screenWakeLock = null;
let isWakeLockRequested = false;
let backgroundWorker = null;
let hostWebLockHeld = false;
let lastUnattendedTrackId = null;
let lastUnattendedPosition = -1;
let lastUnattendedProgressTimestamp = Date.now();
let unattendedStallRecoveryCount = 0;
let scWidget = null;
let scReady = false;
let scIsPlaying = false;
let scCurrentPosition = 0;
let scDurationSec = 0;
let tiktokAudio = null;
let tiktokIsPlaying = false;
let tiktokResumeTime = 0;
let tiktokRetryCount = 0;
let tiktokRetryTimer = null;
let lastTikTokTickTime = 0;
let filterOn = false;
let moderationMode = "default"; // "default" | "strict" (protocol values)
let moderationConfigured = false;
let cooldownSeconds = 15;
let eventContext = "";
let queueLimitOn = false;
let queueLimit = 10;
let userQueueLimitOn = false;
let userQueueLimit = 5;
const USER_QUEUE_LIMIT_STEPS = [5, 10, 15];
let hostActiveTab = "queue";
let hostHistoryItems = [];
let hostHistoryLoading = false;
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

function setOrderNetworkHostStatus(message, type = "info") {
  const status = document.getElementById("order-network-host-status");
  if (!status) return;
  clearTimeout(orderNetworkHostStatusTimer);
  if (!message) {
    status.textContent = "";
    status.classList.remove("loading", "ok", "bad", "info");
    status.classList.add("hidden");
    return;
  }
  status.textContent = message;
  status.classList.remove("hidden", "loading", "ok", "bad", "info");
  status.classList.add(type);
  const timeoutMs = type === "loading" ? 12000 : 4000;
  orderNetworkHostStatusTimer = setTimeout(() => {
    status.classList.add("hidden");
    status.classList.remove("loading", "ok", "bad", "info");
  }, timeoutMs);
}

function registerOrderNetworkHost({ manual = false } = {}) {
  // Only the projector that has started playback can refresh automatically.
  if (!manual && (hostToken === null || !started)) return false;
  if (manual) sendAuth();
  if (!send({ type: "registerOrderNetworkHost" })) {
    if (manual) setOrderNetworkHostStatus("Mất kết nối Host. Vui lòng thử lại.", "bad");
    return false;
  }
  orderNetworkHostUpdateIsManual = manual;
  if (manual) setOrderNetworkHostStatus("Đang cập nhật IP mạng Host...", "loading");
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
    if (activePlayerProvider === "youtube" && playerReady && player?.getPlayerState) {
      const s = player.getPlayerState();
      const dur = Number(player.getDuration ? player.getDuration() : 0) || 0;
      const cur = Number(player.getCurrentTime ? player.getCurrentTime() : 0) || 0;
      const ytEndedState = typeof YT !== "undefined" && YT?.PlayerState ? YT.PlayerState.ENDED : 0;
      const ytPausedState = typeof YT !== "undefined" && YT?.PlayerState ? YT.PlayerState.PAUSED : 2;
      const ytBufferingState = typeof YT !== "undefined" && YT?.PlayerState ? YT.PlayerState.BUFFERING : 3;
      if (s === ytEndedState) {
        ended = true;
        playedSeconds = cur;
      } else if (dur > 0 && cur >= Math.max(1, dur - 0.5) && (s === ytPausedState || s === -1 || s === ytBufferingState)) {
        ended = true;
        playedSeconds = dur;
      }
    } else if (activePlayerProvider === "spotify" && spotifyPlayerState) {
      const dur = spotifyPlayerState.duration || 0;
      const reachedNearEnd = Boolean(
        dur > 0 && (
          spotifyMaxPositionMs >= Math.max(1000, dur - 5000) ||
          spotifyMaxPositionMs >= dur * 0.95
        )
      );
      if (
        spotifyWasPlaying &&
        spotifyPlayerState.paused &&
        spotifyPlayerState.position === 0 &&
        reachedNearEnd
      ) {
        ended = true;
        playedSeconds = dur ? dur / 1000 : null;
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
      if (orderNetworkHostUpdateIsManual) {
        setOrderNetworkHostStatus("Đã cập nhật IP mạng Host thành công!", "ok");
      }
      orderNetworkHostUpdateIsManual = false;
      return;
    }
    if (msg.type === "orderNetworkHostError") {
      if (orderNetworkHostUpdateIsManual) {
        setOrderNetworkHostStatus(msg.reason || "Không thể cập nhật IP mạng Host.", "bad");
      } else {
        console.warn("[host] Lỗi cập nhật IP mạng Host tự động:", msg.reason);
      }
      orderNetworkHostUpdateIsManual = false;
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
      if (typeof msg.userQueueLimitOn === "boolean") userQueueLimitOn = msg.userQueueLimitOn;
      if (typeof msg.userQueueLimit === "number") userQueueLimit = msg.userQueueLimit;
      if (typeof msg.requireName === "boolean") requireName = msg.requireName;
      if (typeof msg.voteSortOn === "boolean") voteSortOn = msg.voteSortOn;
      render();
      renderFilter();
      renderCooldown();
      renderContext();
      renderQueueLimit();
      renderUserQueueLimit();
      renderRequireName();
      renderVoteSort();
      if (hostActiveTab === "history") loadHostHistory();
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
        try {
          const iframe = player.getIframe?.();
          if (iframe) {
            iframe.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture");
          }
        } catch {}
        currentVideoId = null;
        currentPlaybackToken = null;
        syncPlayer();
      },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.PLAYING) {
          clearTimeout(playbackWatchdog);
          hidePlaybackRecovery();
          startYouTubeSync();
        } else if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.BUFFERING) {
          stopYouTubeSync();
          broadcastYouTubeTick({ seek: false, forcedPaused: true });
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

async function loadLyrics(rawTitle, rawArtist, duration, artists = [], platform = "", videoId = "") {
  const lyricsClient = window.JukeboxLyrics;
  const cleaned = lyricsClient
    ? lyricsClient.cleanLyricsQuery(rawTitle, rawArtist)
    : { title: (rawTitle || "").trim(), artist: (rawArtist || "").trim() };
  const isYt = platform === "youtube" || platform === "yt";
  const trackKey = isYt && videoId ? `yt:${videoId}` : `${cleaned.artist.toLowerCase()}:::${cleaned.title.toLowerCase()}`;
  if (trackKey === currentLyricsTrackKey && currentLyrics) {
    return;
  }
  currentLyricsTrackKey = trackKey;
  currentLyrics = null;
  currentLyricsActiveIndex = -1;

  const contentEl = document.getElementById("spotify-lyrics-content");
  const scrollerEl = document.getElementById("spotify-lyrics-scroller");
  const sourceTagEl = document.getElementById("spotify-lyrics-source-tag");
  if (sourceTagEl) sourceTagEl.style.display = "none";
  if (contentEl) {
    contentEl.classList.add("is-loading");
    contentEl.classList.remove("is-empty");
    contentEl.innerHTML = `<div class="spotify-lyrics-loading">Đang tải lời bài hát đồng bộ…</div>`;
  }
  if (scrollerEl) {
    scrollerEl.classList.add("is-loading");
    scrollerEl.classList.remove("is-empty");
  }

  let durSec = null;
  if (typeof duration === "string" && duration.includes(":")) {
    const p = duration.split(":").map(Number);
    if (p.length === 2) durSec = p[0] * 60 + p[1];
  } else if (typeof duration === "number") {
    durSec = duration;
  }

  const data = lyricsClient
    ? await lyricsClient.fetchLyricsClient({
        title: rawTitle,
        artist: rawArtist,
        artists: Array.isArray(artists) ? artists : [],
        durationSec: durSec,
        platform,
        videoId,
      }).catch((err) => {
        console.warn("fetchLyricsClient error:", err);
        return null;
      })
    : null;

  if (trackKey !== currentLyricsTrackKey) return;

  if (!data || !data.lines || data.lines.length === 0) {
    currentLyrics = null;
    if (contentEl) {
      contentEl.classList.remove("is-loading");
      contentEl.classList.add("is-empty");
      const emptyMsg = isYt
        ? "Video này chưa có lời bài hát chính chủ (phụ đề do kênh đăng tải)."
        : "Chưa có lời bài hát đồng bộ cho bài hát này.";
      contentEl.innerHTML = `<div class="spotify-lyrics-empty"><span>🎵</span><span>${emptyMsg}</span></div>`;
    }
    if (scrollerEl) {
      scrollerEl.classList.remove("is-loading");
      scrollerEl.classList.add("is-empty");
    }
    return;
  }

  currentLyrics = data;
  if (sourceTagEl) {
    if (data.source === "youtube_captions") {
      sourceTagEl.textContent = `Phụ đề chính chủ · ${(data.language || "VI").toUpperCase()}`;
      sourceTagEl.style.display = "inline-block";
    } else {
      sourceTagEl.style.display = "none";
    }
  }
  renderLyricsLines(data.lines);
}

function renderLyricsLines(lines) {
  const contentEl = document.getElementById("spotify-lyrics-content");
  const scrollerEl = document.getElementById("spotify-lyrics-scroller");
  if (!contentEl) return;
  contentEl.classList.remove("is-loading", "is-empty");
  if (scrollerEl) {
    scrollerEl.classList.remove("is-loading", "is-empty");
  }
  contentEl.innerHTML = "";

  const frag = document.createDocumentFragment();
  lines.forEach((line, idx) => {
    const lineEl = document.createElement("div");
    lineEl.className = "spotify-lyric-line";
    lineEl.dataset.index = idx;
    lineEl.dataset.time = line.time;
    lineEl.textContent = line.text;
    lineEl.addEventListener("click", (e) => {
      e.stopPropagation();
      seekSpotifyTo(line.time);
      syncLyricsPosition(line.time, true);
    });
    frag.appendChild(lineEl);
  });
  contentEl.appendChild(frag);

  if (scrollerEl) {
    scrollerEl.scrollTop = 0;
    scrollerEl.scrollTo({ top: 0, behavior: "auto" });
  }

  // Sync with current player position immediately
  const curPos = (spotifyPlayerState?.position || 0) / 1000;
  syncLyricsPosition(curPos, true);
}

function syncLyricsPosition(curSec, forceScroll = false) {
  if (!isLyricsMode && !forceScroll) return;
  if (!currentLyrics || !Array.isArray(currentLyrics.lines) || currentLyrics.lines.length === 0) return;
  const lines = currentLyrics.lines;

  // Find index of current active line: largest index where line.time <= curSec
  let activeIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= curSec) {
      activeIdx = i;
    } else {
      break;
    }
  }

  if (activeIdx === currentLyricsActiveIndex && !forceScroll) return;
  const prevIdx = currentLyricsActiveIndex;
  currentLyricsActiveIndex = activeIdx;

  const contentEl = document.getElementById("spotify-lyrics-content");
  if (!contentEl) return;
  const lineEls = contentEl.children;

  if (forceScroll || Math.abs(activeIdx - prevIdx) > 1) {
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
  } else {
    if (prevIdx >= 0 && lineEls[prevIdx]) {
      lineEls[prevIdx].classList.remove("active");
      lineEls[prevIdx].classList.add("passed");
    }
    if (activeIdx >= 0 && lineEls[activeIdx]) {
      lineEls[activeIdx].classList.add("active");
      lineEls[activeIdx].classList.remove("passed");
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
    const curPos = getInterpolatedSpotifyPosition() / 1000;
    syncLyricsPosition(curPos, true);
  }
}

let lastSpotifyFormattedPosSec = -1;
let lastSpotifyFormattedDurSec = -1;
let lastSpotifyPlayPauseState = null;
let lastSpotifySdkThumb = null;
let lastSpotifyLyricsSyncSec = -1;

function resetLyrics() {
  currentLyrics = null;
  currentLyricsActiveIndex = -1;
  currentLyricsTrackKey = "";
  lastSpotifyLyricsSyncSec = -1;
  const contentEl = document.getElementById("spotify-lyrics-content");
  const scrollerEl = document.getElementById("spotify-lyrics-scroller");
  if (contentEl) {
    contentEl.classList.add("is-loading");
    contentEl.classList.remove("is-empty");
    contentEl.innerHTML = `<div class="spotify-lyrics-loading">Đang tải lời bài hát…</div>`;
  }
  if (scrollerEl) {
    scrollerEl.classList.add("is-loading");
    scrollerEl.classList.remove("is-empty");
  }
}

// ---- Spotify Web Playback SDK ----------------------------------------------
function matchesSpotifyTrack(trackObj, targetId) {
  if (!trackObj || !targetId) return false;
  const cleanTarget = String(targetId).replace(/^spotify:track:/, "");
  const trackId = String(trackObj.id || "").replace(/^spotify:track:/, "");
  const trackUri = String(trackObj.uri || "").replace(/^spotify:track:/, "");
  const linkedId = String(trackObj.linked_from?.id || "").replace(/^spotify:track:/, "");
  const linkedUri = String(trackObj.linked_from?.uri || "").replace(/^spotify:track:/, "");

  return (
    trackId === cleanTarget ||
    trackUri === cleanTarget ||
    (Boolean(linkedId) && linkedId === cleanTarget) ||
    (Boolean(linkedUri) && linkedUri === cleanTarget)
  );
}

function formatSpotifyTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem < 10 ? "0" : ""}${rem}`;
}

let isSpotifyScrubbing = false;

function triggerSpotifyEnded(playedSeconds = null, reason = "normal") {
  if (
    activePlayerProvider === "spotify" &&
    latestState?.nowPlaying?.videoId === currentVideoId &&
    currentPlaybackToken &&
    terminalReportedForToken !== currentPlaybackToken &&
    spotifyCurrentlyPlayingTrackId === currentVideoId &&
    spotifyWasPlaying
  ) {
    console.log(`[spotify] Track finished (${reason}), advancing to next song in queue.`);
    const durSec = spotifyPlayerState?.duration ? spotifyPlayerState.duration / 1000 : null;
    const seconds = typeof playedSeconds === "number" && playedSeconds > 0 ? playedSeconds : durSec;
    if (send({
      type: "ended",
      videoId: currentVideoId,
      playbackToken: currentPlaybackToken,
      playedSeconds: seconds,
    })) {
      terminalReportedForToken = currentPlaybackToken;
      spotifyCurrentlyPlayingTrackId = null;
      spotifyWasPlaying = false;
      stopSpotifySync();
    }
  }
}

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
  const curSec = Math.floor(pos);
  if (!isSpotifyScrubbing && curEl && curSec !== lastSpotifyFormattedPosSec) {
    lastSpotifyFormattedPosSec = curSec;
    curEl.textContent = formatSpotifyTime(pos);
  }
  const durSec = Math.floor(dur);
  if (totalEl && dur > 0 && durSec !== lastSpotifyFormattedDurSec) {
    lastSpotifyFormattedDurSec = durSec;
    totalEl.textContent = formatSpotifyTime(dur);
  }
  if (!isSpotifyScrubbing && (lastSpotifyLyricsSyncSec < 0 || Math.abs(pos - lastSpotifyLyricsSyncSec) >= 0.12)) {
    lastSpotifyLyricsSyncSec = pos;
    syncLyricsPosition(pos);
  }

  const isPaused = Boolean(state.paused && !isSpotifyLoadingTrack);
  if (isPaused !== lastSpotifyPlayPauseState) {
    lastSpotifyPlayPauseState = isPaused;
    updateSpotifyPlayPauseUI(isPaused);
  }

  const sdkThumb = state.track_window?.current_track?.album?.images?.[0]?.url;
  if (sdkThumb && sdkThumb !== lastSpotifySdkThumb) {
    lastSpotifySdkThumb = sdkThumb;
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

function getInterpolatedSpotifyPosition() {
  if (!spotifyPlayerState) return 0;
  if (
    spotifyPlayerState.paused ||
    isSpotifyLoadingTrack ||
    isSpotifyAutoplayBlocked ||
    spotifyPlayerState.loading ||
    (!spotifyWasPlaying && spotifyPlayerState.position === 0)
  ) {
    return spotifyAnchorPos;
  }
  const elapsed = performance.now() - spotifyAnchorTime;
  const dur = spotifyPlayerState.duration || Infinity;
  return Math.min(dur, Math.max(0, spotifyAnchorPos + elapsed));
}

function stopSpotifySync() {
  lastSpotifyFormattedPosSec = -1;
  lastSpotifyFormattedDurSec = -1;
  lastSpotifyPlayPauseState = null;
  lastSpotifySdkThumb = null;
  lastSpotifyLyricsSyncSec = -1;
  if (spotifyRafId) {
    cancelAnimationFrame(spotifyRafId);
    spotifyRafId = null;
  }
  if (spotifyReAnchorTimer) {
    clearInterval(spotifyReAnchorTimer);
    spotifyReAnchorTimer = null;
  }
  if (spotifyProgressTimer) {
    clearInterval(spotifyProgressTimer);
    spotifyProgressTimer = null;
  }
  if (spotifyTickBroadcastTimer) {
    clearInterval(spotifyTickBroadcastTimer);
    spotifyTickBroadcastTimer = null;
  }
}

function startSpotifySync() {
  stopSpotifySync();

  function loop() {
    if (activePlayerProvider !== "spotify" || !spotifyPlayerState || spotifyPlayerState.paused) {
      spotifyRafId = null;
      return;
    }
    if (document.hidden) {
      spotifyRafId = requestAnimationFrame(loop);
      return;
    }
    const currentPosMs = getInterpolatedSpotifyPosition();
    spotifyPlayerState.position = currentPosMs;
    spotifyMaxPositionMs = Math.max(spotifyMaxPositionMs, currentPosMs);
    updateSpotifyProgressUI(spotifyPlayerState);

    spotifyRafId = requestAnimationFrame(loop);
  }

  spotifyRafId = requestAnimationFrame(loop);

  spotifyReAnchorTimer = setInterval(() => {
    reAnchorFromSdk();
  }, 3000);

  spotifyTickBroadcastTimer = setInterval(() => {
    if (activePlayerProvider === "spotify" && spotifyPlayerState) {
      broadcastSpotifyTick({ seek: false });
    }
  }, 2500);
}

async function reAnchorFromSdk() {
  if (activePlayerProvider !== "spotify" || !latestState?.nowPlaying || !spotifyPlayer || !spotifyPlayer.getCurrentState) return;
  try {
    const currentState = await spotifyPlayer.getCurrentState();
    if (!currentState) return;
    spotifyPlayerState = currentState;

    const curTrack = currentState.track_window?.current_track;
    const isCurrentTrackInSdk = Boolean(
      currentVideoId &&
      (!curTrack || matchesSpotifyTrack(curTrack, currentVideoId))
    );

    const dur = currentState.duration || (latestState?.nowPlaying?.durationMs) || (durationSeconds(latestState?.nowPlaying?.duration) * 1000) || 0;
    if (isCurrentTrackInSdk && currentState.position > 0) {
      spotifyMaxPositionMs = Math.max(spotifyMaxPositionMs, currentState.position);
      spotifyWasPlaying = true;
      isSpotifyLoadingTrack = false;
      isSpotifyAutoplayBlocked = false;
    }

    const reachedEnd = Boolean(
      dur > 0 && (
        spotifyMaxPositionMs >= Math.max(1000, dur - 12000) ||
        spotifyMaxPositionMs >= dur * 0.90
      )
    );

    if (
      !isSeekPending &&
      spotifyWasPlaying &&
      spotifyCurrentlyPlayingTrackId === currentVideoId &&
      isCurrentTrackInSdk &&
      currentState.paused &&
      currentState.position === 0 &&
      reachedEnd
    ) {
      triggerSpotifyEnded(dur ? dur / 1000 : null, "reAnchor_state_ended");
      return;
    }

    if (!isSeekPending) {
      spotifyAnchorPos = currentState.position || 0;
      spotifyAnchorTime = performance.now();
    }
    if (!currentState.paused && isCurrentTrackInSdk) {
      broadcastSpotifyTick({ seek: false });
      if (!spotifyRafId) {
        startSpotifySync();
      }
    }
  } catch (err) {
    console.warn("[spotify] reAnchorFromSdk error:", err);
  }
}

function broadcastSpotifyTick({ seek = false } = {}) {
  if (activePlayerProvider === "spotify" && spotifyPlayerState) {
    const isPaused = Boolean(
      spotifyPlayerState.paused ||
      isSpotifyLoadingTrack ||
      isSpotifyAutoplayBlocked ||
      spotifyPlayerState.loading ||
      (!spotifyWasPlaying && spotifyPlayerState.position === 0)
    );
    const pos = getInterpolatedSpotifyPosition();
    lastBroadcastTickTime = performance.now();
    send({
      type: "playbackTick",
      position: Math.max(0, Math.floor(pos)),
      paused: isPaused,
      seek: Boolean(seek),
      videoId: currentVideoId,
    });
  }
}

let youtubeTickBroadcastTimer = null;

function stopYouTubeSync() {
  if (youtubeTickBroadcastTimer) {
    clearInterval(youtubeTickBroadcastTimer);
    youtubeTickBroadcastTimer = null;
  }
}

function startYouTubeSync() {
  stopYouTubeSync();
  broadcastYouTubeTick({ seek: false, forcedPaused: false });
  youtubeTickBroadcastTimer = setInterval(() => {
    const isYt = activePlayerProvider === "youtube" || activePlayerProvider === "yt";
    if (isYt) {
      broadcastYouTubeTick({ seek: false });
    } else {
      stopYouTubeSync();
    }
  }, 500);
}

function broadcastYouTubeTick({ seek = false, forcedPaused = null, forcedPositionSec = null } = {}) {
  const isYt = activePlayerProvider === "youtube" || activePlayerProvider === "yt";
  if (isYt && playerReady && player?.getCurrentTime) {
    try {
      const curTimeSec = forcedPositionSec != null ? forcedPositionSec : (Number(player.getCurrentTime()) || 0);
      const state = player?.getPlayerState ? player.getPlayerState() : -1;
      const isPlaying = (typeof YT !== "undefined" && YT?.PlayerState)
        ? state === YT.PlayerState.PLAYING
        : state === 1;
      const paused = forcedPaused != null ? forcedPaused : !isPlaying;
      const durSec = Number(player?.getDuration ? player.getDuration() : 0) || 0;
      send({
        type: "playbackTick",
        position: Math.max(0, Math.floor(curTimeSec * 1000)),
        duration: durSec > 0 ? durSec : undefined,
        paused,
        seek: Boolean(seek),
        videoId: currentVideoId,
      });
      if (paused && durSec > 0 && curTimeSec >= Math.max(1, durSec - 0.5)) {
        reportIfEnded();
      }
    } catch (err) {
      console.warn("[youtube] broadcastYouTubeTick error:", err);
    }
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
    if (started && spotifyPlayer?.activateElement) {
      spotifyPlayer.activateElement().catch(() => {});
    }
    updateSpotifyStatus();
    if (activePlayerProvider === "spotify" && started && latestState?.nowPlaying?.videoId === currentVideoId) {
      const resumePosMs = Math.max(
        0,
        Math.floor(spotifyAnchorPos || spotifyPlayerState?.position || 0)
      );
      playSpotify(currentVideoId, resumePosMs);
      if (currentPlaybackToken) {
        armPlaybackWatchdog(currentVideoId, currentPlaybackToken);
      }
    }
  });

  spotifyPlayer.addListener("not_ready", ({ device_id }) => {
    console.warn("[spotify] Device ID is offline:", device_id);
    spotifyReady = false;
    if (activePlayerProvider === "spotify") {
      const curPos = getInterpolatedSpotifyPosition();
      if (curPos > 0) {
        spotifyAnchorPos = Math.floor(curPos);
        spotifyAnchorTime = performance.now();
      }
      stopSpotifySync();
    }
  });

  spotifyPlayer.addListener("player_state_changed", (state) => {
    spotifyPlayerState = state;
    if (!state) return;
    if (activePlayerProvider === "spotify") {
      if (!latestState?.nowPlaying) {
        if (!state.paused && spotifyPlayer?.pause) {
          spotifyPlayer.pause().catch(() => {});
        }
        stopSpotifySync();
        return;
      }
      updatePlayPauseIcon();

      const currentTrack = state.track_window?.current_track;
      const prevTracks = state.track_window?.previous_tracks || [];

      const isCurrentTrackInSdk = Boolean(
        currentVideoId &&
        (!currentTrack || matchesSpotifyTrack(currentTrack, currentVideoId))
      );

      // Verify whether current track has actually started audio playback
      const isAudioActuallyPlaying = Boolean(
        isCurrentTrackInSdk &&
        !state.paused &&
        !state.loading &&
        (state.position > 0 || spotifyWasPlaying || !document.hidden)
      );

      if (isAudioActuallyPlaying) {
        spotifyCurrentlyPlayingTrackId = currentVideoId;
        spotifyWasPlaying = true;
        isSpotifyLoadingTrack = false;
        isSpotifyAutoplayBlocked = false;
      }

      if (isCurrentTrackInSdk && state.position > 0) {
        spotifyMaxPositionMs = Math.max(spotifyMaxPositionMs, state.position);
      }

      const prevAnchorPos = spotifyAnchorPos;

      // Check whether this is a genuine end-of-track:
      // Spotify has paused and reset position to 0 (or track transitioned to previous),
      // and playback had reached the final seconds of the track.
      const effectiveDuration = state.duration > 0
        ? state.duration
        : (latestState?.nowPlaying?.durationMs || (durationSeconds(latestState?.nowPlaying?.duration) * 1000) || 0);

      const reachedNearEnd = Boolean(
        effectiveDuration > 0 && (
          spotifyMaxPositionMs >= Math.max(1000, effectiveDuration - 12000) ||
          spotifyMaxPositionMs >= effectiveDuration * 0.90 ||
          prevAnchorPos >= Math.max(1000, effectiveDuration - 12000) ||
          prevAnchorPos >= effectiveDuration * 0.90
        )
      );

      const hasTrackInPrevious = prevTracks.some((t) => matchesSpotifyTrack(t, currentVideoId));

      const trackMovedToPrevious = Boolean(
        currentVideoId &&
        spotifyCurrentlyPlayingTrackId === currentVideoId &&
        hasTrackInPrevious &&
        !matchesSpotifyTrack(currentTrack, currentVideoId) &&
        reachedNearEnd
      );

      const isSongFinished = Boolean(
        !isSeekPending &&
        spotifyWasPlaying &&
        spotifyCurrentlyPlayingTrackId === currentVideoId &&
        (
          (isCurrentTrackInSdk && state.paused && state.position === 0 && reachedNearEnd) ||
          trackMovedToPrevious
        )
      );

      if (isSongFinished) {
        if (state.duration > 0) {
          state.position = state.duration;
        }
        updateSpotifyProgressUI(state);
        stopSpotifySync();
        triggerSpotifyEnded(state.duration ? state.duration / 1000 : null, "player_state_changed");
        return;
      }

      // If the SDK event is not for currentVideoId and not finishing currentVideoId, ignore it
      if (!isCurrentTrackInSdk && !trackMovedToPrevious) {
        return;
      }

      if (state.position === 0 && !isSongFinished && prevAnchorPos > 0 && spotifyWasPlaying) {
        // Network drop or pause without seek: preserve prevAnchorPos so we can resume
      } else if (isSeekPending) {
        const diff = Math.abs((state.position || 0) - seekTargetMs);
        if (diff < 1000) {
          isSeekPending = false;
          spotifyAnchorPos = state.position || 0;
          spotifyAnchorTime = performance.now();
        }
      } else {
        spotifyAnchorPos = state.position || 0;
        spotifyAnchorTime = performance.now();
      }

      updateSpotifyProgressUI(spotifyPlayerState);
      broadcastSpotifyTick({ seek: isSeekPending });

      stopSpotifySync();

      if (!state.paused && !state.loading && isAudioActuallyPlaying) {
        clearTimeout(playbackWatchdog);
        hidePlaybackRecovery();
        clearTimeout(spotifyAutoPlayTimer);
        spotifyAutoPlayTimer = null;
        startSpotifySync();
      } else if (
        (isSpotifyLoadingTrack || isSpotifyAutoplayBlocked || state.paused || state.loading || !isAudioActuallyPlaying) &&
        started &&
        latestState?.nowPlaying?.videoId === currentVideoId
      ) {
        if (!spotifyAutoPlayTimer) {
          spotifyAutoPlayTimer = setTimeout(() => {
            if (activePlayerProvider === "spotify" && started && (spotifyPlayerState?.paused || isSpotifyLoadingTrack || !spotifyWasPlaying)) {
              console.log("[spotify] Proactively resuming newly loaded track...");
              spotifyPlayer?.resume?.().catch(() => {});
            }
          }, 400);
        }
      }
    }
  });

  spotifyPlayer.addListener("autoplay_failed", () => {
    console.warn("[spotify] autoplay_failed: browser autoplay policy prevented background audio playback");
    isSpotifyAutoplayBlocked = true;
    showPlaybackRecovery();
  });

  spotifyPlayer.addListener("initialization_error", ({ message }) => {
    console.error("[spotify] Init error:", message);
    if (activePlayerProvider === "spotify" && currentPlaybackToken && terminalReportedForToken !== currentPlaybackToken) {
      if (send({ type: "error", videoId: currentVideoId, playbackToken: currentPlaybackToken, code: "initialization_error" })) {
        terminalReportedForToken = currentPlaybackToken;
      }
    }
  });
  spotifyPlayer.addListener("authentication_error", ({ message }) => {
    console.error("[spotify] Auth error:", message);
    updateSpotifyStatus();
    if (activePlayerProvider === "spotify" && currentPlaybackToken && terminalReportedForToken !== currentPlaybackToken) {
      if (send({ type: "error", videoId: currentVideoId, playbackToken: currentPlaybackToken, code: "authentication_error" })) {
        terminalReportedForToken = currentPlaybackToken;
      }
    }
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
    console.warn("[spotify] Playback warning:", message);
    showPlaybackRecovery();
  });

  spotifyPlayer.connect();
};

async function playSpotify(trackId, positionMs = 0) {
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
      if (tokenData && tokenData.configured === false) {
        if (activePlayerProvider === "spotify" && currentPlaybackToken && terminalReportedForToken !== currentPlaybackToken) {
          if (send({ type: "error", videoId: currentVideoId, playbackToken: currentPlaybackToken, code: "spotify_not_configured" })) {
            terminalReportedForToken = currentPlaybackToken;
          }
        }
        return;
      }
      showPlaybackRecovery();
      return;
    }
    const token = tokenData.access_token;
    spotifyWasPlaying = false;
    spotifyCurrentlyPlayingTrackId = null;
    let startPos = Math.max(0, Math.floor(positionMs || 0));
    if (spotifyPlayerState?.duration > 0 && startPos >= spotifyPlayerState.duration - 1000) {
      startPos = Math.max(0, spotifyPlayerState.duration - 1000);
    }
    spotifyAnchorPos = startPos;
    spotifyMaxPositionMs = startPos;
    spotifyAnchorTime = performance.now();
    isSeekPending = false;
    isSpotifyLoadingTrack = true;
    isSpotifyAutoplayBlocked = false;

    const playBody = {
      uris: [`spotify:track:${trackId}`],
    };
    if (startPos > 0) {
      playBody.position_ms = startPos;
    }

    if (spotifyPlayer?.activateElement) {
      spotifyPlayer.activateElement().catch(() => {});
    }

    const playRes = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${spotifyDeviceId}`, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(playBody),
    });

    if (playRes.status === 204 || playRes.ok) {
      setTimeout(() => {
        if (
          activePlayerProvider === "spotify" &&
          started &&
          latestState?.nowPlaying?.videoId === trackId &&
          spotifyCurrentlyPlayingTrackId === trackId
        ) {
          spotifyPlayer?.resume?.().catch(() => {});
        }
      }, 150);
    }

    clearTimeout(spotifyAutoPlayTimer);
    spotifyAutoPlayTimer = setTimeout(() => {
      if (activePlayerProvider === "spotify" && started && latestState?.nowPlaying?.videoId === trackId) {
        if (spotifyPlayerState?.paused || !spotifyWasPlaying || spotifyPlayerState?.position === 0) {
          const curTrackId = spotifyPlayerState?.track_window?.current_track?.id;
          if (!curTrackId || curTrackId === trackId) {
            console.log("[spotify] Ensuring playback is active (attempt 1 at 800ms)...");
            spotifyPlayer?.resume?.().catch(() => {});
          }
        }
      }
      setTimeout(() => {
        if (activePlayerProvider === "spotify" && started && latestState?.nowPlaying?.videoId === trackId) {
          if (spotifyPlayerState?.paused || !spotifyWasPlaying || spotifyPlayerState?.position === 0) {
            console.log("[spotify] Ensuring playback is active (attempt 2 at 1600ms)...");
            spotifyPlayer?.resume?.().catch(() => {});
          }
        }
      }, 800);
    }, 800);
    if (!playRes.ok && playRes.status !== 204) {
      await fetch("https://api.spotify.com/v1/me/player", {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ device_ids: [spotifyDeviceId], play: true }),
      });
      await new Promise((r) => setTimeout(r, 200));
      const retryRes = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${spotifyDeviceId}`, {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(playBody),
      });
      if (spotifyPlayer?.resume) {
        spotifyPlayer.resume().catch(() => {});
      }
      if (!retryRes.ok && retryRes.status !== 204) {
        console.warn(`[spotify] Play request failed (${retryRes.status})`);
      }
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
    scWidget.getDuration((d) => {
      scDurationSec = Math.round((d || 0) / 1000);
      if (scDurationSec > 0 && activePlayerProvider === "soundcloud") {
        send({
          type: "playbackTick",
          position: Math.max(0, Math.floor(scCurrentPosition || 0)),
          duration: scDurationSec,
          paused: false,
          videoId: currentVideoId,
        });
      }
    });
  });
  scWidget.bind(window.SC.Widget.Events.PLAY_PROGRESS, (data) => {
    const posMs = data?.currentPosition || 0;
    scCurrentPosition = posMs;
    if (activePlayerProvider === "soundcloud") {
      send({
        type: "playbackTick",
        position: Math.max(0, Math.floor(posMs)),
        duration: scDurationSec > 0 ? scDurationSec : undefined,
        paused: false,
        videoId: currentVideoId,
      });
    }
  });
  scWidget.bind(window.SC.Widget.Events.PAUSE, () => {
    scIsPlaying = false;
    updatePlayPauseIcon();
    if (activePlayerProvider === "soundcloud") {
      send({
        type: "playbackTick",
        position: Math.max(0, Math.floor(scCurrentPosition || 0)),
        duration: scDurationSec > 0 ? scDurationSec : undefined,
        paused: true,
        videoId: currentVideoId,
      });
    }
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
  if (!url || typeof url !== "string" || !url.trim()) {
    console.warn("[soundcloud] Missing or invalid SoundCloud URL");
    if (activePlayerProvider === "soundcloud" && currentPlaybackToken && terminalReportedForToken !== currentPlaybackToken) {
      if (send({ type: "error", videoId: currentVideoId, playbackToken: currentPlaybackToken, code: "invalid_soundcloud_url" })) {
        terminalReportedForToken = currentPlaybackToken;
      }
    }
    return;
  }
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
  if (activePlayerProvider === "tiktok" && tiktokAudio) {
    const t = Number(tiktokAudio.currentTime);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// ---- TikTok Audio Player ---------------------------------------------------
function initTikTokPlayer() {
  if (tiktokAudio) return;
  tiktokAudio = document.getElementById("tiktok-audio-player");
  if (!tiktokAudio) return;

  tiktokAudio.addEventListener("play", () => {
    tiktokIsPlaying = true;
    tiktokRetryCount = 0;
    clearTimeout(tiktokRetryTimer);
    clearTimeout(playbackWatchdog);
    hidePlaybackRecovery();
    updatePlayPauseIcon();
  });

  tiktokAudio.addEventListener("pause", () => {
    tiktokIsPlaying = false;
    updatePlayPauseIcon();
    if (activePlayerProvider === "tiktok") {
      const dur = tiktokAudio.duration || 0;
      send({
        type: "playbackTick",
        position: Math.max(0, Math.floor((tiktokAudio.currentTime || 0) * 1000)),
        duration: dur > 0 ? Math.round(dur) : undefined,
        paused: true,
        videoId: currentVideoId,
      });
    }
  });

  tiktokAudio.addEventListener("timeupdate", () => {
    if (!tiktokAudio) return;
    const cur = tiktokAudio.currentTime || 0;
    if (cur > 0) tiktokResumeTime = cur;
    const dur = tiktokAudio.duration || 0;
    const curEl = document.getElementById("tiktok-time-cur");
    const totalEl = document.getElementById("tiktok-time-total");
    const fillEl = document.getElementById("tiktok-progress-fill");

    if (curEl) curEl.textContent = formatTikTokTime(cur);
    if (totalEl && dur > 0) totalEl.textContent = formatTikTokTime(dur);
    if (fillEl && dur > 0) {
      const pct = Math.min(100, Math.max(0, (cur / dur) * 100));
      fillEl.style.width = `${pct.toFixed(1)}%`;
    }

    if (activePlayerProvider === "tiktok" && Date.now() - lastTikTokTickTime > 1000) {
      lastTikTokTickTime = Date.now();
      send({
        type: "playbackTick",
        position: Math.max(0, Math.floor(cur * 1000)),
        duration: dur > 0 ? Math.round(dur) : undefined,
        paused: Boolean(tiktokAudio.paused),
        videoId: currentVideoId,
      });
    }

    // Task 6.2.3: Tầng 1 — Ngắt theo musicDurationSec
    const curNp = latestState?.nowPlaying;
    const musicDur = Number(curNp?.musicDurationSec) || 0;
    if (
      activePlayerProvider === "tiktok" &&
      musicDur > 0 &&
      cur >= musicDur + 0.5 &&
      currentPlaybackToken &&
      terminalReportedForToken !== currentPlaybackToken
    ) {
      console.log(`[tiktok] Reached music duration limit (${cur.toFixed(1)}s >= ${musicDur}s + 0.5s) — ending track`);
      tiktokAudio.pause();
      if (send({
        type: "ended",
        videoId: currentVideoId,
        playbackToken: currentPlaybackToken,
        playedSeconds: cur,
      })) {
        terminalReportedForToken = currentPlaybackToken;
      }
    }
  });

  tiktokAudio.addEventListener("ended", () => {
    tiktokIsPlaying = false;
    tiktokRetryCount = 0;
    clearTimeout(tiktokRetryTimer);
    updatePlayPauseIcon();
    const token = tiktokAudio.dataset.playbackToken;
    if (token && currentPlaybackToken && token !== currentPlaybackToken) {
      return;
    }
    if (activePlayerProvider === "tiktok" && currentPlaybackToken && terminalReportedForToken !== currentPlaybackToken) {
      if (send({
        type: "ended",
        videoId: currentVideoId,
        playbackToken: currentPlaybackToken,
        playedSeconds: tiktokAudio.currentTime || null,
      })) {
        terminalReportedForToken = currentPlaybackToken;
      }
    }
  });

  tiktokAudio.addEventListener("error", (e) => {
    const token = tiktokAudio.dataset.playbackToken;
    if (token && currentPlaybackToken && token !== currentPlaybackToken) {
      return;
    }
    console.warn("[tiktok] audio playback error:", e);
    tiktokIsPlaying = false;
    updatePlayPauseIcon();
    if (activePlayerProvider !== "tiktok" || !currentPlaybackToken || terminalReportedForToken === currentPlaybackToken) {
      return;
    }

    const isNetworkIssue = typeof navigator !== "undefined" && !navigator.onLine;
    const isNetworkError = tiktokAudio.error && tiktokAudio.error.code === 2; // MEDIA_ERR_NETWORK
    const wasPlaying = tiktokResumeTime > 0;

    if ((isNetworkIssue || isNetworkError || wasPlaying) && tiktokRetryCount < 3) {
      tiktokRetryCount++;
      console.warn(`[tiktok] Lỗi mạng gián đoạn — thử tiếp tục phát từ ${tiktokResumeTime.toFixed(1)}s (lần ${tiktokRetryCount}/3)`);
      clearTimeout(tiktokRetryTimer);
      tiktokRetryTimer = setTimeout(() => {
        if (activePlayerProvider === "tiktok" && started && latestState?.nowPlaying?.videoId === currentVideoId) {
          playTikTok(currentVideoId, tiktokResumeTime);
        }
      }, 2000);
      return;
    }

    if (send({
      type: "error",
      videoId: currentVideoId,
      playbackToken: currentPlaybackToken,
      code: "tiktok_playback_error",
    })) {
      terminalReportedForToken = currentPlaybackToken;
    }
  });

  const artCenter = document.getElementById("tiktok-art-center");
  if (artCenter) {
    artCenter.addEventListener("click", () => toggleTikTokPlay());
  }
  const progressBar = document.getElementById("tiktok-progress-bar");
  if (progressBar) {
    progressBar.addEventListener("click", (e) => {
      if (!tiktokAudio || !tiktokAudio.duration) return;
      const rect = progressBar.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const pct = Math.min(1, Math.max(0, clickX / rect.width));
      tiktokAudio.currentTime = pct * tiktokAudio.duration;
    });
  }
}

function formatTikTokTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, "0")}`;
}

function updateTikTokPlayPauseUI(isPaused) {
  const centerPlay = document.getElementById("tiktok-center-play-btn");
  if (!centerPlay) return;
  const iconPlay = centerPlay.querySelector(".center-icon-play");
  const iconPause = centerPlay.querySelector(".center-icon-pause");
  if (iconPlay && iconPause) {
    iconPlay.classList.toggle("hidden", !isPaused);
    iconPause.classList.toggle("hidden", isPaused);
  }
}

function toggleTikTokPlay() {
  if (!tiktokAudio || !latestState?.nowPlaying) return;
  if (tiktokAudio.paused) {
    tiktokAudio.play().catch((err) => console.warn("[tiktok] play blocked:", err));
  } else {
    tiktokAudio.pause();
  }
}

function playTikTok(url, resumeTime = 0) {
  if (!started) return;
  if (!url || typeof url !== "string" || !url.trim()) {
    console.warn("[tiktok] Missing or invalid TikTok URL");
    if (activePlayerProvider === "tiktok" && currentPlaybackToken && terminalReportedForToken !== currentPlaybackToken) {
      if (send({ type: "error", videoId: currentVideoId, playbackToken: currentPlaybackToken, code: "invalid_tiktok_url" })) {
        terminalReportedForToken = currentPlaybackToken;
      }
    }
    return;
  }
  initTikTokPlayer();
  if (!tiktokAudio) return;

  tiktokIsPlaying = false;
  const targetTime = Math.max(0, resumeTime || 0);
  tiktokResumeTime = targetTime;
  try {
    tiktokAudio.pause();
    tiktokAudio.removeAttribute("src");
    tiktokAudio.load();
  } catch {}

  const tokenParam = currentPlaybackToken ? `&t=${encodeURIComponent(currentPlaybackToken)}` : "";
  tiktokAudio.dataset.playbackToken = currentPlaybackToken || "";
  tiktokAudio.src = `/api/tiktok/stream?url=${encodeURIComponent(url)}${tokenParam}`;
  if (targetTime > 0) {
    const onLoaded = () => {
      tiktokAudio.removeEventListener("loadedmetadata", onLoaded);
      try {
        tiktokAudio.currentTime = targetTime;
      } catch (err) {
        console.warn("[tiktok] could not seek to resumeTime:", err);
      }
    };
    tiktokAudio.addEventListener("loadedmetadata", onLoaded);
  }
  tiktokAudio.play().catch((err) => {
    console.warn("[tiktok] autoplay prevented:", err);
    attemptAutoplayRecovery();
  });
}

// Synchronize the player with the song the server reports as current.
function syncPlayer() {
  if (!started) return;
  const np = latestState.nowPlaying;
  const idle = document.getElementById("idle");
  const playerYtEl = document.getElementById("player");
  const playerSpotifyEl = document.getElementById("player-spotify");
  const playerSoundCloudEl = document.getElementById("player-soundcloud");
  const playerTikTokEl = document.getElementById("player-tiktok");

  if (!np) {
    clearTimeout(playbackWatchdog);
    stopSpotifySync();
    if (playbackEventHandlers && player?.removeEventListener) {
      player.removeEventListener("onStateChange", playbackEventHandlers.onStateChange);
      player.removeEventListener("onError", playbackEventHandlers.onError);
    }
    playbackEventHandlers = null;
    currentVideoId = null;
    currentPlaybackToken = null;
    terminalReportedForToken = null;
    spotifyWasPlaying = false;
    spotifyCurrentlyPlayingTrackId = null;
    spotifyPlayerState = null;
    spotifyAnchorPos = 0;
    spotifyMaxPositionMs = 0;
    isSpotifyLoadingTrack = false;
    clearTimeout(spotifyAutoPlayTimer);
    spotifyAutoPlayTimer = null;
    scIsPlaying = false;
    tiktokIsPlaying = false;
    tiktokResumeTime = 0;
    tiktokRetryCount = 0;
    clearTimeout(tiktokRetryTimer);
    if (player?.stopVideo) player.stopVideo();
    if (spotifyPlayer?.pause) {
      spotifyPlayer.pause().catch(() => {});
    }
    if (scWidget?.pause) { try { scWidget.pause(); } catch {} }
    if (tiktokAudio) {
      try {
        tiktokAudio.pause();
        tiktokAudio.currentTime = 0;
        tiktokAudio.removeAttribute("src");
        tiktokAudio.load();
      } catch {}
    }
    const scIframe = document.getElementById("sc-widget-iframe");
    if (scIframe && scIframe.src && scIframe.src.includes("auto_play=true")) {
      scIframe.src = "https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/293&auto_play=false";
    }
    hidePlaybackRecovery();
    playerYtEl.classList.add("hidden");
    playerSpotifyEl.classList.add("hidden");
    playerSoundCloudEl.classList.add("hidden");
    playerTikTokEl?.classList.add("hidden");
    stopSpotifySync();
    stopYouTubeSync();
    resetLyrics();
    updateMediaSession(null);
    idle.classList.remove("hidden");
    updatePlayPauseIcon();
    return;
  }

  idle.classList.add("hidden");
  const provider = (np.provider || "youtube").toLowerCase();
  activePlayerProvider = provider;
  updatePlayPauseIcon();

  if (np.videoId !== currentVideoId || np.playbackToken !== currentPlaybackToken) {
    if (provider === "youtube" && !playerReady) {
      return;
    }
    if (playbackEventHandlers && player?.removeEventListener) {
      player.removeEventListener("onStateChange", playbackEventHandlers.onStateChange);
      player.removeEventListener("onError", playbackEventHandlers.onError);
    }
    playbackEventHandlers = null;
    currentVideoId = np.videoId;
    currentPlaybackToken = np.playbackToken || null;
    currentProvider = provider;
    terminalReportedForToken = null;
    spotifyWasPlaying = false;
    spotifyCurrentlyPlayingTrackId = null;
    scIsPlaying = false;
    tiktokIsPlaying = false;
    tiktokResumeTime = 0;
    tiktokRetryCount = 0;
    clearTimeout(tiktokRetryTimer);

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
      stopSpotifySync();
      stopYouTubeSync();
      playerYtEl.classList.remove("hidden");
      playerSpotifyEl.classList.add("hidden");
      playerSoundCloudEl.classList.add("hidden");
      playerTikTokEl?.classList.add("hidden");
      if (player?.pauseVideo) {
        try { player.pauseVideo(); } catch {}
      } else if (player?.stopVideo) {
        try { player.stopVideo(); } catch {}
      }
      if (spotifyPlayer?.pause) spotifyPlayer.pause();
      if (scWidget?.pause) { try { scWidget.pause(); } catch {} }
      if (tiktokAudio) { try { tiktokAudio.pause(); } catch {} }
      const scIframe = document.getElementById("sc-widget-iframe");
      if (scIframe && scIframe.src && scIframe.src.includes("auto_play=true")) {
        scIframe.src = "https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/293&auto_play=false";
      }

      if (!playerReady) return;

      playbackEventHandlers = {
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.PLAYING) {
            const actualId = player.getVideoData ? player.getVideoData()?.video_id : null;
            if (actualId && currentVideoId && actualId !== currentVideoId) {
              console.warn("[reconcile] YouTube videoId mismatch in onStateChange PLAYING:", {
                actual: actualId,
                expected: currentVideoId,
              });
              if (player?.pauseVideo) {
                try { player.pauseVideo(); } catch {}
              } else if (player?.stopVideo) {
                try { player.stopVideo(); } catch {}
              }
              player.loadVideoById(currentVideoId);
              return;
            }
            if (autoplayMutedRecoveryActive) {
              autoplayMutedRecoveryActive = false;
              try { player.unMute?.(); } catch {}
            }
            clearTimeout(playbackWatchdog);
            hidePlaybackRecovery();
            startYouTubeSync();
          } else if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.BUFFERING) {
            stopYouTubeSync();
            broadcastYouTubeTick({ seek: false, forcedPaused: true });
          } else if (e.data === YT.PlayerState.ENDED) {
            stopYouTubeSync();
            sendTerminal("ended");
          }
          updatePlayPauseIcon();
        },
        onError: (e) => {
          stopYouTubeSync();
          console.warn("YouTube player error", e?.data, "for", eventVideoId);
          sendTerminal("error", e?.data ?? null);
        },
      };
      if (player.addEventListener) {
        player.addEventListener("onStateChange", playbackEventHandlers.onStateChange);
        player.addEventListener("onError", playbackEventHandlers.onError);
      }

      player.loadVideoById(np.videoId);
      setTimeout(() => {
        if (activePlayerProvider === "youtube" && playerReady && latestState?.nowPlaying?.videoId === np.videoId) {
          const s = player.getPlayerState ? player.getPlayerState() : -1;
          if (s === YT.PlayerState.CUED || s === YT.PlayerState.UNSTARTED) {
            const actualId = player.getVideoData ? player.getVideoData()?.video_id : null;
            if (!actualId || actualId === np.videoId) {
              player.playVideo?.();
            }
          }
        }
      }, 1000);
      armPlaybackWatchdog(np.videoId, currentPlaybackToken);
    } else if (provider === "spotify") {
      stopYouTubeSync();
      playerYtEl.classList.add("hidden");
      playerSpotifyEl.classList.remove("hidden");
      playerSoundCloudEl.classList.add("hidden");
      playerTikTokEl?.classList.add("hidden");
      if (player?.pauseVideo) {
        try { player.pauseVideo(); } catch {}
      } else if (player?.stopVideo) {
        try { player.stopVideo(); } catch {}
      }
      if (spotifyPlayer?.pause) {
        try { spotifyPlayer.pause().catch(() => {}); } catch {}
      }
      if (scWidget?.pause) { try { scWidget.pause(); } catch {} }
      if (tiktokAudio) { try { tiktokAudio.pause(); } catch {} }
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

      isSpotifyLoadingTrack = true;
      isSpotifyAutoplayBlocked = false;
      spotifyPlayerState = null;
      spotifyAnchorPos = 0;
      spotifyMaxPositionMs = 0;
      spotifyWasPlaying = false;
      spotifyCurrentlyPlayingTrackId = null;
      spotifyAnchorTime = performance.now();
      updateSpotifyPlayPauseUI(false);
      loadLyrics(np.title, np.channel, np.duration, np.artists || [], np.provider || "spotify", np.videoId);
      playSpotify(np.videoId);
      armPlaybackWatchdog(np.videoId, currentPlaybackToken);
    } else if (provider === "soundcloud") {
      stopSpotifySync();
      playerYtEl.classList.add("hidden");
      playerSpotifyEl.classList.add("hidden");
      playerSoundCloudEl.classList.remove("hidden");
      playerTikTokEl?.classList.add("hidden");
      if (player?.pauseVideo) {
        try { player.pauseVideo(); } catch {}
      } else if (player?.stopVideo) {
        try { player.stopVideo(); } catch {}
      }
      if (spotifyPlayer?.pause) spotifyPlayer.pause();
      if (scWidget?.pause) { try { scWidget.pause(); } catch {} }
      if (tiktokAudio) { try { tiktokAudio.pause(); } catch {} }

      playSoundCloud(np.videoId);
      armPlaybackWatchdog(np.videoId, currentPlaybackToken);
    } else if (provider === "tiktok") {
      stopSpotifySync();
      playerYtEl.classList.add("hidden");
      playerSpotifyEl.classList.add("hidden");
      playerSoundCloudEl.classList.add("hidden");
      playerTikTokEl?.classList.remove("hidden");
      if (player?.pauseVideo) {
        try { player.pauseVideo(); } catch {}
      } else if (player?.stopVideo) {
        try { player.stopVideo(); } catch {}
      }
      if (spotifyPlayer?.pause) spotifyPlayer.pause();
      if (scWidget?.pause) { try { scWidget.pause(); } catch {} }

      const coverUrl = safeImageUrl(np.thumbnail);
      const coverEl = document.getElementById("tiktok-cover");
      if (coverEl) {
        coverEl.referrerPolicy = "no-referrer";
        coverEl.src = coverUrl;
      }
      const glowEl = document.getElementById("tiktok-ambient-glow");
      if (glowEl) {
        glowEl.style.backgroundImage = coverUrl && coverUrl !== NO_THUMB ? `url("${coverUrl}")` : "";
      }
      const titleEl = document.getElementById("tiktok-title");
      if (titleEl) titleEl.textContent = np.title || "—";
      const channelEl = document.getElementById("tiktok-channel");
      if (channelEl) channelEl.textContent = np.channel || "—";

      const reqPill = document.getElementById("tiktok-requester-pill");
      const reqName = document.getElementById("tiktok-requester-name");
      if (reqPill && reqName) {
        if (np.addedBy) {
          reqName.textContent = `Yêu cầu: ${np.addedBy}`;
          reqPill.classList.remove("hidden");
        } else {
          reqPill.classList.add("hidden");
        }
      }

      const fillEl = document.getElementById("tiktok-progress-fill");
      if (fillEl) fillEl.style.width = "0%";
      const curEl = document.getElementById("tiktok-time-cur");
      if (curEl) curEl.textContent = "0:00";
      const totalEl = document.getElementById("tiktok-time-total");
      if (totalEl) totalEl.textContent = np.duration || "0:30";

      updateTikTokPlayPauseUI(false);
      playTikTok(np.videoId);
      armPlaybackWatchdog(np.videoId, currentPlaybackToken);
    }
  }
}

// Some broken embeds show only a black frame without firing onError. If a newly
// loaded video has not started after 20 seconds (and is not merely paused),
// report an error so the server skips to the next song.
// ---- Autoplay Recovery & Watchdog ------------------------------------------
let playbackWatchdog = null;
let watchdogHiddenExtendCount = 0;
let autoplayBlockedTimer = null;
let autoplayMutedRecoveryActive = false;

function showPlaybackRecovery() {
  if (!started || !latestState?.nowPlaying) return;
  document.getElementById("playback-recovery").classList.remove("hidden");
}

function hidePlaybackRecovery() {
  clearTimeout(autoplayBlockedTimer);
  autoplayBlockedTimer = null;
  document.getElementById("playback-recovery").classList.add("hidden");
}

function attemptAutoplayRecovery() {
  if (!started || !latestState?.nowPlaying) return;
  clearTimeout(autoplayBlockedTimer);

  setTimeout(() => {
    if (!started || !latestState?.nowPlaying) return;
    if (activePlayerProvider === "youtube" && playerReady) {
      if (player.getPlayerState?.() === YT.PlayerState.PLAYING) return;
      player.playVideo?.();
    } else if (activePlayerProvider === "tiktok" && tiktokAudio) {
      if (tiktokIsPlaying) return;
      tiktokAudio.play?.().catch(() => {});
    } else if (activePlayerProvider === "spotify" && spotifyPlayer) {
      spotifyPlayer.resume?.().catch(() => {});
    }

    setTimeout(() => {
      if (!started || !latestState?.nowPlaying) return;
      if (activePlayerProvider === "youtube" && playerReady) {
        if (player.getPlayerState?.() === YT.PlayerState.PLAYING) return;
        try {
          player.mute?.();
          player.playVideo?.();
          autoplayMutedRecoveryActive = true;
        } catch {}
      } else if (activePlayerProvider === "tiktok" && tiktokAudio) {
        if (tiktokIsPlaying) return;
        try {
          tiktokAudio.muted = true;
          tiktokAudio.play?.().then(() => {
            tiktokAudio.muted = false;
          }).catch(() => {});
        } catch {}
      }
    }, 300);
  }, 300);

  autoplayBlockedTimer = setTimeout(() => {
    if (!started || !latestState?.nowPlaying) return;
    let isPlaying = false;
    if (activePlayerProvider === "youtube") {
      isPlaying = playerReady && player.getPlayerState?.() === YT.PlayerState.PLAYING;
    } else if (activePlayerProvider === "spotify") {
      isPlaying = Boolean(spotifyPlayerState && !spotifyPlayerState.paused);
    } else if (activePlayerProvider === "tiktok") {
      isPlaying = tiktokIsPlaying;
    } else if (activePlayerProvider === "soundcloud") {
      isPlaying = scIsPlaying;
    }
    if (!isPlaying) {
      showPlaybackRecovery();
    }
  }, 1800);
}

function armPlaybackWatchdog(videoId, playbackToken) {
  clearTimeout(playbackWatchdog);
  watchdogHiddenExtendCount = 0;
  playbackWatchdog = setTimeout(() => {
    if (currentVideoId !== videoId || currentPlaybackToken !== playbackToken) return;
    if (activePlayerProvider === "youtube") {
      if (!playerReady) return;
      const actualId = player.getVideoData ? player.getVideoData()?.video_id : null;
      if (actualId && actualId !== videoId) {
        console.warn(`[watchdog] YouTube videoId mismatch: actual ${actualId} !== expected ${videoId}`);
      } else {
        const t = player.getCurrentTime ? player.getCurrentTime() : 0;
        const s = player.getPlayerState ? player.getPlayerState() : -1;
        if (t >= 1 || s === YT.PlayerState.PLAYING || s === YT.PlayerState.PAUSED) return;
        if ((document.hidden || s === YT.PlayerState.BUFFERING) && watchdogHiddenExtendCount < 2) {
          watchdogHiddenExtendCount++;
          armPlaybackWatchdog(videoId, playbackToken);
          return;
        }
      }
    } else if (activePlayerProvider === "spotify") {
      const curTrack = spotifyPlayerState?.track_window?.current_track;
      const matchesTrack = matchesSpotifyTrack(curTrack, videoId);
      const isPlaying = Boolean(
        spotifyWasPlaying &&
        spotifyPlayerState &&
        !spotifyPlayerState.paused &&
        matchesTrack
      );
      if (isPlaying || isLyricsMode) return;
      if ((!spotifyReady || !spotifyDeviceId || document.hidden || isSpotifyLoadingTrack) && watchdogHiddenExtendCount < 3) {
        watchdogHiddenExtendCount++;
        armPlaybackWatchdog(videoId, playbackToken);
        return;
      }
    } else if (activePlayerProvider === "soundcloud") {
      if (scIsPlaying) return;
      if (document.hidden && watchdogHiddenExtendCount < 2) {
        watchdogHiddenExtendCount++;
        armPlaybackWatchdog(videoId, playbackToken);
        return;
      }
    } else if (activePlayerProvider === "tiktok") {
      if (tiktokIsPlaying) return;
      if (document.hidden && watchdogHiddenExtendCount < 2) {
        watchdogHiddenExtendCount++;
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

// ---- Playback Reconciler ---------------------------------------------------
let reconcileMismatchCount = 0;
let reconcileLastExpectedToken = null;

function stopAllPlayersExcept(exceptProvider) {
  if (exceptProvider !== "youtube" && player?.stopVideo) {
    try { player.stopVideo(); } catch {}
  }
  if (exceptProvider !== "spotify" && spotifyPlayer?.pause) {
    try { spotifyPlayer.pause().catch(() => {}); } catch {}
  }
  if (exceptProvider !== "soundcloud" && scWidget?.pause) {
    try { scWidget.pause(); } catch {}
  }
  if (exceptProvider !== "tiktok" && tiktokAudio) {
    try {
      tiktokAudio.pause();
      tiktokAudio.removeAttribute("src");
      tiktokAudio.load();
    } catch {}
  }
}

function reconcilePlayback() {
  if (!started || !latestState?.nowPlaying) {
    reconcileMismatchCount = 0;
    return;
  }
  const np = latestState.nowPlaying;
  const expected = {
    provider: (np.provider || "youtube").toLowerCase(),
    videoId: np.videoId,
    playbackToken: np.playbackToken || null,
  };

  if (expected.playbackToken !== reconcileLastExpectedToken) {
    reconcileMismatchCount = 0;
    reconcileLastExpectedToken = expected.playbackToken;
  }

  let actual = {
    provider: activePlayerProvider || expected.provider,
    activeProvider: activePlayerProvider || expected.provider,
    videoId: null,
    playbackToken: null,
  };

  if (expected.provider === "youtube") {
    if (player && player.getVideoData) {
      actual.videoId = player.getVideoData()?.video_id || null;
    }
  } else if (expected.provider === "spotify") {
    // If Spotify is currently actively loading a new track, skip reconcile check
    if (isSpotifyLoadingTrack) {
      return;
    }
    if (spotifyPlayerState?.track_window?.current_track) {
      const curTrack = spotifyPlayerState.track_window.current_track;
      actual.videoId = (curTrack.id || "").replace(/^spotify:track:/, "") || null;
      if (curTrack.uri) {
        actual.uri = curTrack.uri;
      }
      if (curTrack.linked_from?.id) {
        actual.linkedFromId = (curTrack.linked_from.id || "").replace(/^spotify:track:/, "");
      }
      if (curTrack.linked_from?.uri) {
        actual.linkedFromUri = curTrack.linked_from.uri;
      }
    }
  } else if (expected.provider === "tiktok") {
    if (tiktokAudio) {
      actual.playbackToken = tiktokAudio.dataset.playbackToken || null;
      actual.videoId = currentVideoId;
    }
  } else if (expected.provider === "soundcloud") {
    actual.videoId = currentVideoId;
  }

  const action = window.PlaybackReconciler
    ? window.PlaybackReconciler.decideReconcileAction({
        expected,
        actual,
        mismatchCount: reconcileMismatchCount,
      })
    : "ok";

  if (action !== "ok") {
    console.warn("[reconcile]", { expected, actual, action, mismatchCount: reconcileMismatchCount });
  }

  if (action === "stop_foreign_provider") {
    stopAllPlayersExcept(expected.provider);
  } else if (action === "reload") {
    reconcileMismatchCount++;
    if (expected.provider === "youtube" && player?.loadVideoById) {
      player.loadVideoById(expected.videoId);
    } else if (expected.provider === "tiktok") {
      playTikTok(expected.videoId);
    } else if (expected.provider === "spotify") {
      playSpotify(expected.videoId);
    }
  } else if (action === "stop_and_skip") {
    reconcileMismatchCount = 0;
    stopAllPlayersExcept(null);
    if (currentPlaybackToken && terminalReportedForToken !== currentPlaybackToken) {
      if (send({ type: "error", videoId: expected.videoId, playbackToken: currentPlaybackToken, code: "player_mismatch" })) {
        terminalReportedForToken = currentPlaybackToken;
      }
    }
  } else {
    reconcileMismatchCount = 0;
  }
}

let reconcileInterval = null;
function startPlaybackReconciler() {
  if (reconcileInterval) return;
  reconcileInterval = setInterval(reconcilePlayback, 3000);
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && started) reconcilePlayback();
});
window.addEventListener("focus", () => {
  if (started) reconcilePlayback();
});

// ---- Silent Audio Keeper ---------------------------------------------------
let silentAudioCtx = null;

function initSilentAudioElement() {
  if (typeof Audio === "undefined") return;
  if (silentAudioEl) {
    if (silentAudioEl.paused) {
      silentAudioEl.play().catch(() => {});
    }
    return;
  }
  try {
    silentAudioEl = new Audio("data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA");
    silentAudioEl.loop = true;
    silentAudioEl.volume = 0.001;
    silentAudioEl.play().catch((err) => {
      console.warn("[audio-keeper] silent audio element autoplay blocked:", err);
    });
  } catch (err) {
    console.warn("[audio-keeper] failed to create silent audio element:", err);
  }
}

function initSilentAudioKeeper() {
  initSilentAudioElement();
  if (silentAudioCtx) {
    if (silentAudioCtx.state === "suspended") {
      silentAudioCtx.resume().catch(() => {});
    }
    return;
  }
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    silentAudioCtx = new AudioContextClass();
    silentAudioCtx.onstatechange = () => {
      if (silentAudioCtx && silentAudioCtx.state === "suspended" && started) {
        silentAudioCtx.resume().catch(() => {});
      }
    };
    const osc = silentAudioCtx.createOscillator();
    const gain = silentAudioCtx.createGain();
    gain.gain.value = 0.00001;
    osc.connect(gain);
    gain.connect(silentAudioCtx.destination);
    osc.start();
  } catch (err) {
    console.warn("[audio-keeper] failed to start silent audio context:", err);
  }
}

// ---- Unattended Host & Screen Wake Lock System -----------------------------

async function requestScreenWakeLock() {
  if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return false;
  if (!started || !unattendedModeEnabled) return false;
  try {
    if (screenWakeLock && !screenWakeLock.released) return true;
    isWakeLockRequested = true;
    screenWakeLock = await navigator.wakeLock.request("screen");
    console.log("[unattended] Screen Wake Lock acquired — OS display/CPU sleep prevented.");
    updateUnattendedUI();
    screenWakeLock.addEventListener("release", () => {
      console.log("[unattended] Screen Wake Lock released.");
      screenWakeLock = null;
      updateUnattendedUI();
      if (started && unattendedModeEnabled && isWakeLockRequested && typeof document !== "undefined" && !document.hidden) {
        requestScreenWakeLock().catch(() => {});
      }
    });
    return true;
  } catch (err) {
    console.warn("[unattended] Screen Wake Lock request failed:", err?.message || err);
    updateUnattendedUI();
    return false;
  }
}

function releaseScreenWakeLock() {
  isWakeLockRequested = false;
  if (screenWakeLock) {
    try {
      screenWakeLock.release().catch(() => {});
    } catch {}
    screenWakeLock = null;
  }
  updateUnattendedUI();
}

function updateUnattendedUI() {
  const pill = document.getElementById("unattended-mode-pill");
  if (!pill) return;
  if (!unattendedModeEnabled) {
    pill.classList.remove("on");
    pill.textContent = "⚡ Treo máy: Tắt";
    pill.title = "Chế độ treo máy (Chống tắt màn hình / Wake Lock & Chống đóng băng âm thanh) — nhấp để bật";
    return;
  }
  pill.classList.add("on");
  pill.textContent = "⚡ Treo máy: Bật";
  if (screenWakeLock && !screenWakeLock.released) {
    pill.title = "Chế độ treo máy: Đang bật (Đang giữ màn hình & CPU không ngủ qua Screen Wake Lock, bảo vệ âm thanh mượt mà) — nhấp để tắt";
  } else {
    pill.title = "Chế độ treo máy: Đang bật (Bảo vệ âm thanh liên tục và chống đóng băng tab) — nhấp để tắt";
  }
}

function toggleUnattendedMode() {
  unattendedModeEnabled = !unattendedModeEnabled;
  if (unattendedModeEnabled) {
    if (started) {
      initSilentAudioKeeper();
      initSilentAudioElement();
      startBackgroundWorker();
      holdHostWebLock();
      requestScreenWakeLock().then((ok) => {
        if (ok) {
          setOrderNetworkHostStatus("Đã bật chế độ treo máy (Màn hình & CPU không ngủ)!", "ok");
        } else {
          setOrderNetworkHostStatus("Đã bật chế độ treo máy (Bảo vệ âm thanh mượt mà).", "ok");
        }
      });
    } else {
      setOrderNetworkHostStatus("Đã bật chế độ treo máy — sẽ kích hoạt khi bạn nhấn Bắt đầu.", "ok");
    }
  } else {
    releaseScreenWakeLock();
    stopBackgroundWorker();
    setOrderNetworkHostStatus("Đã tắt chế độ treo máy.", "ok");
  }
  updateUnattendedUI();
}

function holdHostWebLock() {
  if (hostWebLockHeld || !unattendedModeEnabled) return;
  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    hostWebLockHeld = true;
    navigator.locks.request("office-jukebox-host-active", () => {
      return new Promise((resolve) => {
        const check = setInterval(() => {
          if (!started || !unattendedModeEnabled) {
            clearInterval(check);
            hostWebLockHeld = false;
            resolve();
          }
        }, 1000);
      });
    }).catch((err) => {
      hostWebLockHeld = false;
      console.warn("[unattended] navigator.locks error:", err);
    });
  }
}

function startBackgroundWorker() {
  if (!unattendedModeEnabled) return;
  if (backgroundWorker || typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") return;
  try {
    const workerScript = `
      let timer = null;
      self.onmessage = function(e) {
        if (e.data === 'start') {
          if (!timer) {
            timer = setInterval(function() {
              self.postMessage({ type: 'heartbeat', ts: Date.now() });
            }, 1000);
          }
        } else if (e.data === 'stop') {
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
        }
      };
    `;
    const blob = new Blob([workerScript], { type: "application/javascript" });
    const blobUrl = URL.createObjectURL(blob);
    backgroundWorker = new Worker(blobUrl);
    backgroundWorker.onmessage = (e) => {
      if (e.data?.type === "heartbeat") {
        onBackgroundHeartbeat();
      }
    };
    backgroundWorker.postMessage("start");
    console.log("[unattended] Background worker heartbeat active (unthrottled 1s pulse).");
  } catch (err) {
    console.warn("[unattended] Failed to start background worker:", err);
  }
}

function stopBackgroundWorker() {
  if (backgroundWorker) {
    try {
      backgroundWorker.postMessage("stop");
      backgroundWorker.terminate();
    } catch {}
    backgroundWorker = null;
  }
}

function isAnyAudioPlaying() {
  if (activePlayerProvider === "youtube") {
    const ytPlaying = typeof YT !== "undefined" && YT?.PlayerState ? YT.PlayerState.PLAYING : 1;
    return Boolean(playerReady && player?.getPlayerState && player.getPlayerState() === ytPlaying);
  }
  if (activePlayerProvider === "spotify") {
    return Boolean(spotifyPlayerState && !spotifyPlayerState.paused);
  }
  if (activePlayerProvider === "soundcloud") {
    return Boolean(scIsPlaying);
  }
  if (activePlayerProvider === "tiktok") {
    return Boolean(tiktokIsPlaying || (tiktokAudio && !tiktokAudio.paused));
  }
  return false;
}

function onBackgroundHeartbeat() {
  if (!started || !unattendedModeEnabled) return;

  // 1. Silent audio keeper pulse
  if (silentAudioCtx && silentAudioCtx.state === "suspended") {
    silentAudioCtx.resume().catch(() => {});
  }
  if (silentAudioEl && silentAudioEl.paused) {
    silentAudioEl.play().catch(() => {});
  }

  // 2. Screen Wake Lock re-acquisition if released while tab is visible
  if (typeof document !== "undefined" && !document.hidden && isWakeLockRequested && (!screenWakeLock || screenWakeLock.released)) {
    requestScreenWakeLock().catch(() => {});
  }

  // 3. MediaSession playbackState check
  if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
    try {
      const playing = isAnyAudioPlaying();
      const expected = playing ? "playing" : (latestState?.nowPlaying ? "paused" : "none");
      if (navigator.mediaSession.playbackState !== expected) {
        navigator.mediaSession.playbackState = expected;
      }
    } catch {}
  }

  // 4. Fallback check for YouTube end-of-track in background
  if (activePlayerProvider === "youtube" && playerReady && player?.getCurrentTime && player?.getDuration) {
    try {
      const dur = Number(player.getDuration()) || 0;
      const cur = Number(player.getCurrentTime()) || 0;
      const state = player.getPlayerState ? player.getPlayerState() : -1;
      const ytEndedState = typeof YT !== "undefined" && YT?.PlayerState ? YT.PlayerState.ENDED : 0;
      const ytPausedState = typeof YT !== "undefined" && YT?.PlayerState ? YT.PlayerState.PAUSED : 2;
      const ytBufferingState = typeof YT !== "undefined" && YT?.PlayerState ? YT.PlayerState.BUFFERING : 3;
      const nearEnd = dur > 0 && cur >= Math.max(1, dur - 0.5);
      if (nearEnd) {
        const isPausedOrEndedOrStuck =
          state === ytPausedState ||
          state === ytEndedState ||
          state === ytBufferingState ||
          state === -1;
        if (isPausedOrEndedOrStuck) {
          console.log(`[unattended] YouTube reached end of track in background (${cur.toFixed(1)}s / ${dur.toFixed(1)}s) — reporting ended`);
          stopYouTubeSync();
          reportIfEnded();
        }
      }
    } catch (e) {
      console.warn("[unattended] error checking YouTube state:", e);
    }
  }

  // 5. Fallback check for Spotify loading or stalled in background
  if (activePlayerProvider === "spotify" && latestState?.nowPlaying?.videoId === currentVideoId) {
    if (spotifyPlayer && (isSpotifyLoadingTrack || isSpotifyAutoplayBlocked || (spotifyPlayerState?.paused && !spotifyWasPlaying))) {
      const elapsedSincePlay = performance.now() - spotifyAnchorTime;
      if (elapsedSincePlay > 4000) {
        console.log(`[unattended] Spotify track pending in background for ${Math.round(elapsedSincePlay)}ms — attempting resume`);
        if (spotifyPlayer.activateElement) {
          spotifyPlayer.activateElement().catch(() => {});
        }
        spotifyPlayer.resume().catch(() => {});
      }
    }
  }

  // 6. Fallback check for TikTok audio stalled in background
  if (activePlayerProvider === "tiktok" && tiktokAudio && !tiktokAudio.paused) {
    if (tiktokAudio.duration > 0 && tiktokAudio.currentTime >= tiktokAudio.duration - 0.5) {
      console.log("[unattended] TikTok reached end in background — triggering ended");
      tiktokAudio.pause();
      const token = tiktokAudio.dataset.playbackToken;
      if (token && terminalReportedForToken !== token) {
        terminalReportedForToken = token;
        send({
          type: "ended",
          videoId: currentVideoId,
          playbackToken: token,
          playedSeconds: tiktokAudio.currentTime || null,
        });
      }
    }
  }

  // 7. Watchdog progress verification
  checkUnattendedProgress();
}

function checkUnattendedProgress() {
  const np = latestState?.nowPlaying;
  if (!np || !started || !unattendedModeEnabled) {
    lastUnattendedTrackId = null;
    lastUnattendedPosition = -1;
    unattendedStallRecoveryCount = 0;
    return;
  }

  if (lastUnattendedTrackId !== np.videoId) {
    lastUnattendedTrackId = np.videoId;
    lastUnattendedPosition = -1;
    lastUnattendedProgressTimestamp = Date.now();
    unattendedStallRecoveryCount = 0;
    return;
  }

  let curPos = -1;
  let isPlaying = false;
  if (activePlayerProvider === "youtube" && playerReady && player?.getCurrentTime) {
    try {
      curPos = Number(player.getCurrentTime()) || 0;
      const ytPlaying = typeof YT !== "undefined" && YT?.PlayerState ? YT.PlayerState.PLAYING : 1;
      isPlaying = player.getPlayerState?.() === ytPlaying;
    } catch {}
  } else if (activePlayerProvider === "spotify") {
    curPos = (spotifyPlayerState?.position || 0) / 1000;
    isPlaying = Boolean(spotifyPlayerState && !spotifyPlayerState.paused);
  } else if (activePlayerProvider === "tiktok" && tiktokAudio) {
    curPos = Number(tiktokAudio.currentTime) || 0;
    isPlaying = !tiktokAudio.paused;
  } else if (activePlayerProvider === "soundcloud") {
    curPos = scCurrentPosition / 1000;
    isPlaying = scIsPlaying;
  }

  if (curPos > lastUnattendedPosition + 0.2) {
    lastUnattendedPosition = curPos;
    lastUnattendedProgressTimestamp = Date.now();
    unattendedStallRecoveryCount = 0;
    return;
  }

  const stallDuration = Date.now() - lastUnattendedProgressTimestamp;
  if (stallDuration > 25000 && unattendedStallRecoveryCount < 3) {
    unattendedStallRecoveryCount++;
    lastUnattendedProgressTimestamp = Date.now();
    console.warn(`[unattended] Playback stalled for 25s on ${np.videoId} (${activePlayerProvider}) — triggering recovery attempt ${unattendedStallRecoveryCount}`);
    if (activePlayerProvider === "youtube") {
      player?.playVideo?.();
    } else if (activePlayerProvider === "spotify") {
      spotifyPlayer?.activateElement?.().catch(() => {});
      spotifyPlayer?.resume?.().catch(() => {});
    } else if (activePlayerProvider === "tiktok") {
      tiktokAudio?.play?.().catch(() => {});
    }
    if (unattendedStallRecoveryCount >= 2) {
      reconcilePlayback();
    }
  }
}

if (typeof navigator !== "undefined" && navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    console.log("[unattended] Audio output device changed — re-activating audio sinks");
    if (silentAudioCtx && silentAudioCtx.state === "suspended") {
      silentAudioCtx.resume().catch(() => {});
    }
    if (silentAudioEl && silentAudioEl.paused) {
      silentAudioEl.play().catch(() => {});
    }
    if (spotifyPlayer?.activateElement) {
      spotifyPlayer.activateElement().catch(() => {});
    }
  });
}

// ---- Media Session API -----------------------------------------------------
function updateMediaSession(np) {
  if (!("mediaSession" in navigator)) return;
  if (!np) {
    navigator.mediaSession.metadata = null;
    try { navigator.mediaSession.playbackState = "none"; } catch {}
    return;
  }
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: np.title || "Office Jukebox",
      artist: np.channel || "",
      artwork: np.thumbnail ? [{ src: np.thumbnail, sizes: "512x512", type: "image/jpeg" }] : [],
    });
    navigator.mediaSession.playbackState = "playing";
    navigator.mediaSession.setActionHandler("play", () => {
      document.getElementById("playpause")?.click();
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      document.getElementById("playpause")?.click();
    });
    navigator.mediaSession.setActionHandler("nexttrack", () => {
      document.getElementById("skip")?.click();
    });
  } catch (e) {
    console.warn("[media-session] Error setting metadata:", e);
  }
}

window.addEventListener("pageshow", (e) => {
  if (!e.persisted) return;
  clearTimeout(playbackWatchdog);
  releaseScreenWakeLock();
  stopBackgroundWorker();
  updateUnattendedUI();
  if (playbackEventHandlers && player?.removeEventListener) {
    player.removeEventListener("onStateChange", playbackEventHandlers.onStateChange);
    player.removeEventListener("onError", playbackEventHandlers.onError);
  }
  playbackEventHandlers = null;
  if (silentAudioCtx && silentAudioCtx.state === "suspended") {
    silentAudioCtx.resume().catch(() => {});
  }
  started = false;
  currentVideoId = null;
  currentPlaybackToken = null;
  terminalReportedForToken = null;
  spotifyWasPlaying = false;
  spotifyCurrentlyPlayingTrackId = null;
  scIsPlaying = false;
  tiktokIsPlaying = false;
  if (tiktokAudio) { try { tiktokAudio.pause(); } catch {} }
  hidePlaybackRecovery();
  document.getElementById("start-overlay").classList.remove("hidden");
  document.getElementById("stage").classList.add("hidden");
});

window.addEventListener("pagehide", () => {
  releaseScreenWakeLock();
  stopBackgroundWorker();
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
  if (track.textContent === text && el.classList.contains("marquee-title")) {
    return;
  }
  track.textContent = text;
  el.classList.add("marquee-title");
  requestAnimationFrame(() => {
    if (!track.isConnected) return;
    const distance = el.clientWidth - track.scrollWidth;
    const overflowing = distance < -1;
    el.classList.toggle("is-overflowing", overflowing);
    el.style.setProperty("--marquee-distance", `${Math.min(0, distance)}px`);
    if (overflowing) el.title = text;
    else el.removeAttribute("title");
  });
}

let resizeDebounceTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeDebounceTimer);
  resizeDebounceTimer = setTimeout(() => {
    document.querySelectorAll(".marquee-title").forEach(updateMarqueeTitle);
  }, 150);
});

function getPlatformIconBadge(provider) {
  if (provider === "spotify") {
    return `<span class="platform-icon-badge spotify" title="Spotify" aria-label="Spotify"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg></span>`;
  }
  if (provider === "soundcloud") {
    return `<span class="platform-icon-badge soundcloud" title="SoundCloud" aria-label="SoundCloud"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M11.56 8.87V17h8.79a3.65 3.65 0 0 0 3.65-3.65c0-1.89-1.42-3.44-3.26-3.62a4.99 4.99 0 0 0-4.93-4.14 5.06 5.06 0 0 0-4.25 2.28zm-1.42.92v7.21h.71V9.79zm-1.42 1.34v5.87h.71v-5.87zm-1.42 1.05v4.82h.71V12.18zm-1.42.95v3.87h.71v-3.87zm-1.42 1.05v2.82h.71v-2.82zm-1.42.94v1.88h.71v-1.88zm-1.42.47v1.41h.71V16.4zm-1.42.47v.94h.71v-.94z"/></svg></span>`;
  }
  if (provider === "tiktok") {
    return `<span class="platform-icon-badge tiktok" title="TikTok" aria-label="TikTok"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64c.29 0 .58.04.86.12V9.42a6.34 6.34 0 0 0-6.61 6.32 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.34-6.34V9.08a8.28 8.28 0 0 0 4.82 1.54V7.17a4.85 4.85 0 0 1-1.64-.48z"/></svg></span>`;
  }
  return `<span class="platform-icon-badge youtube" title="YouTube" aria-label="YouTube"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg></span>`;
}

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
    const thumb = `<img class="q-thumb" src="${safeImageUrl(item.thumbnail)}" alt="" referrerpolicy="no-referrer" />`;

    const isPinned = item.pinned === true;
    const voteScore = item.voteScore || 0;
    const providerBadge = getPlatformIconBadge(item.provider);

    li.innerHTML = `
      <span class="q-drag-handle" title="Kéo để sắp xếp" aria-hidden="true">⠿</span>
      ${thumb}
      <div class="q-meta">
        <div class="q-title-row">
          <span class="q-title"></span>
          ${providerBadge}
          ${isPinned ? '<span class="q-pinned-badge" title="Bài do host ghim vị trí">📌 Ghim</span>' : ''}
          ${voteScore > 0 ? `<span class="q-vote-badge" title="${voteScore} lượt vote">❤️ ${voteScore}</span>` : ''}
        </div>
        <div class="q-sub">
          <span class="q-requester-row">
            <span class="q-requester-avatar"></span>
            <span class="q-sub-label"></span>
          </span>
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
      li.querySelector(".q-requester-row")?.append(" ", rank);
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

function renderUserQueueLimit() {
  const btn = document.getElementById("user-queue-limit-toggle");
  if (!btn) return;
  btn.innerHTML = `<span>Mỗi người: ${userQueueLimitOn ? userQueueLimit + " bài" : "Tắt"}</span>`;
  btn.classList.toggle("on", userQueueLimitOn);
}

function setHostTab(tab) {
  hostActiveTab = tab;
  const queueBtn = document.getElementById("tab-btn-queue");
  const histBtn = document.getElementById("tab-btn-history");
  const queuePanel = document.getElementById("queue-panel");
  const histPanel = document.getElementById("host-history-panel");

  if (tab === "history") {
    queueBtn?.classList.remove("active");
    histBtn?.classList.add("active");
    queuePanel?.classList.add("hidden");
    histPanel?.classList.remove("hidden");
    loadHostHistory();
  } else {
    queueBtn?.classList.add("active");
    histBtn?.classList.remove("active");
    queuePanel?.classList.remove("hidden");
    histPanel?.classList.add("hidden");
  }
}

async function loadHostHistory() {
  const listEl = document.getElementById("host-history-list");
  const emptyEl = document.getElementById("host-history-empty");
  const loadingEl = document.getElementById("host-history-loading");
  const countEl = document.getElementById("host-history-count");
  if (!listEl) return;

  hostHistoryLoading = true;
  loadingEl?.classList.remove("hidden");
  emptyEl?.classList.add("hidden");

  try {
    const res = await fetch("/api/history/all?limit=50");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    hostHistoryItems = Array.isArray(data.items) ? data.items : [];
    if (countEl) {
      countEl.textContent = hostHistoryItems.length;
      countEl.classList.toggle("hidden", hostHistoryItems.length === 0);
    }
    renderHostHistory();
  } catch (err) {
    console.error("[host] Không thể tải lịch sử phát:", err);
  } finally {
    hostHistoryLoading = false;
    loadingEl?.classList.add("hidden");
  }
}

function renderHostHistory() {
  const listEl = document.getElementById("host-history-list");
  const emptyEl = document.getElementById("host-history-empty");
  if (!listEl) return;
  listEl.innerHTML = "";

  if (hostHistoryItems.length === 0) {
    emptyEl?.classList.remove("hidden");
    return;
  }
  emptyEl?.classList.add("hidden");

  for (const item of hostHistoryItems) {
    const li = document.createElement("li");
    li.className = "q-item host-history-item";
    const thumb = `<img class="q-thumb" src="${safeImageUrl(item.thumbnail)}" alt="" referrerpolicy="no-referrer" />`;
    const providerBadge = getPlatformIconBadge(item.provider);
    const voteScore = item.voteScore || 0;
    let timeLabel = "";
    if (item.finishedAt) {
      const d = new Date(item.finishedAt);
      if (!isNaN(d.getTime())) {
        timeLabel = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      }
    }

    li.innerHTML = `
      ${thumb}
      <div class="q-meta">
        <div class="q-title-row">
          <span class="q-title"></span>
          ${providerBadge}
          ${voteScore > 0 ? `<span class="q-vote-badge" title="${voteScore} lượt vote">❤️ ${voteScore}</span>` : ''}
        </div>
        <div class="q-sub">
          <span class="q-requester-row">
            <span class="q-requester-avatar"></span>
            <span class="q-sub-label"></span>
          </span>
          ${timeLabel ? `<span class="host-history-time" title="Phát lúc ${timeLabel}">${timeLabel}</span>` : ''}
        </div>
      </div>
    `;

    li.querySelector(".q-title").textContent = item.title;
    updateMarqueeTitle(li.querySelector(".q-title"));
    li.querySelector(".q-sub-label").textContent = item.addedBy ? `Yêu cầu: ${item.addedBy}` : (item.channel || "Không rõ");
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
      li.querySelector(".q-requester-row")?.append(" ", rank);
    }

    listEl.appendChild(li);
  }
}

const PAUSE_SVG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4.5" height="14" rx="1.5"/><rect x="13.5" y="5" width="4.5" height="14" rx="1.5"/></svg>';
const PLAY_SVG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

function updatePlayPauseIcon() {
  const playPauseBtn = document.getElementById("playpause");
  const skipBtn = document.getElementById("skip");
  if (!latestState?.nowPlaying) {
    if (playPauseBtn) {
      playPauseBtn.innerHTML = PLAY_SVG;
      playPauseBtn.disabled = true;
      playPauseBtn.title = "Chưa có bài hát để phát";
    }
    if (skipBtn) {
      skipBtn.disabled = true;
      skipBtn.title = "Chưa có bài hát để bỏ qua";
    }
    updateSpotifyPlayPauseUI(true);
    updateTikTokPlayPauseUI(true);
    return;
  }
  if (playPauseBtn) {
    playPauseBtn.disabled = false;
    playPauseBtn.title = "Phát / Tạm dừng (phím cách)";
  }
  if (skipBtn) {
    skipBtn.disabled = false;
    skipBtn.title = "Bỏ qua (n)";
  }
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
  } else if (activePlayerProvider === "tiktok") {
    playing = tiktokIsPlaying;
    updateTikTokPlayPauseUI(!playing);
  }
  if (playPauseBtn) {
    playPauseBtn.innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
  }
  if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
    try {
      navigator.mediaSession.playbackState = playing ? "playing" : (latestState?.nowPlaying ? "paused" : "none");
    } catch {}
  }
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
      if (spotifyPlayer?.activateElement) {
        spotifyPlayer.activateElement().catch(() => {});
      }
      isSpotifyAutoplayBlocked = false;
      playSpotify(np.videoId);
    } else if (activePlayerProvider === "soundcloud") {
      playSoundCloud(np.videoId);
    } else if (activePlayerProvider === "tiktok") {
      playTikTok(np.videoId);
    }
    armPlaybackWatchdog(np.videoId, currentPlaybackToken);
  };
  document.getElementById("playpause").onclick = () => {
    if (!latestState?.nowPlaying) return;
    if (activePlayerProvider === "youtube") {
      if (!playerReady) return;
      const s = player.getPlayerState();
      if (s === YT.PlayerState.PLAYING) {
        player.pauseVideo();
        stopYouTubeSync();
        broadcastYouTubeTick({ seek: false });
      } else {
        player.playVideo();
        startYouTubeSync();
      }
    } else if (activePlayerProvider === "spotify") {
      if (spotifyPlayer?.togglePlay) spotifyPlayer.togglePlay();
    } else if (activePlayerProvider === "soundcloud") {
      if (scWidget?.toggle) scWidget.toggle();
    } else if (activePlayerProvider === "tiktok") {
      toggleTikTokPlay();
    }
  };
  let isSkipInProgress = false;
  document.getElementById("skip").onclick = () => {
    if (!latestState?.nowPlaying) return;
    if (isSkipInProgress) return;
    isSkipInProgress = true;
    setTimeout(() => { isSkipInProgress = false; }, 600);
    const playedSeconds = getCurrentPlayerTime();
    send({ type: "skip", playedSeconds: Number.isFinite(playedSeconds) ? playedSeconds : null });
  };
  wireSpotifyConnect();
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
  const userQueueLimitBtn = document.getElementById("user-queue-limit-toggle");
  if (userQueueLimitBtn) {
    userQueueLimitBtn.onclick = () => {
      if (!userQueueLimitOn) {
        send({ type: "setUserQueueLimit", on: true, limit: USER_QUEUE_LIMIT_STEPS[0] });
        return;
      }
      const i = USER_QUEUE_LIMIT_STEPS.indexOf(userQueueLimit);
      if (i === -1 || i === USER_QUEUE_LIMIT_STEPS.length - 1) {
        send({ type: "setUserQueueLimit", on: false, limit: userQueueLimit });
      } else {
        send({ type: "setUserQueueLimit", on: true, limit: USER_QUEUE_LIMIT_STEPS[i + 1] });
      }
    };
  }
  document.getElementById("tab-btn-queue")?.addEventListener("click", () => setHostTab("queue"));
  document.getElementById("tab-btn-history")?.addEventListener("click", () => setHostTab("history"));
  wireQrCollapse();
  document.getElementById("require-name-toggle").onclick = () => {
    send({ type: "setRequireName", on: !requireName });
  };
  document.getElementById("order-network-host").onclick = () => {
    registerOrderNetworkHost({ manual: true });
  };
  document.getElementById("vote-sort-toggle").onclick = () => {
    send({ type: "setVoteSort", on: !voteSortOn });
  };
  const unattendedPill = document.getElementById("unattended-mode-pill");
  if (unattendedPill) {
    unattendedPill.onclick = () => {
      toggleUnattendedMode();
    };
  }
  updateUnattendedUI();
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
    if (e.code === "Space") {
      e.preventDefault();
      if (!latestState?.nowPlaying) return;
      document.getElementById("playpause").click();
    }
    if (e.key.toLowerCase() === "n") {
      if (!latestState?.nowPlaying) return;
      document.getElementById("skip").click();
    }
    if (e.key === "ArrowLeft" || e.key.toLowerCase() === "j") {
      e.preventDefault();
      if (!latestState?.nowPlaying) return;
      seekPlayerRelative(-10);
    }
    if (e.key === "ArrowRight" || e.key.toLowerCase() === "l") {
      e.preventDefault();
      if (!latestState?.nowPlaying) return;
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

  const unlockAudioOnGesture = () => {
    if (spotifyPlayer?.activateElement) {
      spotifyPlayer.activateElement().catch(() => {});
    }
    if (silentAudioCtx && silentAudioCtx.state === "suspended") {
      silentAudioCtx.resume().catch(() => {});
    }
    if (silentAudioEl && silentAudioEl.paused) {
      silentAudioEl.play().catch(() => {});
    }
  };
  window.addEventListener("pointerdown", unlockAudioOnGesture, { passive: true });
  window.addEventListener("keydown", unlockAudioOnGesture, { passive: true });

  wireSpotifyInteractiveControls();
}

function wireQrCollapse() {
  const qrCard = document.getElementById("qr-card");
  const toggleBtn = document.getElementById("qr-toggle-btn");
  if (!qrCard || !toggleBtn) return;

  const toggleText = toggleBtn.querySelector(".qr-toggle-text");
  const applyState = (collapsed) => {
    qrCard.classList.toggle("collapsed", collapsed);
    toggleBtn.setAttribute?.("aria-expanded", String(!collapsed));
    toggleBtn.title = collapsed ? "Mở rộng mã QR" : "Thu gọn mã QR";
    if (toggleText) toggleText.textContent = collapsed ? "Hiện QR" : "Thu gọn";
  };

  let saved = false;
  try {
    saved = localStorage.getItem("host_qr_collapsed") === "1";
  } catch (_) {}
  applyState(saved);

  toggleBtn.onclick = () => {
    const isCollapsed = qrCard.classList.contains("collapsed");
    const nextState = !isCollapsed;
    applyState(nextState);
    try {
      localStorage.setItem("host_qr_collapsed", nextState ? "1" : "0");
    } catch (_) {}
  };
}

function seekSpotifyTo(targetSec) {
  if (!spotifyPlayer) return;
  const durSec = spotifyPlayerState?.duration ? spotifyPlayerState.duration / 1000 : 9999;
  const newPos = Math.max(0, Math.min(durSec, targetSec));
  const ms = Math.floor(newPos * 1000);
  isSeekPending = true;
  seekTargetMs = ms;
  spotifyAnchorPos = ms;
  spotifyMaxPositionMs = ms;
  spotifyAnchorTime = performance.now();
  if (spotifyPlayer.seek) {
    spotifyPlayer.seek(ms);
  }
  if (spotifyPlayerState) {
    spotifyPlayerState.position = ms;
    updateSpotifyProgressUI(spotifyPlayerState);
    broadcastSpotifyTick({ seek: true });
  }
  setTimeout(() => {
    isSeekPending = false;
  }, 2000);
}

function seekSpotifyRelative(deltaSec) {
  if (!spotifyPlayer || !spotifyPlayerState?.duration) return;
  const curPos = getInterpolatedSpotifyPosition() / 1000;
  const durSec = spotifyPlayerState.duration / 1000;
  const newPos = Math.max(0, Math.min(durSec - 1, curPos + deltaSec));
  seekSpotifyTo(newPos);
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
      broadcastYouTubeTick({ seek: true });
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
      if (!latestState?.nowPlaying) return;
      if (spotifyPlayer?.togglePlay) {
        spotifyPlayer.togglePlay();
        if (spotifyPlayerState) {
          spotifyPlayerState.paused = !spotifyPlayerState.paused;
          updateSpotifyPlayPauseUI(spotifyPlayerState.paused);
          if (spotifyPlayerState.paused) {
            spotifyAnchorPos = getInterpolatedSpotifyPosition();
            spotifyAnchorTime = performance.now();
            stopSpotifySync();
          } else {
            spotifyAnchorTime = performance.now();
            startSpotifySync();
          }
          broadcastSpotifyTick({ seek: true });
        }
      }
    };
  }

  // Clicking artwork or center play button toggles play/pause
  const artCenter = document.getElementById("spotify-art-center");
  if (artCenter) {
    artCenter.onclick = () => {
      if (!latestState?.nowPlaying) return;
      if (spotifyPlayer?.togglePlay) {
        spotifyPlayer.togglePlay();
        if (spotifyPlayerState) {
          spotifyPlayerState.paused = !spotifyPlayerState.paused;
          updateSpotifyPlayPauseUI(spotifyPlayerState.paused);
          if (spotifyPlayerState.paused) {
            spotifyAnchorPos = getInterpolatedSpotifyPosition();
            spotifyAnchorTime = performance.now();
            stopSpotifySync();
          } else {
            spotifyAnchorTime = performance.now();
            startSpotifySync();
          }
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
      e.preventDefault();
      e.stopPropagation();
      btnLyrics.blur();
      toggleLyricsMode();
    };
  }

  const btnLyricsClose = document.getElementById("spotify-lyrics-close");
  if (btnLyricsClose) {
    btnLyricsClose.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      btnLyricsClose.blur();
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
    userQueueLimitOn = !!info.userQueueLimitOn;
    if (typeof info.userQueueLimit === "number") userQueueLimit = info.userQueueLimit;
    requireName = !!info.requireName;
    renderFilter();
    renderQueueLimit();
    renderUserQueueLimit();
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
  initSilentAudioKeeper();
  initSilentAudioElement();
  if (spotifyPlayer?.activateElement) {
    spotifyPlayer.activateElement().catch(() => {});
  }
  if (unattendedModeEnabled) {
    requestScreenWakeLock();
    startBackgroundWorker();
    holdHostWebLock();
  }
  updateUnattendedUI();
  if (hostCoordinationChannel) {
    hostCoordinationChannel.postMessage({ type: "host_claimed_playback", tabId: myTabId });
  }
  document.getElementById("start-overlay").classList.add("hidden");
  document.getElementById("stage").classList.remove("hidden");
  registerOrderNetworkHost();
  startOrderNetworkHostRefresh();
  startPlaybackReconciler();
  currentVideoId = null;
  currentPlaybackToken = null;
  syncPlayer();
};

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    if (started && unattendedModeEnabled) {
      requestScreenWakeLock();
    }
    if (silentAudioCtx && silentAudioCtx.state === "suspended") {
      silentAudioCtx.resume().catch(() => {});
    }
    if (silentAudioEl && silentAudioEl.paused) {
      silentAudioEl.play().catch(() => {});
    }
    if (started) reconcilePlayback();
    if (activePlayerProvider === "spotify") {
      if (spotifyPlayer?.activateElement) {
        spotifyPlayer.activateElement().catch(() => {});
      }
      if (started && latestState?.nowPlaying?.videoId === currentVideoId) {
        if (!spotifyWasPlaying || spotifyPlayerState?.paused || isSpotifyAutoplayBlocked || isSpotifyLoadingTrack) {
          console.log("[spotify] Tab returned to foreground — resuming Spotify playback...");
          isSpotifyAutoplayBlocked = false;
          spotifyPlayer?.resume?.().catch(() => {});
        }
      }
      reAnchorFromSdk();
      broadcastSpotifyTick({ seek: true });
    }
  }
});

window.addEventListener("offline", () => {
  console.warn("[network] Trình duyệt mất kết nối mạng (offline)");
  if (activePlayerProvider === "spotify") {
    const curPos = getInterpolatedSpotifyPosition();
    if (curPos > 0) {
      spotifyAnchorPos = Math.floor(curPos);
      spotifyAnchorTime = performance.now();
    }
    stopSpotifySync();
  }
});

window.addEventListener("online", () => {
  console.log("[network] Trình duyệt đã kết nối mạng trở lại (online)");
  if (!started || !latestState?.nowPlaying) return;

  if (activePlayerProvider === "spotify" && latestState.nowPlaying.videoId === currentVideoId) {
    if (spotifyReady && spotifyDeviceId) {
      if (!spotifyPlayerState || spotifyPlayerState.paused) {
        const resumePosMs = Math.max(0, Math.floor(spotifyAnchorPos || spotifyPlayerState?.position || 0));
        playSpotify(currentVideoId, resumePosMs);
      }
    } else if (spotifyPlayer?.connect) {
      spotifyPlayer.connect();
    }
  } else if (activePlayerProvider === "tiktok" && latestState.nowPlaying.videoId === currentVideoId) {
    if (tiktokAudio && (tiktokAudio.paused || tiktokAudio.error)) {
      const resumeSec = tiktokAudio.currentTime || tiktokResumeTime || 0;
      playTikTok(currentVideoId, resumeSec);
    }
  } else if (activePlayerProvider === "youtube" && playerReady && player?.getPlayerState) {
    const s = player.getPlayerState();
    if (s === YT.PlayerState.PAUSED || s === -1) {
      player.playVideo();
    }
  } else if (activePlayerProvider === "soundcloud" && scWidget?.play) {
    if (!scIsPlaying) {
      try { scWidget.play(); } catch {}
    }
  }
});

loadInfo();
wireControls();
wireQueueDrag();
connectWs();
initSoundCloudWidget();
