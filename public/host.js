// Trang host (máy chiếu): điều khiển trình phát YouTube theo hàng đợi từ máy chủ
// và gửi sự kiện phát lại để máy chủ chuyển sang bài tiếp theo.

let player = null;
let playerReady = false;
let started = false;
let currentVideoId = null;
let latestState = { nowPlaying: null, queue: [] };
let filterOn = false;
let moderationMode = "default"; // "default" | "strict" (các giá trị giao thức)
let moderationConfigured = false;
let cooldownSeconds = 15;
let eventContext = "";
let queueLimitOn = false;
let queueLimit = 10;
let requireName = false;
let hostToken = null; // mã điều khiển WS (chỉ cấp cho trang host đã xác thực)
let ws = null;
let draggedQueueId = null;

// ---- Kết nối WebSocket ------------------------------------------------
function sendAuth() {
  if (hostToken && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "auth", token: hostToken }));
}

// Nếu bài hát kết thúc khi WS bị ngắt, thông điệp "ended" có thể bị mất
// và máy chủ vẫn nghĩ bài đang phát — đồng bộ lại khi kết nối lại.
function reportIfEnded() {
  if (playerReady && currentVideoId && player.getPlayerState && player.getPlayerState() === YT.PlayerState.ENDED) {
    send({ type: "ended", videoId: currentVideoId });
  }
}

function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    sendAuth(); // xác thực lại sau mỗi lần kết nối/kết nối lại
    reportIfEnded();
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "state") {
      latestState = msg.state;
      if (typeof msg.filterOn === "boolean") filterOn = msg.filterOn;
      if (typeof msg.moderationMode === "string") moderationMode = msg.moderationMode;
      if (typeof msg.cooldownSeconds === "number") cooldownSeconds = msg.cooldownSeconds;
      if (typeof msg.eventContext === "string") eventContext = msg.eventContext;
      if (typeof msg.queueLimitOn === "boolean") queueLimitOn = msg.queueLimitOn;
      if (typeof msg.queueLimit === "number") queueLimit = msg.queueLimit;
      if (typeof msg.requireName === "boolean") requireName = msg.requireName;
      render();
      renderFilter();
      renderCooldown();
      renderContext();
      renderQueueLimit();
      renderRequireName();
      syncPlayer();
    }
  };
  ws.onclose = () => setTimeout(connectWs, 1500); // tự động kết nối lại
}
function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// ---- Kéo-thả hàng đợi -------------------------------------------------
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

// ---- API IFrame YouTube ----------------------------------------------
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
          send({ type: "ended", videoId: currentVideoId });
        }
        updatePlayPauseIcon();
      },
      onError: (e) => {
        // 101/150 = chủ sở hữu không cho phép nhúng; 100 = đã gỡ; 2 = mã không hợp lệ.
        console.warn("Lỗi trình phát", e.data, "ở", currentVideoId);
        send({ type: "error", videoId: currentVideoId, code: e.data });
      },
    },
  });
};

// Đồng bộ trình phát theo bài mà máy chủ đang báo là đang phát.
function syncPlayer() {
  if (!started || !playerReady) return;
  const np = latestState.nowPlaying;
  const idle = document.getElementById("idle");

  if (!np) {
    currentVideoId = null;
    if (player.stopVideo) player.stopVideo();
    idle.classList.remove("hidden");
    return;
  }
  idle.classList.add("hidden");
  if (np.videoId !== currentVideoId) {
    currentVideoId = np.videoId;
    player.loadVideoById(np.videoId);
    player.playVideo();
    armPlaybackWatchdog(np.videoId);
  }
}

// Một số video nhúng lỗi chỉ hiển thị khung đen mà không phát sinh onError. Nếu
// video vừa tải không bắt đầu phát sau 20 giây (và không chỉ đang tạm dừng),
// báo lỗi để máy chủ bỏ qua và chuyển sang bài tiếp theo.
let playbackWatchdog = null;
function armPlaybackWatchdog(videoId) {
  clearTimeout(playbackWatchdog);
  playbackWatchdog = setTimeout(() => {
    if (currentVideoId !== videoId || !playerReady) return;
    const t = player.getCurrentTime ? player.getCurrentTime() : 0;
    const s = player.getPlayerState ? player.getPlayerState() : -1;
    if (t >= 1 || s === YT.PlayerState.PLAYING || s === YT.PlayerState.PAUSED) return;
    // Tab bị ẩn không thể là màn hình máy chiếu — trình duyệt chặn tự động phát,
    // nên trình phát sẽ ở trạng thái UNSTARTED mãi. Báo lỗi khi đó sẽ khiến mọi
    // người bỏ qua bài hát. Tương tự, BUFFERING chỉ có nghĩa là mạng chậm.
    // Trong cả hai trường hợp, chờ thêm một vòng thay vì bỏ qua.
    if (document.hidden || s === YT.PlayerState.BUFFERING) {
      armPlaybackWatchdog(videoId);
      return;
    }
    console.warn(`[giám sát] ${videoId} chưa bắt đầu (trạng thái ${s}) — bỏ qua`);
    send({ type: "error", videoId, code: "watchdog" });
  }, 20000);
}

