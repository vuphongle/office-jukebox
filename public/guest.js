let currentUser = null;
let currentActiveDrop = null;
let rankBenefits = [];
let rankBenefitsPromise = null;

async function loadRankBenefits() {
  if (rankBenefitsPromise) return rankBenefitsPromise;
  rankBenefitsPromise = fetch("/api/rank/benefits")
    .then((response) => response.json())
    .then((data) => {
      rankBenefits = data.ok && Array.isArray(data.benefits) ? data.benefits.slice(0, 6) : [];
      return rankBenefits;
    })
    .catch(() => {
      rankBenefitsPromise = null;
      return [];
    });
  return rankBenefitsPromise;
}

function renderRankBenefits(containerId, currentRank = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!rankBenefits.length) {
    container.innerHTML = '<span class="rank-benefits-state">Chưa tải được quyền lợi. Hãy thử mở lại sau.</span>';
    return;
  }
  const currentLevel = Number(currentRank.level || 1);
  container.innerHTML = rankBenefits.map((benefit) => {
    const active = Number(benefit.level) === currentLevel;
    const xpLabel = Number(benefit.minXp) > 0 ? `${Number(benefit.minXp).toLocaleString("vi-VN")} XP` : "Bắt đầu";
    return `<div class="rank-benefit-row${active ? " current" : ""}"><span class="rank-benefit-icon">${escapeHtml(benefit.badge || "🎧")}</span><span class="rank-benefit-copy"><strong>Hạng ${Number(benefit.level)} · ${escapeHtml(benefit.name || "")}</strong><small>${xpLabel}</small></span><span class="rank-benefit-reward">+${Number(benefit.checkinPoints) || 1} điểm</span></div>`;
  }).join("");
}

function updateRankBenefitModal() {
  const rank = currentUser?.rank || {};
  const reward = Number(rank.checkinPoints) || 1;
  const progress = rank.nextMinXp
    ? `${Number(rank.xp || 0).toLocaleString("vi-VN")} / ${Number(rank.nextMinXp).toLocaleString("vi-VN")} XP`
    : `${Number(rank.xp || 0).toLocaleString("vi-VN")} XP · Tối đa`;
  document.getElementById("checkin-rank-badge")?.replaceChildren(document.createTextNode(rank.badge || "🎧"));
  document.getElementById("checkin-rank-name")?.replaceChildren(document.createTextNode(rank.name || "Người mới bắt nhịp"));
  document.getElementById("checkin-rank-reward")?.replaceChildren(document.createTextNode(`Hạng hiện tại · nhận ${reward} điểm cơ bản mỗi lần điểm danh`));
  document.getElementById("checkin-rank-progress")?.replaceChildren(document.createTextNode(progress));
  renderRankBenefits("checkin-rank-list", rank);
}

// --- Authentication & User State -------------------------------------------
async function fetchMe() {
  try {
    const res = await fetch("/api/me");
    const data = await res.json();
    if (data.ok && data.authenticated && data.user) {
      currentUser = data.user;
      renderUserAuthBar();
      if (lastQueueState) renderQueue(lastQueueState);
      if (currentUser.displayName && !nameEl.value.trim()) {
        nameEl.value = currentUser.displayName;
        localStorage.setItem("guestName", currentUser.displayName);
        if (feedbackName && !feedbackName.value.trim()) feedbackName.value = currentUser.displayName;
      }
      checkActivePointDrop();
    } else {
      currentUser = null;
      renderUserAuthBar();
      if (lastQueueState) renderQueue(lastQueueState);
    }
  } catch {
    currentUser = null;
    renderUserAuthBar();
    if (lastQueueState) renderQueue(lastQueueState);
  }
}

function renderUserAuthBar() {
  const bar = document.getElementById("user-auth-bar");
  if (!bar) return;
  if (currentUser) {
    const avatarLetter = escapeHtml((currentUser.displayName || currentUser.username || "U").trim().charAt(0).toUpperCase());
    bar.innerHTML = `
      <div class="user-profile-badge">
        <a class="user-account-link" href="/account" aria-label="Mở trang tài khoản của ${escapeHtml(currentUser.displayName || currentUser.username)}">
          <span class="user-avatar" aria-hidden="true">${avatarLetter}</span>
          <span class="user-name"><strong>${escapeHtml(currentUser.displayName || currentUser.username)}</strong></span>
        </a>
        <span id="user-points-pill" class="user-points-pill" title="Xem lịch sử / Điểm danh">${currentUser.pointsBalance} 🪙</span>
        <span id="user-streak-pill" class="user-streak-pill" title="Điểm danh streak">🔥 ${currentUser.currentStreak}d</span>
        <button id="user-logout-btn" class="user-logout-btn" type="button">Thoát</button>
      </div>
    `;
    document.getElementById("user-points-pill")?.addEventListener("click", openCheckinModal);
    document.getElementById("user-streak-pill")?.addEventListener("click", openCheckinModal);
    document.getElementById("user-logout-btn")?.addEventListener("click", handleLogout);
  } else {
    bar.innerHTML = `
      <button id="open-auth-btn" class="auth-pill-btn" type="button">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
        Đăng nhập / Đăng ký
      </button>
    `;
    document.getElementById("open-auth-btn")?.addEventListener("click", () => openAuthModal("login"));
  }
}

// --- Auth Modal Handlers --------------------------------------------------
let authMode = "login"; // "login" | "register"

function openAuthModal(mode = "login") {
  authMode = mode;
  const modal = document.getElementById("auth-modal");
  const title = document.getElementById("auth-modal-title");
  const tabLogin = document.getElementById("auth-tab-login");
  const tabRegister = document.getElementById("auth-tab-register");
  const nameField = document.getElementById("auth-display-name-field");
  const confirmField = document.getElementById("auth-confirm-password-field");
  const confirmInput = document.getElementById("auth-confirm-password");
  const confirmToggle = document.querySelector('[data-password-toggle="auth-confirm-password"]');
  const submitBtn = document.getElementById("auth-submit-btn");
  const errorEl = document.getElementById("auth-error-msg");

  errorEl.classList.add("hidden");
  errorEl.textContent = "";
  setAuthConfirmError("");

  if (mode === "login") {
    title.textContent = "Đăng nhập tài khoản";
    tabLogin.classList.add("active");
    tabRegister.classList.remove("active");
    tabLogin.setAttribute("aria-selected", "true");
    tabRegister.setAttribute("aria-selected", "false");
    nameField.classList.add("hidden");
    confirmField.classList.add("hidden");
    confirmInput.disabled = true;
    confirmInput.required = false;
    confirmToggle.disabled = true;
    submitBtn.textContent = "Đăng nhập ngay";
    document.getElementById("auth-password").setAttribute("autocomplete", "current-password");
  } else {
    title.textContent = "Đăng ký thành viên mới";
    tabLogin.classList.remove("active");
    tabRegister.classList.add("active");
    tabLogin.setAttribute("aria-selected", "false");
    tabRegister.setAttribute("aria-selected", "true");
    nameField.classList.remove("hidden");
    confirmField.classList.remove("hidden");
    confirmInput.disabled = false;
    confirmInput.required = true;
    confirmToggle.disabled = false;
    submitBtn.textContent = "Đăng ký tài khoản";
    document.getElementById("auth-password").setAttribute("autocomplete", "new-password");
  }

  modal.classList.remove("hidden");
  document.getElementById("auth-username").focus();
}

function closeAuthModal() {
  document.getElementById("auth-modal").classList.add("hidden");
}

document.getElementById("auth-modal-close")?.addEventListener("click", closeAuthModal);
document.getElementById("auth-tab-login")?.addEventListener("click", () => openAuthModal("login"));
document.getElementById("auth-tab-register")?.addEventListener("click", () => openAuthModal("register"));

function setAuthConfirmError(message) {
  const input = document.getElementById("auth-confirm-password");
  const error = document.getElementById("auth-confirm-password-error");
  if (!input || !error) return;
  error.textContent = message;
  error.classList.toggle("hidden", !message);
  input.setAttribute("aria-invalid", String(!!message));
}

