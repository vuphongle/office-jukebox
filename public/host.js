// Host projector page: control the YouTube player from the server queue and
// report playback events so the server can advance to the next song.

let player = null;
let playerReady = false;
let started = false;
let currentVideoId = null;
let latestState = { nowPlaying: null, queue: [] };
let filterOn = false;
let moderationMode = "default"; // "default" | "strict" (protocol values)
let moderationConfigured = false;
let cooldownSeconds = 15;
let eventContext = "";
let queueLimitOn = false;
let queueLimit = 10;
let requireName = false;
let voteSortOn = true;
let hostToken = null; // WebSocket control token (only issued to authenticated hosts)
let ws = null;
let draggedQueueId = null;
let playerLoadStartedAt = 0;
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

// If a song ends while the WebSocket is disconnected, the "ended" message may
// be lost and the server may keep it as the current song; resync on reconnect.
function reportIfEnded() {
  if (playerReady && currentVideoId && player.getPlayerState && player.getPlayerState() === YT.PlayerState.ENDED) {
    send({ type: "ended", videoId: currentVideoId });
  }
}

function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${proto}://${location.host}`);
  ws = socket;
  socket.onopen = () => {
    sendAuth(); // re-authenticate after every connection/reconnection
    reportIfEnded();
  };
  socket.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
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
        if (e.data === YT.PlayerState.ENDED) {
          // A load transition can deliver a late ENDED event from the previous
          // video. Ignore that transient callback instead of advancing the
          // newly selected queue item.
          const eventVideoId = e.target?.getVideoData?.()?.video_id;
          if (Date.now() - playerLoadStartedAt >= 1000 && (!eventVideoId || eventVideoId === currentVideoId)) {
            send({ type: "ended", videoId: currentVideoId });
          }
        }
        if (e.data === YT.PlayerState.PLAYING) {
          clearTimeout(playbackWatchdog);
          hidePlaybackRecovery();
        }
        updatePlayPauseIcon();
      },
      // Some browser profiles do not allow audio when the first song arrives
      // after the Start button click. YouTube reports this separately; request a new
      // user gesture instead of leaving the server stuck on the current song.
      onAutoplayBlocked: () => showPlaybackRecovery(),
      onError: (e) => {
        // 101/150 = owner disallows embedding; 100 = removed; 2 = invalid code.
        const eventVideoId = e.target?.getVideoData?.()?.video_id;
        if (eventVideoId && eventVideoId !== currentVideoId) return;
        console.warn("Player error", e.data, "for", currentVideoId);
        send({ type: "error", videoId: currentVideoId, code: e.data });
      },
    },
  });
};

// Synchronize the player with the song the server reports as current.
function syncPlayer() {
  if (!started || !playerReady) return;
  const np = latestState.nowPlaying;
  const idle = document.getElementById("idle");

  if (!np) {
    clearTimeout(playbackWatchdog);
    currentVideoId = null;
    playerLoadStartedAt = 0;
    if (player.stopVideo) player.stopVideo();
    hidePlaybackRecovery();
    idle.classList.remove("hidden");
    return;
  }
  idle.classList.add("hidden");
  if (np.videoId !== currentVideoId) {
    currentVideoId = np.videoId;
    playerLoadStartedAt = Date.now();
    player.loadVideoById(np.videoId);
    player.playVideo();
    armPlaybackWatchdog(np.videoId);
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

function armPlaybackWatchdog(videoId) {
  clearTimeout(playbackWatchdog);
  playbackWatchdog = setTimeout(() => {
    if (currentVideoId !== videoId || !playerReady) return;
    const t = player.getCurrentTime ? player.getCurrentTime() : 0;
    const s = player.getPlayerState ? player.getPlayerState() : -1;
    if (t >= 1 || s === YT.PlayerState.PLAYING || s === YT.PlayerState.PAUSED) return;
    // A hidden tab cannot be the projector: the browser blocks autoplay and the
    // player remains UNSTARTED. Reporting that as an error would skip the song
    // for everyone. BUFFERING likewise means only that the network is slow. In
    // both cases, wait through another watchdog cycle instead of skipping.
    if (document.hidden || s === YT.PlayerState.BUFFERING) {
      armPlaybackWatchdog(videoId);
      return;
    }
    console.warn(`[watchdog] ${videoId} has not started (state ${s}) — skipping`);
    send({ type: "error", videoId, code: "watchdog" });
  }, 20000);
}

// A page restored from the back-forward cache may lose autoplay permission:
// playVideo() fails silently, the player never starts, and the watchdog would
// skip every song. Stop player control and require another Start button click.
window.addEventListener("pageshow", (e) => {
  if (!e.persisted) return;
  clearTimeout(playbackWatchdog);
  started = false;
  currentVideoId = null;
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

    li.innerHTML = `
      <span class="q-drag-handle" title="Kéo để sắp xếp" aria-hidden="true">⠿</span>
      ${thumb}
      <div class="q-meta">
        <div class="q-title-row">
          <div class="q-title"></div>
          ${isPinned ? '<span class="q-pinned-badge" title="Bài do host ghim vị trí">📌 Ghim</span>' : ''}
          ${voteScore > 0 ? `<span class="q-vote-badge" title="${voteScore} lượt vote">❤️ ${voteScore}</span>` : ''}
        </div>
        <div class="q-sub">
          <span class="q-sub-label"></span>
        </div>
      </div>
      ${isPinned ? '<button class="q-unpin" title="Bỏ ghim">✕ Ghim</button>' : ''}
      <button class="q-remove" title="Xóa">✕</button>`;
    li.querySelector(".q-title").textContent = item.title;
    updateMarqueeTitle(li.querySelector(".q-title"));
    li.querySelector(".q-sub-label").textContent = item.addedBy ? `Yêu cầu: ${item.addedBy}` : item.channel;
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
  if (!playerReady) return;
  const playing = player.getPlayerState && player.getPlayerState() === YT.PlayerState.PLAYING;
  document.getElementById("playpause").innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
}

// ---- Controls --------------------------------------------------------------
function wireControls() {
  document.getElementById("resume-playback").onclick = () => {
    const np = latestState.nowPlaying;
    if (!playerReady || !np) return;
    hidePlaybackRecovery();
    currentVideoId = np.videoId;
    // Repeat both load and play inside the click handler. The previous load may
    // have been fully blocked by the browser.
    player.loadVideoById(np.videoId);
    player.playVideo();
    armPlaybackWatchdog(np.videoId);
  };
  document.getElementById("playpause").onclick = () => {
    if (!playerReady) return;
    const s = player.getPlayerState();
    if (s === YT.PlayerState.PLAYING) player.pauseVideo();
    else player.playVideo();
  };
  document.getElementById("skip").onclick = () => {
    const playedSeconds = playerReady && player?.getCurrentTime ? Number(player.getCurrentTime()) : null;
    send({ type: "skip", playedSeconds: Number.isFinite(playedSeconds) ? playedSeconds : null });
  };
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
  });
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
  } catch (err) {
    document.getElementById("guest-url").textContent = "Không thể tải liên kết dành cho khách";
  }
  try {
    // The browser reuses this page's Basic Auth credentials for the request.
    hostToken = (await (await fetch("/api/host-token")).json()).token || null;
    sendAuth(); // the WebSocket may have connected before the token arrived
  } catch {
    /* no password or offline — controls remain available or inactive */
  }
}

document.getElementById("start-btn").onclick = () => {
  started = true;
  document.getElementById("start-overlay").classList.add("hidden");
  document.getElementById("stage").classList.remove("hidden");
  syncPlayer();
};

loadInfo();
wireControls();
wireQueueDrag();
connectWs();