// Trang được khôi phục từ bộ nhớ đệm back-forward đã mất quyền tự động phát:
// playVideo() âm thầm thất bại, trình phát không bao giờ bắt đầu và bộ giám sát
// sẽ bỏ qua mọi bài hát. Dừng điều khiển trình phát và yêu cầu nhấp Bắt đầu lại.
window.addEventListener("pageshow", (e) => {
  if (!e.persisted) return;
  clearTimeout(playbackWatchdog);
  started = false;
  currentVideoId = null;
  document.getElementById("start-overlay").classList.remove("hidden");
  document.getElementById("stage").classList.add("hidden");
});

// ---- Hiển thị ---------------------------------------------------------
function render() {
  const np = latestState.nowPlaying;
  document.getElementById("now-label").classList.toggle("hidden", !np);
  document.getElementById("now-title").textContent = np ? np.title : "—";
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
    const thumb = item.thumbnail
      ? `<img src="${item.thumbnail}" alt="" />`
      : '<img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E" alt="" />';
    li.innerHTML = `
      <span class="q-drag-handle" title="Kéo để sắp xếp" aria-hidden="true">⠿</span>
      ${thumb}
      <div class="q-meta">
        <div class="q-title"></div>
        <div class="q-sub"></div>
      </div>
      <button class="q-remove" title="Xóa">✕</button>`;
    li.querySelector(".q-title").textContent = item.title;
    li.querySelector(".q-sub").textContent = item.addedBy ? `Yêu cầu: ${item.addedBy}` : item.channel;
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
  // Cảnh báo khi bộ lọc bật nhưng chưa cấu hình khóa LLM (bộ lọc sẽ chấp nhận tất cả).
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
  // Không ghi đè nội dung host đang nhập bằng dữ liệu phát lại từ máy chủ.
  if (document.activeElement !== input) input.value = eventContext;
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

// ---- Điều khiển -------------------------------------------------------
function wireControls() {
  document.getElementById("playpause").onclick = () => {
    if (!playerReady) return;
    const s = player.getPlayerState();
    if (s === YT.PlayerState.PLAYING) player.pauseVideo();
    else player.playVideo();
  };
  document.getElementById("skip").onclick = () => send({ type: "skip" });
  // Nút bộ lọc chuyển vòng: Tắt → Bật (bình thường) → Nghiêm ngặt (chỉ nội dung phù hợp với gia đình) → Tắt.
  document.getElementById("filter-toggle").onclick = () => {
    if (!filterOn) send({ type: "setFilter", on: true, mode: "default" });
    else if (moderationMode !== "strict") send({ type: "setFilter", on: true, mode: "strict" });
    else send({ type: "setFilter", on: false, mode: "default" });
  };
  // Chuyển qua các mốc thời gian chờ có sẵn; máy chủ gửi lại giá trị qua trạng thái.
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
  const volEl = document.getElementById("volume");
  const paintVol = () => volEl.style.setProperty("--vol", `${volEl.value}%`);
  paintVol();
  volEl.oninput = () => {
    paintVol();
    if (playerReady) player.setVolume(parseInt(volEl.value, 10));
  };
  // Trình chỉnh sửa bối cảnh sự kiện: nút Bối cảnh hiện ô nhập; nút Lưu gửi nội dung.
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
    if (e.target.tagName === "INPUT") return; // đang nhập trong ô bối cảnh
    if (e.code === "Space") { e.preventDefault(); document.getElementById("playpause").click(); }
    if (e.key.toLowerCase() === "n") document.getElementById("skip").click();
  });
}

// ---- Khởi tạo ---------------------------------------------------------
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
    // Trình duyệt dùng lại thông tin xác thực Basic Auth của trang cho yêu cầu này.
    hostToken = (await (await fetch("/api/host-token")).json()).token || null;
    sendAuth(); // WS có thể đã kết nối trước khi nhận được mã
  } catch {
    /* không dùng mật khẩu hoặc đang ngoại tuyến — các nút vẫn mở hoặc không hoạt động */
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