function togglePasswordVisibility(button) {
  const input = document.getElementById(button.dataset.passwordToggle);
  if (!input) return;
  const reveal = input.type === "password";
  input.type = reveal ? "text" : "password";
  button.setAttribute("aria-label", reveal ? "Ẩn mật khẩu" : "Hiện mật khẩu");
  input.focus();
}

document.querySelectorAll("[data-password-toggle]").forEach((button) => {
  button.addEventListener("click", () => togglePasswordVisibility(button));
});

document.getElementById("auth-confirm-password")?.addEventListener("blur", () => {
  if (authMode !== "register") return;
  setAuthConfirmError(window.JukeboxAuth.validateRegistrationPassword(
    document.getElementById("auth-password").value,
    document.getElementById("auth-confirm-password").value
  ));
});

document.getElementById("auth-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("auth-username").value.trim();
  const password = document.getElementById("auth-password").value;
  const confirmation = document.getElementById("auth-confirm-password").value;
  const displayName = document.getElementById("auth-display-name").value.trim();
  const errorEl = document.getElementById("auth-error-msg");
  const submitBtn = document.getElementById("auth-submit-btn");

  errorEl.classList.add("hidden");
  if (authMode === "register") {
    const confirmationError = window.JukeboxAuth.validateRegistrationPassword(password, confirmation);
    setAuthConfirmError(confirmationError);
    if (confirmationError) {
      document.getElementById("auth-confirm-password").focus();
      return;
    }
  }
  submitBtn.disabled = true;
  submitBtn.textContent = "Đang xử lý…";

  const endpoint = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
  const payload = authMode === "login" ? { username, password } : { username, password, displayName };

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.ok) {
      closeAuthModal();
      await fetchMe();
      if (!currentUser) throw new Error("Không thể tải phiên đăng nhập vừa tạo.");
      toast("ok", "👋", `Xin chào, ${currentUser.displayName || currentUser.username}!`);
      if (currentUser.displayName) {
        nameEl.value = currentUser.displayName;
        localStorage.setItem("guestName", currentUser.displayName);
      }
      checkActivePointDrop();
    } else {
      errorEl.textContent = data.reason || "Lỗi xác thực, vui lòng thử lại.";
      errorEl.classList.remove("hidden");
      errorEl.focus();
    }
  } catch (err) {
    errorEl.textContent = "Lỗi kết nối mạng: " + err.message;
    errorEl.classList.remove("hidden");
    errorEl.focus();
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = authMode === "login" ? "Đăng nhập ngay" : "Đăng ký tài khoản";
  }
});

async function handleLogout() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {}
  currentUser = null;
  hidePointDropBanner();
  renderUserAuthBar();
  if (lastQueueState) renderQueue(lastQueueState);
  toast("info", "👋", "Đã đăng xuất tài khoản.");
}

// --- Daily Check-in & Streak Modal ----------------------------------------
function openCheckinModal() {
  if (!currentUser) {
    openAuthModal("login");
    return;
  }
  const modal = document.getElementById("checkin-modal");
  document.getElementById("modal-streak-count").textContent = currentUser.currentStreak || 0;
  document.getElementById("checkin-greeting").textContent = `Xin chào ${currentUser.displayName || currentUser.username}!`;
  updateRankBenefitModal();
  if (!rankBenefits.length) loadRankBenefits().then(updateRankBenefitModal);

  const streak = currentUser.currentStreak || 0;
  const cycle = streak % 30;
  document.getElementById("ms-3").classList.toggle("achieved", cycle >= 3);
  document.getElementById("ms-7").classList.toggle("achieved", cycle >= 7);
  document.getElementById("ms-14").classList.toggle("achieved", cycle >= 14);
  document.getElementById("ms-30").classList.toggle("achieved", cycle === 0 && streak > 0);

  const checkinBtn = document.getElementById("do-checkin-btn");
  if (currentUser.hasCheckedInToday) {
    checkinBtn.disabled = true;
    checkinBtn.textContent = "✓ Bạn đã điểm danh hôm nay rồi";
    document.getElementById("checkin-status-text").textContent = "Hãy quay lại vào ngày mai để duy trì streak nhé!";
  } else {
    checkinBtn.disabled = false;
    checkinBtn.textContent = `✨ Điểm Danh Nhận Điểm (+${Number(currentUser.rank?.checkinPoints) || 1} 🪙)`;
    document.getElementById("checkin-status-text").textContent = "Điểm danh mỗi ngày để nhận điểm vote bài hát và mở khóa mốc thưởng!";
  }

  modal.classList.remove("hidden");
}

function closeCheckinModal() {
  document.getElementById("checkin-modal").classList.add("hidden");
}

document.getElementById("checkin-modal-close")?.addEventListener("click", closeCheckinModal);

document.getElementById("do-checkin-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("do-checkin-btn");
  btn.disabled = true;
  btn.textContent = "Đang điểm danh…";

  try {
    const res = await fetch("/api/me/checkin", { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      currentUser.pointsBalance = data.newBalance;
      currentUser.currentStreak = data.streak;
      currentUser.hasCheckedInToday = true;

      let msg = `+${data.pointsAwarded} điểm danh ngày`;
      if (data.bonusPoints > 0) {
        msg += ` và +${data.bonusPoints} thưởng mốc streak ngày ${data.streak}! 🎉`;
      }
      toast("ok", "🔥", "Điểm danh thành công!", { sub: msg });
      openCheckinModal();
      renderUserAuthBar();
    } else {
      toast("bad", "!", data.reason || "Không thể điểm danh.");
      btn.disabled = false;
    }
  } catch (err) {
    toast("bad", "⚠️", "Lỗi kết nối: " + err.message);
    btn.disabled = false;
  }
});

// --- Claimable Point Drops ------------------------------------------------
async function checkActivePointDrop() {
  if (!currentUser) return;
  try {
    const res = await fetch("/api/me/point-drops/active");
    const data = await res.json();
    if (data.ok && data.drop && !data.alreadyClaimed) {
      showPointDropBanner(data.drop);
    } else {
      hidePointDropBanner();
    }
  } catch {}
}

function showPointDropBanner(drop) {
  currentActiveDrop = drop;
  const banner = document.getElementById("point-drop-banner");
  if (!banner) return;
  document.getElementById("drop-banner-title").textContent = drop.title;
  document.getElementById("drop-banner-sub").textContent = `+${drop.points} điểm quà tặng realtime từ BTC`;
  banner.classList.remove("hidden");
}

function hidePointDropBanner() {
  currentActiveDrop = null;
  document.getElementById("point-drop-banner")?.classList.add("hidden");
}

document.getElementById("drop-claim-btn")?.addEventListener("click", async () => {
  if (!currentUser) {
    openAuthModal("login");
    return;
  }
  if (!currentActiveDrop) return;

  const btn = document.getElementById("drop-claim-btn");
  btn.disabled = true;
  btn.textContent = "Đang nhận…";

  try {
    const res = await fetch(`/api/me/point-drops/${currentActiveDrop.id}/claim`, { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      currentUser.pointsBalance = data.newBalance;
      renderUserAuthBar();
      toast("ok", "🎁", `Nhận thành công +${data.pointsReceived} điểm!`);
      hidePointDropBanner();
    } else {
      toast("bad", "!", data.reason || "Không thể nhận quà tặng này.");
      hidePointDropBanner();
    }
  } catch (err) {
    toast("bad", "⚠️", "Lỗi: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Nhận ngay";
  }
});

// --- Song Voting ----------------------------------------------------------
window.voteSong = async function (itemId) {
  if (!currentUser) {
    openAuthModal("login");
    return;
  }
  if (pendingVotes.has(itemId)) return;

  pendingVotes.add(itemId);
  syncVoteButtonState(itemId);
  try {
    const res = await fetch(`/api/queue/${itemId}/vote`, { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      currentUser.pointsBalance = data.newBalance;
      currentUser.votedQueueItemIds = [...new Set([...(currentUser.votedQueueItemIds || []), itemId])];
      renderUserAuthBar();
      toast("ok", "❤️", "Đã vote thành công!", { sub: `Số dư còn lại: ${currentUser.pointsBalance} 🪙` });
    } else {
      toast("bad", "!", data.reason || "Không thể vote cho bài hát này.");
    }
  } catch (err) {
    toast("bad", "⚠️", "Lỗi kết nối: " + err.message);
  } finally {
    pendingVotes.delete(itemId);
    syncVoteButtonState(itemId);
  }
};

function syncVoteButtonState(itemId) {
  const row = [...document.querySelectorAll("#queue li[data-id]")]
    .find((item) => item.dataset.id === itemId);
  const button = row?.querySelector(".q-vote-btn");
  if (!button) return;

  const item = lastQueueState?.queue?.find((queueItem) => queueItem.id === itemId);
  const voteCount = item?.voteScore || 0;
  const pending = pendingVotes.has(itemId);
  const hasVoted = currentUser?.votedQueueItemIds?.includes(itemId) === true;
  const title = hasVoted
    ? "Vote thêm +1 cho bài hát này (tốn 1 điểm)"
    : "Vote để đẩy bài hát lên đầu (tốn 1 điểm)";

  button.disabled = pending;
  button.classList.toggle("has-voted", hasVoted);
  button.classList.toggle("is-pending", pending);
  button.setAttribute("aria-busy", String(pending));
  button.title = title;
  button.setAttribute("aria-label", title);
  button.querySelector("span").textContent = `Vote +1 · ${voteCount}`;
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const resultsEl = document.getElementById("results");
const resultsSkeletonEl = document.getElementById("results-skeleton");
const statusEl = document.getElementById("status");
const toastsEl = document.getElementById("toasts");
const qEl = document.getElementById("q");
const nameEl = document.getElementById("name");
const sugSection = document.getElementById("suggestions-section");
const backToExploreBtn = document.getElementById("back-to-explore");
const youtubeLinkPanel = document.getElementById("youtube-link-panel");
const youtubeLinkForm = document.getElementById("youtube-link-form");
const youtubeLinkInput = document.getElementById("youtube-link-input");
const youtubeLinkSubmit = document.getElementById("youtube-link-submit");
const youtubeLinkStatus = document.getElementById("youtube-link-status");
const youtubeLinkPreview = document.getElementById("youtube-link-preview");
const youtubeLinkThumb = document.getElementById("youtube-link-thumb");
const youtubeLinkTitle = document.getElementById("youtube-link-title");
const youtubeLinkSub = document.getElementById("youtube-link-sub");
const youtubeLinkAdd = document.getElementById("youtube-link-add");
const feedbackSection = document.getElementById("feedback-section");
const feedbackForm = document.getElementById("feedback-form");
const feedbackName = document.getElementById("feedback-name");
const feedbackContent = document.getElementById("feedback-content");
const feedbackSubmit = document.getElementById("feedback-submit");
const feedbackStatus = document.getElementById("feedback-status");
const chatWidget = document.getElementById("chat-widget");
const chatToggle = document.getElementById("chat-toggle");
const chatPanel = document.getElementById("chat-panel");
const chatClose = document.getElementById("chat-close");
const chatMessagesEl = document.getElementById("chat-messages");
const chatForm = document.getElementById("chat-form");
const chatMessageEl = document.getElementById("chat-message");
const chatSend = document.getElementById("chat-send");
const chatStatus = document.getElementById("chat-status");
const chatUnread = document.getElementById("chat-unread");
const chatOffState = document.getElementById("chat-off-state");
const chatSubtitle = document.getElementById("chat-subtitle");
let resolvedYouTubeSong = null;
let queueLimitOn = false;
let queueLimit = 10;
let requireName = false;
let feedbackOn = true;
let chatOn = true;
let chatAiOn = false;
let chatAiName = "Office DJ";
let chatOpen = false;
let chatUnreadCount = 0;
let chatPending = false;
let chatMessages = [];
let queueWs = null;
const CHAT_DISPLAY_LIMIT = 40;
const CHAT_BOTTOM_LOCK_PX = 64;
const pendingRemovals = new Set();
const pendingVotes = new Set();

function setChatStatus(message, kind = "") {
  chatStatus.textContent = message;
  chatStatus.className = `chat-status${kind ? ` ${kind}` : ""}`;
}

function resetChatPending() {
  chatPending = false;
  chatSend.disabled = false;
}

function renderChatUnread() {
  chatUnread.textContent = chatUnreadCount > 99 ? "99+" : String(chatUnreadCount);
  chatUnread.classList.toggle("hidden", chatUnreadCount === 0 || chatOpen);
}

function isChatNearLatest() {
  const distance = chatMessagesEl.scrollHeight - chatMessagesEl.scrollTop - chatMessagesEl.clientHeight;
  return distance <= CHAT_BOTTOM_LOCK_PX;
}

function scheduleChatScrollToLatest() {
  const schedule = window.requestAnimationFrame || ((callback) => window.setTimeout(callback, 0));
  schedule(() => {
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  });
}

function renderChatMessages({ scrollToLatest = false } = {}) {
  const shouldScroll = scrollToLatest || isChatNearLatest();
  chatMessagesEl.innerHTML = "";
  if (!chatMessages.length) {
    chatMessagesEl.innerHTML = '<p class="chat-empty">Chưa có tin nhắn. Hãy bắt đầu cuộc trò chuyện!</p>';
    return;
  }
  for (const message of chatMessages) {
    const item = document.createElement("article");
    item.className = `chat-message${message.senderId === clientId ? " is-own" : ""}${message.isAdmin ? " is-admin" : ""}${message.isAI ? " is-ai" : ""}`;
    const name = document.createElement("strong");
    name.className = "chat-message-name";
    name.textContent = message.name;
    if (message.rank?.badge) {
      const rankBadge = document.createElement("span");
      rankBadge.className = "chat-message-rank";
      rankBadge.textContent = `${message.rank.badge} ${message.rank.name || ""}`.trim();
      rankBadge.title = message.rank.name || "Hạng thành viên";
      name.append(" ", rankBadge);
    }
    if (message.isAdmin || message.isAI) {
      const badge = document.createElement("span");
      badge.className = "chat-message-badge";
      badge.textContent = message.isAI ? "AI" : "ADMIN";
      name.append(" ", badge);
    }
    const text = document.createElement("p");
    text.className = "chat-message-text";
    text.textContent = message.text;
    const meta = document.createElement("time");
    meta.className = "chat-message-time";
    const createdAt = message.createdAt ? new Date(message.createdAt) : null;
    if (createdAt && !Number.isNaN(createdAt.getTime())) {
      meta.dateTime = createdAt.toISOString();
      meta.title = createdAt.toLocaleString("vi-VN", { dateStyle: "medium", timeStyle: "short" });
      meta.textContent = createdAt.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
    } else {
      meta.textContent = "";
    }
    item.append(name, text, meta);
    chatMessagesEl.appendChild(item);
  }
  if (shouldScroll) scheduleChatScrollToLatest();
}

function appendChatMessage(message, { notify = true, render = true } = {}) {
  if (!message || typeof message.name !== "string" || typeof message.text !== "string") return;
  chatMessages.push({
    name: message.name.slice(0, 40),
    text: message.text.slice(0, 280),
    senderId: typeof message.senderId === "string" ? message.senderId.slice(0, 64) : "",
    isAdmin: message.isAdmin === true,
    isAI: message.isAI === true,
    createdAt: typeof message.createdAt === "string" ? message.createdAt : "",
    rank: message.rank && typeof message.rank === "object"
      ? { name: String(message.rank.name || "").slice(0, 40), badge: String(message.rank.badge || "").slice(0, 8) }
      : null,
  });
  if (chatMessages.length > CHAT_DISPLAY_LIMIT) chatMessages = chatMessages.slice(-CHAT_DISPLAY_LIMIT);
  if (render) renderChatMessages();
  if (notify && !chatOpen) {
    chatUnreadCount += 1;
    renderChatUnread();
  }
}

function setChatOpen(open) {
  if (!chatOn) return;
  chatOpen = open;
  chatPanel.classList.toggle("hidden", !open);
  chatToggle.setAttribute("aria-expanded", String(open));
  if (open) {
    chatUnreadCount = 0;
    renderChatUnread();
    // The history can arrive while the panel is hidden, when scrollHeight is
    // not measurable yet. Scroll again after the panel is visible so a reopen
    // always starts at the newest message instead of the first one.
    scheduleChatScrollToLatest();
    window.setTimeout(() => {
      if (chatOpen && chatOn) chatMessageEl.focus();
    }, 0);
  } else {
    renderChatUnread();
    chatToggle.focus();
  }
}

function renderChatSettings() {
  if (chatSubtitle) {
    chatSubtitle.textContent = chatAiOn
      ? `${chatAiName} có thể đọc ngữ cảnh và tự tham gia phòng chat`
      : "Tin nhắn mới nhất trong phòng";
  }
  if (!chatOn) {
    resetChatPending();
    chatOpen = false;
    chatPanel.classList.add("hidden");
    chatWidget.classList.add("hidden");
    if (chatWidget.contains(document.activeElement)) document.activeElement.blur();
    chatToggle.setAttribute("aria-expanded", "false");
    chatOffState.classList.remove("hidden");
    return;
  }
  chatWidget.classList.remove("hidden");
  chatOffState.classList.add("hidden");
  chatForm.classList.remove("hidden");
  renderChatUnread();
}

function sendChatMessage(event) {
  event.preventDefault();
  if (chatPending || !chatOn) return;
  if (!queueWs || queueWs.readyState !== WebSocket.OPEN) {
    setChatStatus("Mất kết nối chat, đang thử kết nối lại…", "bad");
    return;
  }
  const name = nameEl.value.trim();
  const text = chatMessageEl.value.trim();
  if (!name) {
    setChatStatus("Nhập tên ở ô Tên order để mọi người nhận ra bạn.", "bad");
    nameEl.focus();
    return;
  }
  if (!text) {
    setChatStatus("Hãy nhập nội dung tin nhắn.", "bad");
    chatMessageEl.focus();
    return;
  }
  localStorage.setItem("guestName", name);
  chatPending = true;
  chatSend.disabled = true;
  setChatStatus("");
  try {
    queueWs.send(JSON.stringify({ type: "chatSend", name, text, clientId }));
  } catch {
    resetChatPending();
    setChatStatus("Mất kết nối chat, vui lòng thử lại.", "bad");
  }
}

chatToggle.addEventListener("click", () => setChatOpen(!chatOpen));
chatClose.addEventListener("click", () => setChatOpen(false));
chatForm.addEventListener("submit", sendChatMessage);
chatMessageEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && chatOpen) setChatOpen(false);
});

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

// ---- Discovery (KTV-style browsing) --------------------------------------
// Genre tabs and singer chips use predefined YouTube queries through /api/browse
// (cached by the server), so displayed songs are fresh, real data rather than a
// hard-coded list. The add-song button walks through query variants.
// Queries contain only a genre or artist phrase and use YouTube Music's "Songs"
// search (single music tracks only), so no "Official MV" suffix is needed to
// avoid compilations; the server's ten-minute limit is the final guardrail.
const THIS_YEAR = new Date().getFullYear();
const GENRE_QUERIES = {
  // "__vn_hits" is a server sentinel, not a search query: it loads the current
  // Vietnam YouTube music chart before the broader discovery queries.
  All: ["__vn_hits", `V-pop ${THIS_YEAR}`, `nhạc Việt ${THIS_YEAR}`, `K-pop ${THIS_YEAR}`, "party anthems"],
  // This tab intentionally has no singer chips: graduation music is a theme,
  // not an artist list (there is no GENRE_SLUG entry, so the row stays empty).
  Graduation: ["nhạc tốt nghiệp", "nhạc chia tay tuổi học trò", "nhạc về tình bạn", "graduation songs"],
  "K-pop": [`K-pop ${THIS_YEAR}`, "K-pop dance hits", "K-pop girl group hits"],
  VPop: [`V-pop ${THIS_YEAR}`, `nhạc Việt mới ${THIS_YEAR}`, "V-pop thịnh hành", "nhạc trẻ Việt Nam"],
  Bolero: ["nhạc trữ tình Việt Nam", "bolero Việt Nam", "nhạc vàng hay nhất", "nhạc quê hương trữ tình"],
  Western: ["top pop hits", `pop hits ${THIS_YEAR}`, "classic pop anthems"],
  Party: ["party dance hits", "EDM anthems", "dancefloor classics"],
  Classics: ["nhạc Việt xưa", "nhạc vàng Việt Nam", "nhạc trữ tình thập niên 90", "bolero kinh điển"],
};
// User-facing genre labels. Internal keys index the query and singer collections.
const GENRE_LABEL = { All: "Tất cả", Graduation: "Tốt nghiệp", "K-pop": "K-pop", VPop: "V-pop", Bolero: "Nhạc trữ tình / bolero", Western: "Nhạc Âu Mỹ", Party: "Nhạc tiệc", Classics: "Nhạc kinh điển" };
const GENRE_ICON = {
  All: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="7" cy="7" r="2.6"/><circle cx="17" cy="7" r="2.6"/><circle cx="7" cy="17" r="2.6"/><circle cx="17" cy="17" r="2.6"/></svg>',
  Graduation: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 9.5L12 5l9.5 4.5L12 14z"/><path d="M6.5 11.8v4.2c0 1.1 2.5 2.5 5.5 2.5s5.5-1.4 5.5-2.5v-4.2"/><path d="M21.5 9.5v5"/></svg>',
  "K-pop": '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20s-7.2-4.4-9.7-9.1A5 5 0 0112 5.6a5 5 0 019.7 5.3C19.2 15.6 12 20 12 20z"/></svg>',
  VPop: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9.3" y="2.8" width="5.4" height="10.5" rx="2.7"/><path d="M6.3 11a5.7 5.7 0 0011.4 0"/><path d="M12 16.7v3.3M9.3 20h5.4"/></svg>',
  Bolero: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4v9.6a3.4 3.4 0 101.6 2.9V8.6l5.9-1.4V4l-7.5 2z"/></svg>',
  Western: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="8.2"/><path d="M3.8 12h16.4"/><path d="M12 3.8c2.6 2.2 2.6 14.2 0 16.4c-2.6-2.2-2.6-14.2 0-16.4z"/></svg>',
  Party: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5l2 6.2h6.4l-5.2 3.9 2 6.4-5.2-4-5.2 4 2-6.4-5.2-3.9h6.4z"/></svg>',
  Classics: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/></svg>',
};
const GENRE_SLUG = { "K-pop": "kpop", VPop: "vpop", Bolero: "bolero", Western: "western", Party: "party", Classics: "classics" };

const SINGERS = [
  { n: "Sơn Tùng M-TP", q: "Sơn Tùng M-TP", g: "vpop" },
  { n: "HIEUTHUHAI", q: "HIEUTHUHAI", g: "vpop" },
  { n: "MONO", q: "MONO Việt Nam", g: "vpop" },
  { n: "Wren Evans", q: "Wren Evans", g: "vpop" },
  { n: "RPT MCK", q: "RPT MCK", g: "vpop" },
  { n: "Tăng Duy Tân", q: "Tăng Duy Tân", g: "vpop" },
  { n: "Bích Phương", q: "Bích Phương", g: "vpop" },
  { n: "MIN", q: "MIN Việt Nam", g: "vpop" },
  { n: "AMEE", q: "AMEE", g: "vpop" },
  { n: "Đức Phúc", q: "Đức Phúc", g: "vpop" },
  { n: "Hòa Minzy", q: "Hòa Minzy", g: "vpop" },
  { n: "SOOBIN", q: "SOOBIN", g: "vpop" },
  { n: "Isaac", q: "Isaac Việt Nam", g: "vpop" },
  { n: "Vũ.", q: "Vũ. ca sĩ", g: "vpop" },
  { n: "tlinh", q: "tlinh", g: "vpop" },
  { n: "Phương Ly", q: "Phương Ly", g: "vpop" },
  { n: "Grey D", q: "Grey D", g: "vpop" },
  { n: "Quang Hùng MasterD", q: "Quang Hùng MasterD", g: "vpop" },
  { n: "Lệ Quyên", q: "Lệ Quyên", g: "bolero" },
  { n: "Đàm Vĩnh Hưng", q: "Đàm Vĩnh Hưng", g: "bolero" },
  { n: "Quang Lê", q: "Quang Lê", g: "bolero" },
  { n: "Như Quỳnh", q: "Như Quỳnh", g: "bolero" },
  { n: "Phi Nhung", q: "Phi Nhung", g: "bolero" },
  { n: "Cẩm Ly", q: "Cẩm Ly", g: "bolero" },
  { n: "Đan Trường", q: "Đan Trường", g: "bolero" },
  { n: "Chế Linh", q: "Chế Linh", g: "bolero" },
  { n: "Mạnh Quỳnh", q: "Mạnh Quỳnh", g: "bolero" },
  { n: "Ngọc Sơn", q: "Ngọc Sơn", g: "bolero" },
  { n: "Duy Khánh", q: "Duy Khánh nhạc vàng", g: "bolero" },
  { n: "Tuấn Vũ", q: "Tuấn Vũ", g: "bolero" },
  { n: "Giao Linh", q: "Giao Linh", g: "bolero" },
  { n: "Khánh Ly", q: "Khánh Ly", g: "bolero" },
  { n: "Bằng Kiều", q: "Bằng Kiều", g: "bolero" },
  { n: "NewJeans", q: "NewJeans", g: "kpop" },
  { n: "BTS", q: "BTS", g: "kpop" },
  { n: "BLACKPINK", q: "BLACKPINK", g: "kpop" },
  { n: "aespa", q: "aespa", g: "kpop" },
  { n: "TWICE", q: "TWICE", g: "kpop" },
  { n: "SEVENTEEN", q: "SEVENTEEN 세븐틴", g: "kpop" },
  { n: "Stray Kids", q: "Stray Kids", g: "kpop" },
  { n: "IVE", q: "IVE 아이브", g: "kpop" },
  { n: "LE SSERAFIM", q: "LE SSERAFIM", g: "kpop" },
  { n: "IU", q: "IU 아이유", g: "kpop" },
  { n: "(G)I-DLE", q: "(G)I-DLE", g: "kpop" },
  { n: "ITZY", q: "ITZY", g: "kpop" },
  { n: "ENHYPEN", q: "ENHYPEN", g: "kpop" },
  { n: "TXT", q: "TOMORROW X TOGETHER", g: "kpop" },
  { n: "BABYMONSTER", q: "BABYMONSTER", g: "kpop" },
  { n: "ILLIT", q: "ILLIT", g: "kpop" },
  { n: "Taylor Swift", q: "Taylor Swift", g: "western" },
  { n: "Bruno Mars", q: "Bruno Mars", g: "western" },
  { n: "Ed Sheeran", q: "Ed Sheeran", g: "western" },
  { n: "The Weeknd", q: "The Weeknd", g: "western" },
  { n: "Billie Eilish", q: "Billie Eilish", g: "western" },
  { n: "Dua Lipa", q: "Dua Lipa", g: "western" },
  { n: "Adele", q: "Adele", g: "western" },
  { n: "Olivia Rodrigo", q: "Olivia Rodrigo", g: "western" },
  { n: "Ariana Grande", q: "Ariana Grande", g: "western" },
  { n: "Justin Bieber", q: "Justin Bieber", g: "western" },
  { n: "Coldplay", q: "Coldplay", g: "western" },
  { n: "Maroon 5", q: "Maroon 5", g: "western" },
  { n: "Sabrina Carpenter", q: "Sabrina Carpenter", g: "western" },
  { n: "Charlie Puth", q: "Charlie Puth", g: "western" },
  { n: "Calvin Harris", q: "Calvin Harris", g: "party" },
  { n: "David Guetta", q: "David Guetta", g: "party" },
  { n: "Avicii", q: "Avicii", g: "party" },
  { n: "Black Eyed Peas", q: "Black Eyed Peas", g: "party" },
  { n: "The Chainsmokers", q: "The Chainsmokers", g: "party" },
  { n: "Marshmello", q: "Marshmello", g: "party" },
  { n: "Alan Walker", q: "Alan Walker", g: "party" },
  { n: "Kygo", q: "Kygo", g: "party" },
  { n: "Pitbull", q: "Pitbull", g: "party" },
  { n: "Zedd", q: "Zedd", g: "party" },
  { n: "Mỹ Tâm", q: "Mỹ Tâm", g: "classics" },
  { n: "Lam Trường", q: "Lam Trường", g: "classics" },
  { n: "Phương Thanh", q: "Phương Thanh", g: "classics" },
  { n: "Hồng Nhung", q: "Hồng Nhung", g: "classics" },
  { n: "Quang Dũng", q: "Quang Dũng", g: "classics" },
  { n: "Thanh Lam", q: "Thanh Lam", g: "classics" },
  { n: "Lê Hiếu", q: "Lê Hiếu", g: "classics" },
  { n: "Ưng Hoàng Phúc", q: "Ưng Hoàng Phúc", g: "classics" },
  { n: "Đan Trường", q: "Đan Trường", g: "classics" },
  { n: "Cẩm Ly", q: "Cẩm Ly", g: "classics" },
  { n: "Khánh Ly", q: "Khánh Ly", g: "classics" },
];

const moreBtn = document.getElementById("more");
let activeGenre = "All"; // selected tab; also filters the singer row
let activeKey = "genre:All"; // "genre:<name>" or "singer:<name>" (selection key)
const browse = { queries: [], idx: 0, seen: new Set(), gen: 0 };

// Fisher-Yates shuffle — reorders query variants for the random button and
// shuffles results client-side because the server cache returns the same array
// for a given query.
function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function renderGenreTabs() {
  const bar = document.getElementById("genre-tabs");
  bar.innerHTML = "";
  for (const g of Object.keys(GENRE_QUERIES)) {
    const btn = document.createElement("button");
    btn.className = "genre-tab" + (activeKey === `genre:${g}` ? " active" : "");
    btn.innerHTML = `${GENRE_ICON[g]}<span></span>`;
    btn.querySelector("span").textContent = GENRE_LABEL[g];
    btn.onclick = () => selectGenre(g);
    bar.appendChild(btn);
  }
}

function renderSingers() {
  const row = document.getElementById("singers");
  row.innerHTML = "";
  const list =
    activeGenre === "All" ? SINGERS : SINGERS.filter((s) => s.g === GENRE_SLUG[activeGenre]);
  // Genres without a GENRE_SLUG entry (for example Graduation) have no singer
  // list; hide the whole row instead of leaving an empty strip.
  row.classList.toggle("hidden", list.length === 0);
  for (const s of list) {
    const btn = document.createElement("button");
    btn.className = `singer-chip${activeKey === `singer:${s.n}` ? " active" : ""}`;
    btn.innerHTML = `<span class="singer-avatar g-${s.g}"></span><span class="singer-name"></span>`;
    btn.querySelector(".singer-avatar").textContent = [...s.n][0];
    btn.querySelector(".singer-name").textContent = s.n;
    btn.onclick = () => selectSinger(s);
    row.appendChild(btn);
  }
}

function selectGenre(g) {
  activeGenre = g;
  activeKey = `genre:${g}`;
  renderGenreTabs();
  renderSingers();
  startBrowse(GENRE_QUERIES[g]);
}

function selectSinger(s) {
  activeKey = `singer:${s.n}`;
  renderGenreTabs();
  renderSingers();
  startBrowse([s.q, `${s.q} bài hát nổi bật`, `${s.q} hits`]);
}

async function startBrowse(queries) {
  browse.queries = queries;
  browse.idx = 0;
  browse.seen = new Set();
  browse.gen++; // invalidate any loadMoreSongs call from the previous tab/search
  resultsEl.innerHTML = "";
  moreBtn.classList.add("hidden");
  await loadMoreSongs();
}

// Walk query variants (one /api/browse call per variant) until at least one
// unseen song is found or variants are exhausted. A variant containing only
// duplicates must not silently add nothing (D3).
async function loadMoreSongs() {
  const gen = browse.gen;
  moreBtn.disabled = true;
  setLoading(true, "Đang tải bài hát…");
  try {
    while (browse.idx < browse.queries.length) {
      const q = browse.queries[browse.idx++];
      const res = await fetch("/api/browse?q=" + encodeURIComponent(q));
      if (browse.gen !== gen) return; // stale; a newer tab/search/random action replaced it
      const data = await res.json();
      if (browse.gen !== gen) return;
      if (!res.ok) throw new Error(data.error || "Không thể tải bài hát.");
      let fresh = (data.results || []).filter((r) => r.videoId && !browse.seen.has(r.videoId));
      if (fresh.length === 0) continue; // all results duplicate; try the next variant
      for (const r of fresh) browse.seen.add(r.videoId);
      fresh = shuffleArray(fresh); // avoid showing the same order every time (A4)
      setLoading(false);
      setStatus("");
      appendResults(fresh);
      break;
    }
    if (browse.gen === gen) {
      setLoading(false);
      if (browse.seen.size === 0) setStatus("Không tìm thấy bài hát — hãy thử danh mục khác.");
    }
  } catch (err) {
    if (browse.gen === gen) {
      setLoading(false);
      setStatus("😕 " + err.message);
    }
  } finally {
    if (browse.gen === gen) {
      moreBtn.disabled = false;
      moreBtn.classList.toggle("hidden", browse.idx >= browse.queries.length);
    }
  }
}

moreBtn.onclick = loadMoreSongs;

document.getElementById("shuffle").onclick = () => {
  // Re-run the current selection with query variants in a new order.
  startBrowse(shuffleArray(browse.queries));
};

// ---- Search --------------------------------------------------------------
document.getElementById("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  doSearch(qEl.value.trim());
});

async function doSearch(q) {
  if (!q) return backToExplore(); // an empty form restores discovery

  const gen = ++browse.gen; // prevent older requests from overwriting the newest search
  qEl.blur();
  resultsEl.innerHTML = "";
  sugSection.classList.add("hidden"); // hide discovery while searching
  moreBtn.classList.add("hidden");
  backToExploreBtn.classList.remove("hidden");
  setLoading(true, "Đang tìm kiếm…");
  try {
    const res = await fetch("/api/search?q=" + encodeURIComponent(q));
    if (browse.gen !== gen) return;
    const data = await res.json();
    if (browse.gen !== gen) return;
    if (!res.ok) throw new Error(data.error || "Tìm kiếm thất bại.");
    setLoading(false);
    renderResults(data.results || []);
  } catch (err) {
    if (browse.gen === gen) {
      setLoading(false);
      setStatus("😕 " + err.message);
    }
  }
}

// Restore discovery after a search by re-running the selected genre or singer.
function backToExplore() {
  qEl.value = "";
  resultsEl.innerHTML = "";
  setStatus("");
  backToExploreBtn.classList.add("hidden");
  sugSection.classList.remove("hidden");
  startBrowse(browse.queries);
}

backToExploreBtn.onclick = backToExplore;

function setStatus(text) {
  statusEl.classList.remove("loading-status");
  if (!text) {
    statusEl.textContent = "";
    return statusEl.classList.add("hidden");
  }
  statusEl.textContent = text;
  statusEl.classList.remove("hidden");
}

function setLoading(isLoading, label = "Đang tải…") {
  resultsSkeletonEl.classList.toggle("hidden", !isLoading);
  resultsEl.setAttribute("aria-busy", isLoading ? "true" : "false");
  if (!isLoading) {
    statusEl.classList.remove("loading-status");
    statusEl.textContent = "";
    statusEl.classList.add("hidden");
    return;
  }
  statusEl.textContent = label;
  statusEl.classList.remove("hidden");
  statusEl.classList.add("loading-status");
}

// Fallback for a missing thumbnail: an empty <img src=""> would request the
// current page URL. Use the same pattern as host.js queue rendering.
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

function resultCard(r) {
  const li = document.createElement("li");
  li.innerHTML = `
    <img src="${safeImageUrl(r.thumbnail)}" alt="" loading="lazy" />
    <div class="r-meta">
      <div class="r-title"></div>
      <div class="r-sub"></div>
    </div>
    <button class="add-btn" title="Thêm bài hát" aria-label="Thêm bài hát">+</button>`;
  li.querySelector(".r-title").textContent = r.title;
  updateMarqueeTitle(li.querySelector(".r-title"));
  li.querySelector(".r-sub").textContent = r.channel + (r.duration ? ` · ${r.duration}` : "");
  const btn = li.querySelector(".add-btn");
  btn.onclick = () => requestSong(r, btn);
  return li;
}

function appendResults(results) {
  for (const r of results) resultsEl.appendChild(resultCard(r));
}

function renderResults(results) {
  if (results.length === 0) return setStatus("Không có kết quả, hãy thử từ khóa khác.");
  setStatus("");
  resultsEl.innerHTML = "";
  appendResults(results);
}

// ---- Add via YouTube link ------------------------------------------------
document.getElementById("show-youtube-link").onclick = () => {
  const open = youtubeLinkPanel.classList.toggle("hidden") === false;
  document.getElementById("show-youtube-link").textContent = open ? "Thu gọn" : "Dán link";
  if (open) youtubeLinkInput.focus();
};

function setYouTubeLinkStatus(text, kind = "") {
  youtubeLinkStatus.textContent = text;
  youtubeLinkStatus.className = `youtube-link-status${kind ? ` ${kind}` : ""}`;
}

function showYouTubePreview(song) {
  resolvedYouTubeSong = song;
  youtubeLinkThumb.src = safeImageUrl(song.thumbnail);
  youtubeLinkTitle.textContent = song.title;
  updateMarqueeTitle(youtubeLinkTitle);
  youtubeLinkSub.textContent = song.channel;
  youtubeLinkAdd.disabled = false;
  youtubeLinkAdd.textContent = "+";
  youtubeLinkPreview.classList.remove("hidden");
}

youtubeLinkForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = youtubeLinkInput.value.trim();
  if (!url) return setYouTubeLinkStatus("Vui lòng dán link YouTube.", "bad");
  youtubeLinkSubmit.disabled = true;
  youtubeLinkSubmit.textContent = "Đang kiểm tra…";
  youtubeLinkPreview.classList.add("hidden");
  resolvedYouTubeSong = null;
  setYouTubeLinkStatus("");
  try {
    const res = await fetch("/api/youtube/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.reason || "Link YouTube không đúng định dạng.");
    showYouTubePreview(data.song);
    setYouTubeLinkStatus("Đã tìm thấy video. Bạn có thể thêm vào hàng đợi.", "ok");
  } catch (err) {
    setYouTubeLinkStatus(err.message || "Không thể kiểm tra link YouTube.", "bad");
  } finally {
    youtubeLinkSubmit.disabled = false;
    youtubeLinkSubmit.textContent = "Kiểm tra";
  }
});

youtubeLinkAdd.onclick = () => {
  if (resolvedYouTubeSong) requestSong(resolvedYouTubeSong, youtubeLinkAdd);
};

// ---- Guest identity -------------------------------------------------------
// Send a persisted random ID with every request so the server applies cooldowns
// per phone rather than per IP (venue Wi-Fi often shares one public IP).
const clientId =
  localStorage.getItem("clientId") ||
  (() => {
    const id = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
    localStorage.setItem("clientId", id);
    return id;
  })();

// ---- Guest name (persisted, optional) -------------------------------------
nameEl.value = localStorage.getItem("guestName") || "";
feedbackName.value = nameEl.value;
nameEl.addEventListener("change", () => {
  localStorage.setItem("guestName", nameEl.value.trim());
  if (!feedbackName.value.trim()) feedbackName.value = nameEl.value.trim();
});

function renderRequestSettings() {
  nameEl.required = requireName;
  nameEl.placeholder = requireName ? "Tên order (bắt buộc)" : "Tên order (không bắt buộc)";
  document.getElementById("name-hint").textContent = requireName
    ? "Bắt buộc · hiển thị bên cạnh bài hát bạn chọn"
    : "Không bắt buộc · hiển thị bên cạnh bài hát bạn chọn";
}

function renderFeedback() {
  feedbackSection.classList.toggle("hidden", !feedbackOn);
}

feedbackForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!feedbackName.value.trim() || !feedbackContent.value.trim()) return;
  feedbackSubmit.disabled = true;
  feedbackStatus.className = "feedback-status";
  feedbackStatus.textContent = "Đang gửi…";
  try {
    const res = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: feedbackName.value.trim(), content: feedbackContent.value.trim() }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.reason || "Không thể gửi góp ý.");
    feedbackContent.value = "";
    feedbackStatus.className = "feedback-status ok";
    feedbackStatus.textContent = "Cảm ơn bạn! Góp ý đã được gửi.";
  } catch (error) {
    feedbackStatus.className = "feedback-status bad";
    feedbackStatus.textContent = error.message || "Không thể gửi góp ý.";
  } finally {
    feedbackSubmit.disabled = false;
  }
});

// ---- Own requests (for the owned-request queue badge) --------------------
function loadMyRequestIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem("myRequestIds") || "[]"));
  } catch {
    return new Set();
  }
}
function rememberMyRequest(id) {
  const ids = [...loadMyRequestIds(), id].slice(-50); // keep the list bounded
  localStorage.setItem("myRequestIds", JSON.stringify(ids));
}

// ---- Select a song --------------------------------------------------------
async function requestSong(song, btn) {
  if (requireName && !nameEl.value.trim()) {
    toast("bad", "!", "Vui lòng nhập tên order trước.", { sub: "Host đang yêu cầu tên người chọn bài." });
    nameEl.focus();
    return;
  }
  btn.disabled = true;
  btn.textContent = "…";
  // Keep the "checking" card with its animation: web-search moderation can take
  // 5–20 seconds, so the card must look active rather than stuck. The secondary
  // line names the song because multiple songs may be checked in parallel.
  const t = toast("info", "🔎", "Đang kiểm tra bài hát…", { persist: true, sub: song.title, checking: true });
  try {
    const res = await fetch("/api/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...song, name: nameEl.value.trim(), clientId }),
    });
    const data = await res.json();
    if (data.ok) {
      const main = data.position === 0 ? "Đã thêm · đang phát" : `Đã thêm · vị trí ${data.position}`;
      const sub = data.position === 0 ? "Bài hát đang phát ngay." : `Đang ở vị trí ${data.position} trong hàng đợi.`;
      t.set("ok", "✓", main, { sub });
      btn.textContent = "✓";
      if (data.id) {
        rememberMyRequest(data.id);
        // Queue notifications often arrive before this response, so the row may
        // have rendered before ownership was known; render it again with the badge.
        if (lastQueueState) renderQueue(lastQueueState);
      }
    } else {
      if (data.retryIn) {
        t.dismiss();
        cooldownToast(data.retryIn);
      } else t.set("bad", "🚫", data.reason || "Không thể thêm bài hát này.");
      btn.disabled = false;
      btn.textContent = "+";
    }
  } catch (err) {
    t.set("bad", "⚠️", "Lỗi mạng, vui lòng thử lại.", { sub: "Không thể kết nối mạng. Hãy thử lại." });
    btn.disabled = false;
    btn.textContent = "+";
  }
}

// Toast stacking: each request owns a separate element (icon ring, main line,
// and smaller secondary line). toast() returns a controller with set() so the
// checking card can become its result in place; parallel requests never overwrite
// each other's feedback.
const MAX_TOASTS = 3;

function toast(kind, icon, main, opts = {}) {
  const el = document.createElement("div");
  el.className = "toast";
  toastsEl.appendChild(el);
  while (toastsEl.children.length > MAX_TOASTS) toastsEl.firstElementChild.remove();
  void el.offsetHeight; // force a style update so adding .show triggers the animation
  let timer;
  const h = {
    el,
    set(kind2, icon2, main2, { persist = false, sub = "", checking = false } = {}) {
      el.className = `toast show ${kind2}${checking ? " checking" : ""}`;
      el.innerHTML = `
        <span class="toast-ico"></span>
        <div><div class="toast-main"></div><div class="toast-sub"></div></div>`;
      el.querySelector(".toast-ico").textContent = icon2;
      el.querySelector(".toast-main").textContent = main2;
      const subEl = el.querySelector(".toast-sub");
      if (sub) subEl.textContent = sub;
      else subEl.remove();
      clearTimeout(timer);
      if (!persist) timer = setTimeout(h.dismiss, 3800);
    },
    dismiss() {
      clearTimeout(timer);
      el.classList.remove("show");
      setTimeout(() => el.remove(), 300); // wait for the hide transition to finish
    },
  };
  h.set(kind, icon, main, opts);
  return h;
}

// Show a live countdown when the server rejects a request sent too soon
// (retryIn is the remaining number of seconds). Use one card: retrying while
// waiting restarts the countdown in place instead of adding a duplicate.
function cooldownToast(seconds) {
  clearInterval(cooldownToast._i);
  if (!cooldownToast._h?.el.isConnected) {
    cooldownToast._h = toast("bad", "⏳", "", { persist: true });
  }
  const t = cooldownToast._h;
  let left = seconds;
  const draw = () =>
    t.set("bad", "⏳", `Vui lòng đợi thêm ${left} giây`, { persist: true, sub: `Bài tiếp theo sau ${left} giây…` });
  draw();
  cooldownToast._i = setInterval(() => {
    left--;
    if (left <= 0) {
      clearInterval(cooldownToast._i);
      t.dismiss();
    } else draw();
  }, 1000);
}

// ---- Live queue (WebSocket) ------------------------------------------------
let lastQueueState = null; // retain state so the owned-request badge can be redrawn

function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}`);
  queueWs = ws;
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
    if (msg.type === "state" && msg.state && typeof msg.state === "object") {
      lastQueueState = msg.state;
      if (typeof msg.queueLimitOn === "boolean") queueLimitOn = msg.queueLimitOn;
      if (typeof msg.queueLimit === "number") queueLimit = msg.queueLimit;
      if (typeof msg.requireName === "boolean") requireName = msg.requireName;
      if (typeof msg.feedbackOn === "boolean") feedbackOn = msg.feedbackOn;
      if (typeof msg.chatOn === "boolean") chatOn = msg.chatOn;
      if (typeof msg.chatAiOn === "boolean") chatAiOn = msg.chatAiOn;
      if (typeof msg.chatAiName === "string") chatAiName = msg.chatAiName.slice(0, 40);
      renderRequestSettings();
      renderFeedback();
      renderChatSettings();
      renderQueue(msg.state);
    } else if (msg.type === "chatHistory") {
      chatMessages = [];
      for (const message of Array.isArray(msg.messages) ? msg.messages.slice(-CHAT_DISPLAY_LIMIT) : []) {
        appendChatMessage(message, { notify: false, render: false });
      }
      renderChatMessages({ scrollToLatest: true });
      chatUnreadCount = 0;
      renderChatUnread();
    } else if (msg.type === "chatMessage") {
      appendChatMessage(msg.message);
    } else if (msg.type === "chatCleared") {
      resetChatPending();
      chatMessages = [];
      chatUnreadCount = 0;
      renderChatMessages();
      renderChatUnread();
      setChatStatus("Tin nhắn đã được làm mới.", "ok");
    } else if (msg.type === "chatSendResult") {
      resetChatPending();
      if (msg.ok) {
        chatMessageEl.value = "";
        setChatStatus("Đã gửi", "ok");
        window.setTimeout(() => {
          if (chatStatus.textContent === "Đã gửi") setChatStatus("");
        }, 1800);
      } else {
        setChatStatus(msg.reason || "Không thể gửi tin nhắn.", "bad");
      }
    } else if (msg.type === "error" && chatPending) {
      resetChatPending();
      setChatStatus(msg.reason || "Không thể gửi tin nhắn.", "bad");
    } else if (msg.type === "pointDropAvailable") {
      showPointDropBanner(msg.drop);
      toast("info", "🎁", "Có đợt quà tặng điểm mới từ BTC!");
    } else if (msg.type === "airdropDirect") {
      if (currentUser) {
        currentUser.pointsBalance += msg.points;
        renderUserAuthBar();
        toast("ok", "🚀", `Bạn vừa nhận được airdrop +${msg.points} điểm!`, { sub: msg.reason });
      }
    } else if (msg.type === "balanceUpdated") {
      if (currentUser && Number.isSafeInteger(msg.newBalance)) {
        currentUser.pointsBalance = msg.newBalance;
        renderUserAuthBar();
        const title = msg.delta > 0 ? `Bạn vừa được hoàn +${msg.delta} điểm.` : "Số dư điểm vừa được cập nhật.";
        toast("info", "🪙", title, { sub: msg.reason || "Dữ liệu đã đồng bộ từ máy chủ." });
      }
    } else if (msg.type === "profileUpdated") {
      if (currentUser && msg.displayName) {
        currentUser.displayName = msg.displayName;
        renderUserAuthBar();
      }
    } else if (msg.type === "sessionRevoked") {
      currentUser = null;
      hidePointDropBanner();
      renderUserAuthBar();
      if (lastQueueState) renderQueue(lastQueueState);
      toast("bad", "!", msg.reason || "Phiên đăng nhập không còn hiệu lực.");
    } else if (msg.type === "removeOwnResult") {
      pendingRemovals.delete(msg.id);
      if (msg.ok) toast("ok", "✓", "Đã xóa khỏi hàng đợi.");
      else toast("bad", "!", msg.reason || "Không thể xóa bài hát này.");
      if (lastQueueState) renderQueue(lastQueueState);
    }
  };
  ws.onclose = () => {
    if (queueWs !== ws) return;
    queueWs = null;
    resetChatPending();
    setChatStatus("Mất kết nối chat, đang thử kết nối lại…", "bad");
    setTimeout(() => {
      if (!queueWs) connectWs();
    }, 2000);
  };
}

function renderQueue(state) {
  const np = state.nowPlaying;
  const npEl = document.getElementById("now-playing");
  if (np) {
    npEl.classList.remove("hidden");
    npEl.innerHTML = `
      <img src="${safeImageUrl(np.thumbnail)}" alt="" />
      <div class="np-body">
        <div class="np-label">
          <span class="eq"><span></span><span></span><span></span></span>
          ĐANG PHÁT
        </div>
        <div class="np-title"></div>
        <div class="np-sub"></div>
      </div>`;
    npEl.querySelector(".np-title").textContent = np.title;
    updateMarqueeTitle(npEl.querySelector(".np-title"));
    npEl.querySelector(".np-sub").textContent =
      (np.channel || "") + (np.addedBy ? ` · Người chọn: ${np.addedBy}` : "");
  } else {
    npEl.classList.add("hidden");
  }

  const queue = state.queue || [];
  document.getElementById("queue-count").textContent = queue.length;
  const limitNotice = document.getElementById("queue-limit-notice");
  const limitReached = queueLimitOn && queue.length >= queueLimit;
  limitNotice.classList.toggle("hidden", !limitReached);
  if (limitReached) limitNotice.textContent = `Hàng đợi đã đạt giới hạn ${queueLimit} bài — hãy chờ phát bớt trước khi thêm bài mới.`;
  const ul = document.getElementById("queue");
  const animateReorder = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const previousPositions = animateReorder
    ? new Map(
        [...ul.querySelectorAll("li[data-id]")].map((item) => [
          item.dataset.id,
          item.getBoundingClientRect().top,
        ])
      )
    : new Map();
  ul.innerHTML = "";
  if (queue.length === 0) {
    ul.innerHTML = `
      <li class="q-empty">
        <span class="q-empty-icon" aria-hidden="true">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 18V5l10-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="16" cy="16" r="3" />
          </svg>
        </span>
        <strong>Hàng đợi đang trống</strong>
        <span>Chọn một bài hát để mở màn nhé!</span>
      </li>`;
    return;
  }
  const myIds = loadMyRequestIds();
  queue.forEach((item, i) => {
    const li = document.createElement("li");
    const voteCount = item.voteScore || 0;
    const isPinned = item.pinned === true;
    const hasVoted = currentUser?.votedQueueItemIds?.includes(item.id) === true;
    const votePending = pendingVotes.has(item.id);
    const voteTitle = hasVoted
      ? "Vote thêm +1 cho bài hát này (tốn 1 điểm)"
      : currentUser
        ? "Vote để đẩy bài hát lên đầu (tốn 1 điểm)"
        : "Đăng nhập để vote bài hát";

    li.dataset.id = item.id;
    li.innerHTML = `
      <span class="q-num">${i + 1}</span>
      <img src="${safeImageUrl(item.thumbnail)}" alt="" loading="lazy" />
      <div class="q-text">
        <div class="t-row">
          <span class="t"></span>
          ${isPinned ? '<span class="q-pinned-badge">Ghim</span>' : ""}
        </div>
        <div class="q-byline">
          <span class="s"></span>
          <span class="q-requester"></span>
        </div>
        <div class="q-eta"></div>
      </div>
      <div class="q-actions">
        <button class="q-vote-btn${hasVoted ? " has-voted" : ""}${votePending ? " is-pending" : ""}" type="button" title="${voteTitle}" aria-label="${voteTitle}" aria-busy="${votePending}" onclick="voteSong('${item.id}')" ${votePending ? "disabled" : ""}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z"/></svg>
          <span>Vote +1 · ${voteCount}</span>
        </button>
        <button class="q-remove-own hidden" type="button" title="Xóa bài của bạn" aria-label="Xóa bài của bạn">×</button>
      </div>`;
    li.querySelector(".t").textContent = item.title;
    updateMarqueeTitle(li.querySelector(".t"));
    li.querySelector(".s").textContent = item.channel;
    li.querySelector(".q-requester").textContent = item.addedBy
      ? `Người chọn: ${item.addedBy}`
      : "Người chọn: Khách ẩn danh";
    if (item.rank?.badge) {
      const rank = document.createElement("span");
      rank.className = "q-rank-badge";
      rank.textContent = `${item.rank.badge} ${item.rank.name || ""}`.trim();
      rank.title = item.rank.name || "Hạng hoạt động";
      li.querySelector(".q-byline").appendChild(rank);
    }
    li.querySelector(".q-eta").textContent = formatEstimatedStart(item.estimatedStartAt);
    if (myIds.has(item.id)) {
      const chip = document.createElement("span");
      chip.className = "q-you";
      chip.textContent = "Bạn";
      li.querySelector(".t-row").appendChild(chip);
      const remove = li.querySelector(".q-remove-own");
      remove.classList.remove("hidden");
      remove.disabled = pendingRemovals.has(item.id);
      remove.onclick = () => {
        if (!queueWs || queueWs.readyState !== WebSocket.OPEN || pendingRemovals.has(item.id)) return;
        pendingRemovals.add(item.id);
        remove.disabled = true;
        queueWs.send(JSON.stringify({ type: "removeOwn", id: item.id, clientId }));
      };
    }
    ul.appendChild(li);
  });

  if (previousPositions.size) {
    ul.querySelectorAll("li[data-id]").forEach((item) => {
      const previousTop = previousPositions.get(item.dataset.id);
      if (previousTop === undefined || typeof item.animate !== "function") return;
      const deltaY = previousTop - item.getBoundingClientRect().top;
      if (Math.abs(deltaY) < 1) return;
      item.animate(
        [
          { transform: `translateY(${deltaY}px)` },
          { transform: "translateY(0)" },
        ],
        { duration: 320, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
      );
    });
  }
}

function formatEstimatedStart(timestamp) {
  if (!Number.isFinite(timestamp)) return "Chưa rõ thời gian phát";
  const minutes = Math.max(0, Math.round((timestamp - Date.now()) / 60000));
  if (minutes < 1) return "Dự kiến phát sắp tới";
  if (minutes < 60) return `Dự kiến phát sau khoảng ${minutes} phút`;
  return `Dự kiến phát lúc ${new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

renderSingers();
selectGenre("All"); // render the tab and load real songs on page open
renderRequestSettings();
renderFeedback();
fetchMe();
connectWs();
setInterval(() => {
  if (lastQueueState) renderQueue(lastQueueState);
}, 30000);
