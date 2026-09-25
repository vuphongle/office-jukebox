let currentUser = null;
let currentActiveDrop = null;
let rankBenefits = [];
let rankBenefitsPromise = null;
const favoritesController = window.JukeboxFavoritesController.create();
let favoritesViewActive = false;

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
      syncFavoritesIdentity();
      await loadFavorites();
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
      syncFavoritesIdentity();
      renderUserAuthBar();
      if (lastQueueState) renderQueue(lastQueueState);
    }
  } catch {
    currentUser = null;
    syncFavoritesIdentity();
    renderUserAuthBar();
    if (lastQueueState) renderQueue(lastQueueState);
  }
  syncHistoryIdentity();
}

function renderUserAuthBar() {
  const bar = document.getElementById("user-auth-bar");
  if (!bar) return;
  if (currentUser) {
    const avatarLetter = escapeHtml((currentUser.displayName || currentUser.username || "U").trim().charAt(0).toUpperCase());
    const hasCheckedIn = Boolean(currentUser.hasCheckedInToday);
    const streakTitle = hasCheckedIn
      ? `Đã điểm danh hôm nay · Chuỗi ${currentUser.currentStreak || 0} ngày`
      : `Chưa điểm danh hôm nay · Nhấn để thắp sáng chuỗi ${currentUser.currentStreak || 0} ngày!`;
    bar.innerHTML = `
      <div class="user-profile-badge">
        <a class="user-account-link" href="/account" aria-label="Mở trang tài khoản của ${escapeHtml(currentUser.displayName || currentUser.username)}">
          <span class="user-avatar" aria-hidden="true">${avatarLetter}</span>
          <span class="user-name"><strong>${escapeHtml(currentUser.displayName || currentUser.username)}</strong></span>
        </a>
        <span id="user-points-pill" class="user-points-pill" title="Xem lịch sử / Điểm danh">${currentUser.pointsBalance} 🪙</span>
        <span id="user-streak-pill" class="user-streak-pill ${hasCheckedIn ? "active" : "inactive"}" title="${escapeHtml(streakTitle)}" role="button" tabindex="0">
          <span class="user-streak-flame" aria-hidden="true">🔥</span>
          <span class="user-streak-count">${currentUser.currentStreak || 0}d</span>
        </span>
        <button data-notification-bell class="notification-bell" type="button" aria-label="Mở thông báo">
          <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>
          <span data-notification-count class="notification-count hidden">0</span>
        </button>
        <button id="user-logout-btn" class="user-logout-btn" type="button">Thoát</button>
      </div>
    `;
    window.JukeboxAvatars?.apply(bar.querySelector(".user-avatar"), {
      avatarUrl: currentUser.avatarUrl,
      name: currentUser.displayName || currentUser.username,
    });
    document.getElementById("user-points-pill")?.addEventListener("click", openCheckinModal);
    const streakPill = document.getElementById("user-streak-pill");
    streakPill?.addEventListener("click", openCheckinModal);
    streakPill?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openCheckinModal();
      }
    });
    document.getElementById("user-logout-btn")?.addEventListener("click", handleLogout);
    window.JukeboxNotifications?.syncUser(currentUser);
  } else {
    bar.innerHTML = `
      <button id="open-auth-btn" class="auth-pill-btn" type="button">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
        Đăng nhập / Đăng ký
      </button>
    `;
    document.getElementById("open-auth-btn")?.addEventListener("click", () => openAuthModal("login"));
    window.JukeboxNotifications?.reset();
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
      restartWs();
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
  syncFavoritesIdentity();
  syncHistoryIdentity();
  hidePointDropBanner();
  renderUserAuthBar();
  if (lastQueueState) renderQueue(lastQueueState);
  restartWs();
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
  const expires = drop.expiresAt ? new Date(drop.expiresAt) : null;
  const expiryLabel = expires && !Number.isNaN(expires.getTime())
    ? ` · hết hạn ${expires.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}`
    : "";
  document.getElementById("drop-banner-sub").textContent = `+${drop.points} điểm quà tặng realtime từ BTC${expiryLabel}`;
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
const discoveryTitle = document.getElementById("discovery-title");
const favoritesToggle = document.getElementById("favorites-toggle");
const favoritesCount = document.getElementById("favorites-count");
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
let userQueueLimitOn = false;
let userQueueLimit = 5;
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
const pendingOwnSkips = new Set();
const pendingVotes = new Set();

function renderFavoritesCount() {
  const count = favoritesController.all().length;
  favoritesCount.textContent = count > 99 ? "99+" : String(count);
}

function setFavoritesView(active) {
  favoritesViewActive = active;
  favoritesToggle.classList.toggle("active", active);
  favoritesToggle.setAttribute("aria-pressed", String(active));
  discoveryTitle.innerHTML = active ? "Bài yêu thích <small>Của bạn</small>" : "Khám phá <small>Gợi ý</small>";
  document.getElementById("singers").classList.toggle("hidden", active);
  document.getElementById("genre-tabs").classList.toggle("hidden", active);
  document.getElementById("shuffle").classList.toggle("hidden", active);
}

function syncFavoritesIdentity() {
  if (!favoritesController.setIdentity(currentUser?.id || null)) return;
  renderFavoritesCount();
  refreshFavoriteButtons();
  if (!currentUser && favoritesViewActive) backToExplore();
}

async function loadFavorites({ showError = false } = {}) {
  const requestedIdentity = favoritesController.captureIdentity();
  if (!requestedIdentity) return false;
  try {
    const res = await fetch("/api/me/favorites");
    if (!favoritesController.isIdentityCurrent(requestedIdentity)) return false;
    if (res.status === 401) {
      currentUser = null;
      syncFavoritesIdentity();
      syncHistoryIdentity();
      renderUserAuthBar();
      if (lastQueueState) renderQueue(lastQueueState);
      if (showError) openAuthModal("login");
      return false;
    }
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.reason || "Không thể tải bài hát yêu thích.");
    if (!favoritesController.replace(requestedIdentity, data.items)) return false;
    renderFavoritesCount();
    refreshFavoriteButtons();
    return true;
  } catch (err) {
    if (showError && favoritesController.isIdentityCurrent(requestedIdentity)) {
      toast("bad", "!", err.message || "Không thể tải bài hát yêu thích.");
    }
    return false;
  }
}

function syncFavoriteButton(button) {
  const videoId = button.dataset.favoriteVideoId;
  const isFavorite = favoritesController.isFavorite(videoId);
  const pending = favoritesController.isPending(videoId);
  const label = isFavorite ? "Bỏ khỏi danh sách yêu thích" : "Thêm vào danh sách yêu thích";
  button.classList.toggle("is-favorite", isFavorite);
  button.classList.toggle("is-pending", pending);
  button.disabled = pending;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", String(isFavorite));
}

function refreshFavoriteButtons() {
  document.querySelectorAll("[data-favorite-video-id]").forEach(syncFavoriteButton);
}

function createFavoriteButton(song, extraClass = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `favorite-btn${extraClass ? ` ${extraClass}` : ""}`;
  button.dataset.favoriteVideoId = song.videoId;
  button.innerHTML = '<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z"/></svg>';
  button.addEventListener("click", () => toggleFavorite(song));
  syncFavoriteButton(button);
  return button;
}

async function toggleFavorite(song) {
  if (!currentUser) {
    openAuthModal("login");
    return;
  }
  const requestedIdentity = favoritesController.captureIdentity();
  if (!requestedIdentity || !favoritesController.begin(song.videoId)) return;
  const removing = favoritesController.isFavorite(song.videoId);
  refreshFavoriteButtons();
  try {
    const res = await fetch(`/api/me/favorites${removing ? `/${encodeURIComponent(song.videoId)}` : ""}`, {
      method: removing ? "DELETE" : "POST",
      headers: removing ? undefined : { "Content-Type": "application/json" },
      body: removing ? undefined : JSON.stringify(song),
    });
    const data = await res.json();
    if (!favoritesController.isIdentityCurrent(requestedIdentity)) return;
    if (res.status === 401) {
      currentUser = null;
      syncFavoritesIdentity();
      syncHistoryIdentity();
      renderUserAuthBar();
      openAuthModal("login");
      return;
    }
    if (!res.ok || !data.ok) throw new Error(data.reason || "Không thể cập nhật bài hát yêu thích.");
    if (removing) {
      favoritesController.remove(requestedIdentity, song.videoId);
      toast("info", "♡", "Đã bỏ khỏi danh sách yêu thích.", { sub: song.title });
    } else {
      favoritesController.upsert(requestedIdentity, data.favorite);
      toast("ok", "♥", "Đã thêm vào danh sách yêu thích!", { sub: song.title });
    }
    renderFavoritesCount();
    if (favoritesViewActive) renderFavoriteResults();
  } catch (err) {
    if (favoritesController.isIdentityCurrent(requestedIdentity)) {
      toast("bad", "!", err.message || "Không thể cập nhật bài hát yêu thích.");
    }
  } finally {
    if (favoritesController.finish(requestedIdentity, song.videoId)) refreshFavoriteButtons();
  }
}

function renderFavoriteResults() {
  const items = favoritesController.all();
  resultsEl.innerHTML = "";
  if (!items.length) {
    setStatus("Bạn chưa có bài hát yêu thích. Hãy bấm biểu tượng trái tim ở bài đang phát, hàng đợi hoặc kết quả tìm kiếm.");
    return;
  }
  setStatus("");
  appendResults(items);
}

async function showFavorites() {
  if (!currentUser) {
    openAuthModal("login");
    return;
  }
  browse.gen++;
  qEl.value = "";
  sugSection.classList.remove("hidden");
  backToExploreBtn.classList.add("hidden");
  moreBtn?.classList.add("hidden");
  setFavoritesView(true);
  resultsEl.innerHTML = "";
  setLoading(true, "Đang tải bài hát yêu thích…");
  const loaded = await loadFavorites({ showError: true });
  if (!favoritesViewActive || !loaded) {
    setLoading(false);
    return;
  }
  setLoading(false);
  renderFavoriteResults();
}

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
    item.className = `chat-message${message.senderId === clientId ? " is-own" : ""}${message.isAdmin ? " is-admin" : ""}${message.isAI ? " is-ai" : ""}${message.isSystem ? " is-system" : ""}`;
    const name = document.createElement("strong");
    name.className = "chat-message-name";
    name.textContent = message.name;
    const header = document.createElement("div");
    header.className = "chat-message-head";
    const avatar = document.createElement("span");
    avatar.className = "chat-message-avatar";
    window.JukeboxAvatars?.apply(avatar, { avatarUrl: message.avatarUrl, name: message.name, fallback: false });
    if (message.rank?.badge) {
      const rankBadge = document.createElement("span");
      rankBadge.className = "chat-message-rank";
      rankBadge.textContent = `${message.rank.badge} ${message.rank.name || ""}`.trim();
      rankBadge.title = message.rank.name || "Hạng thành viên";
      name.append(" ", rankBadge);
    }
    if (message.isAdmin || message.isAI || message.isSystem) {
      const badge = document.createElement("span");
      badge.className = "chat-message-badge";
      badge.textContent = message.isAI ? "AI" : message.isSystem ? "MỐC THƯỞNG" : "ADMIN";
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
    header.append(avatar, name);
    item.append(header, text, meta);
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
    isSystem: message.isSystem === true,
    createdAt: typeof message.createdAt === "string" ? message.createdAt : "",
    avatarUrl: window.JukeboxAvatars?.safeUrl(message.avatarUrl) || "",
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
  All: [
    "__vn_hits",
    `V-pop ${THIS_YEAR}`,
    `nhạc Việt ${THIS_YEAR}`,
    `K-pop ${THIS_YEAR}`,
    "party anthems",
    "nhạc trẻ thịnh hành",
    "hit việt mới nhất",
    "nhạc hot tiktok",
    "indie việt",
    "rap việt",
    "acoustic việt",
    "lofi chill việt",
    "nhạc trẻ tuyển chọn",
    "nhạc việt hay nhất"
  ],
  // This tab intentionally has no singer chips: graduation music is a theme,
  // not an artist list (there is no GENRE_SLUG entry, so the row stays empty).
  Graduation: [
    "nhạc tốt nghiệp",
    "nhạc chia tay tuổi học trò",
    "nhạc về tình bạn",
    "graduation songs",
    "Tạm Biệt Nhé Lynk Lee",
    "Mình Cùng Nhau Đóng Băng Thùy Chi",
    "Nụ Cười 18 20 Doãn Hiếu",
    "Mong Ước Kỷ Niệm Xưa",
    "Ngày Ấy Bạn Và Tôi",
    "Xe Đạp Thùy Chi",
    "Nhắn Gửi Thanh Xuân",
    "thanh xuân học trò",
    "kỷ niệm mái trường",
    "nhạc tri ân thầy cô",
    "bài học đầu tiên",
    "bụi phấn",
    "thời học sinh",
    "tình thơ",
    "cho bạn cho tôi",
    "sổ lưu bút"
  ],
  "K-pop": [
    `K-pop ${THIS_YEAR}`,
    "K-pop dance hits",
    "K-pop girl group hits",
    "NewJeans",
    "BLACKPINK",
    "BTS",
    "aespa",
    "IVE",
    "LE SSERAFIM",
    "TWICE",
    "SEVENTEEN",
    "Stray Kids",
    "BABYMONSTER",
    "ILLIT",
    "IU",
    "(G)I-DLE",
    "ITZY",
    "TXT",
    "ENHYPEN",
    "Red Velvet"
  ],
  VPop: [
    `V-pop ${THIS_YEAR}`,
    `nhạc Việt mới ${THIS_YEAR}`,
    "V-pop thịnh hành",
    "nhạc trẻ Việt Nam",
    "hit việt mới nhất",
    "Sơn Tùng M-TP",
    "HIEUTHUHAI",
    "MONO",
    "Wren Evans",
    "RPT MCK",
    "Tăng Duy Tân",
    "Vũ.",
    "SOOBIN",
    "Grey D",
    "Đức Phúc",
    "Hòa Minzy",
    "AMEE",
    "Phương Ly",
    "Chillies",
    "Hoàng Dũng"
  ],
  Bolero: [
    "nhạc trữ tình Việt Nam",
    "bolero Việt Nam",
    "nhạc vàng hay nhất",
    "nhạc quê hương trữ tình",
    "Quang Lê",
    "Như Quỳnh bolero",
    "Lệ Quyên bolero",
    "Chế Linh",
    "Phi Nhung",
    "Giao Linh",
    "Đan Trường bolero",
    "Cẩm Ly bolero",
    "Mạnh Quỳnh",
    "Ngọc Sơn",
    "Tuấn Vũ",
    "Duy Khánh",
    "Trường Vũ",
    "Hương Lan"
  ],
  Western: [
    "top pop hits",
    `pop hits ${THIS_YEAR}`,
    "classic pop anthems",
    "Taylor Swift",
    "Bruno Mars",
    "Ed Sheeran",
    "The Weeknd",
    "Billie Eilish",
    "Dua Lipa",
    "Coldplay",
    "Ariana Grande",
    "Justin Bieber",
    "Maroon 5",
    "Sabrina Carpenter",
    "Charlie Puth",
    "Lady Gaga",
    "Adele"
  ],
  Party: [
    "party dance hits",
    "EDM anthems",
    "dancefloor classics",
    "Calvin Harris",
    "David Guetta",
    "Avicii",
    "The Chainsmokers",
    "Marshmello",
    "Alan Walker",
    "Zedd",
    "vinahouse remix",
    "EDM festival",
    "Martin Garrix",
    "Tiësto",
    "DJ Snake"
  ],
  Classics: [
    "nhạc Việt xưa",
    "nhạc vàng Việt Nam",
    "nhạc trữ tình thập niên 90",
    "bolero kinh điển",
    "Mỹ Tâm",
    "Lam Trường",
    "Phương Thanh",
    "Hồng Nhung",
    "Quang Dũng",
    "Ưng Hoàng Phúc",
    "Làn Sóng Xanh",
    "Bằng Kiều",
    "Thanh Lam",
    "Lê Hiếu",
    "Đan Trường",
    "Cẩm Ly"
  ],
};

// Curated Spotify discovery queries — targeted to track/artist hits to avoid
// full-text matching unrelated foreign songs or unintended genres.
const GENRE_QUERIES_SPOTIFY = {
  All: [
    "top hits vietnam",
    "V-Pop Không Thể Thiếu",
    "Thiên Hạ Nghe Gì",
    "nhạc trẻ thịnh hành",
    "hit việt mới nhất",
    "nhạc việt hay nhất",
    "Vietnam Top 50",
    "Viral 50 Vietnam",
    "V-Pop Rising",
    "V-Pop All Stars",
    "nhạc hot tiktok việt nam",
    "nhạc việt thịnh hành",
    "nhạc trẻ tuyển chọn",
    "indie việt hay nhất",
    "rap việt hot nhất",
    "gen z việt nam",
    "ballad việt ngọt ngào",
    "acoustic việt chill",
    "lofi chill việt",
    "nhạc cà phê việt",
    "tình ca việt nam",
    "nhạc remix việt hot",
    "Sơn Tùng M-TP",
    "HIEUTHUHAI",
    "Vũ.",
    "SOOBIN",
    "tlinh",
    "RPT MCK",
    "Grey D",
    "Wren Evans",
    "Tăng Duy Tân",
    "AMEE",
    "Đức Phúc",
    "Hòa Minzy",
    "Phương Ly",
    "Chillies",
    "Bích Phương",
    "ERIK",
    "Orange",
    "Hoàng Dũng",
    "Phan Mạnh Quỳnh",
    "Quang Hùng MasterD",
    "MONO",
    "Da LAB",
    "Bùi Anh Tuấn",
    "Noo Phước Thịnh",
    "Vũ Cát Tường",
    "Trang",
    "Thịnh Suy"
  ],
  Graduation: [
    "Tạm Biệt Nhé Lynk Lee",
    "Mình Cùng Nhau Đóng Băng Thùy Chi",
    "Nụ Cười 18 20 Doãn Hiếu",
    "Mong Ước Kỷ Niệm Xưa",
    "Ngày Ấy Bạn Và Tôi Lynk Lee",
    "Xe Đạp Thùy Chi",
    "Tạm Biệt Tuổi Học Trò",
    "Thanh Xuân Của Chúng Ta Bùi Anh Tuấn",
    "Nhắn Gửi Thanh Xuân Hương Tràm",
    "Góc Ban Công Lynk Lee",
    "Bài Học Đầu Tiên",
    "Bụi Phấn",
    "Người Thầy Khánh Ly",
    "Thầy Cô Cho Em Mùa Xuân",
    "Tiết Học Cuối Cùng",
    "Giấc Mơ Thần Tiên Miu Lê",
    "Kỷ Niệm Mái Trường",
    "Áo Trắng Đến Trường",
    "Thời Học Sinh Suni Hạ Linh",
    "Thanh Xuân Đẹp Nhất",
    "Chuyến Xe Tuổi Trẻ",
    "Cho Bạn Cho Tôi Lam Trường",
    "Sổ Lưu Bút",
    "Phượng Hồng",
    "Thời Gian Sẽ Trả Lời",
    "Mùa Hạ Cuối Cùng",
    "Học Trò Ơi",
    "Tình Thơ Lam Trường",
    "Thanh Xuân Có Nhau",
    "Chia Tay Tuổi Học Trò",
    "Lời Thầy Cô",
    "Lưu Bút Tuổi Xanh",
    "Con Đường Đến Trường",
    "Mái Trường Mến Yêu",
    "Ngồi Lại Bên Nhau",
    "Tuổi Mộng Mơ",
    "Thanh Xuân Đã Qua",
    "Kỷ Yếu Tuổi Học Trò",
    "Bài Ca Người Giáo Viên Nhân Dân",
    "Bàn Tay Thầy",
    "Bụi Phấn Rơi",
    "Tạm Biệt Mái Trường",
    "Gửi Lại Thanh Xuân",
    "Tuổi Học Trò Ngây Thơ",
    "nhạc tuổi học trò",
    "nhạc tốt nghiệp ý nghĩa",
    "nhạc chia tay bạn bè",
    "nhạc thanh xuân kỷ niệm",
    "nhạc tri ân thầy cô"
  ],
  "K-pop": [
    "K-Pop ON!",
    "Top K-Pop Tracks",
    "K-Pop Rising",
    "K-Pop Daebak",
    "K-pop girl group hits",
    "K-pop dance hits",
    "K-pop top hits",
    "K-pop chill",
    "NewJeans",
    "BLACKPINK",
    "BTS",
    "aespa",
    "IVE",
    "LE SSERAFIM",
    "TWICE",
    "SEVENTEEN",
    "BABYMONSTER",
    "ILLIT",
    "Stray Kids",
    "IU",
    "(G)I-DLE",
    "ITZY",
    "ENHYPEN",
    "TOMORROW X TOGETHER",
    "RIIZE",
    "BOYNEXTDOOR",
    "TWS",
    "NMIXX",
    "Red Velvet",
    "EXO",
    "NCT 127",
    "NCT DREAM",
    "BIGBANG",
    "Girls' Generation",
    "2NE1",
    "Super Junior",
    "SHINee",
    "Taeyeon",
    "Jungkook",
    "Jimin",
    "V bts",
    "Jennie",
    "Rosé",
    "Lisa",
    "G-DRAGON",
    "Zico",
    "MAMAMOO",
    "TREASURE",
    "ATEEZ",
    "KISS OF LIFE"
  ],
  VPop: [
    "V-Pop Không Thể Thiếu",
    "Thiên Hạ Nghe Gì",
    "Top Hits Vietnam",
    "nhạc trẻ thịnh hành",
    "hit việt mới nhất",
    "nhạc việt hay nhất",
    "nhạc việt mới",
    "V-Pop Rising",
    "V-Pop All Stars",
    "Nhạc Việt Quốc Dân",
    "Indie Việt Hay Nhất",
    "Rap Việt Mới Nhất",
    "Gen Z Music Việt Nam",
    "Ballad Việt Hay Nhất",
    "Pop R&B Việt Nam",
    "nhạc chill việt nam",
    "nhạc việt lãng mạn",
    "nhạc acoustic việt nam",
    "Sơn Tùng M-TP",
    "HIEUTHUHAI",
    "MONO",
    "Wren Evans",
    "RPT MCK",
    "Tăng Duy Tân",
    "Bích Phương",
    "MIN",
    "AMEE",
    "Đức Phúc",
    "Hòa Minzy",
    "SOOBIN",
    "Isaac",
    "Vũ.",
    "tlinh",
    "Phương Ly",
    "Grey D",
    "Quang Hùng MasterD",
    "Erik",
    "Bùi Anh Tuấn",
    "Noo Phước Thịnh",
    "Jack J97",
    "Chillies",
    "Hoàng Dũng",
    "Vũ Cát Tường",
    "Phan Mạnh Quỳnh",
    "Thịnh Suy",
    "Trang",
    "Ngọt",
    "Da LAB",
    "Orange",
    "LyLy"
  ],
  Bolero: [
    "Tuyệt Đỉnh Bolero",
    "Bolero Trữ Tình Hay Nhất",
    "Quán Nửa Khuya Bolero",
    "Nhạc Vàng Quê Hương",
    "Tình Ca Bolero",
    "Tuyệt Phẩm Nhạc Vàng",
    "nhạc vàng trữ tình xưa",
    "tình khúc bolero bất hủ",
    "nhạc quê hương trữ tình",
    "bolero hải ngoại",
    "nhạc sầu bolero",
    "bolero tiền chiến",
    "nhạc trữ tình chọn lọc",
    "Quang Lê",
    "Như Quỳnh bolero",
    "Lệ Quyên bolero",
    "Chế Linh",
    "Phi Nhung",
    "Giao Linh",
    "Đan Trường bolero",
    "Cẩm Ly bolero",
    "Mạnh Quỳnh",
    "Ngọc Sơn",
    "Duy Khánh",
    "Tuấn Vũ",
    "Khánh Ly",
    "Hương Lan",
    "Thanh Tuyền",
    "Trường Vũ",
    "Bảo Yến",
    "Phương Dung",
    "Hoàng Oanh",
    "Tâm Đoan",
    "Mai Thiên Vân",
    "Huỳnh Nguyễn Công Bằng",
    "Dương Hồng Loan",
    "Lưu Ánh Loan",
    "Nguyễn Phú Quý",
    "Quỳnh Trang bolero",
    "Tuyết Nhung bolero",
    "Bằng Kiều bolero",
    "Đàm Vĩnh Hưng bolero",
    "Thái Châu",
    "Phi Nhung Mạnh Quỳnh",
    "Quang Lê Như Quỳnh",
    "Hạ Vy bolero",
    "Giang Châu bolero",
    "tình xưa bolero",
    "nhạc xưa việt nam"
  ],
  Western: [
    "Today's Top Hits",
    "Pop Rising",
    "Mega Hit Mix",
    "All Out 2020s",
    "All Out 2010s",
    "All Out 2000s",
    "Billboard Hot 100",
    "Global Top 50",
    "Pop Chillout",
    "Acoustic Pop Western",
    "Soft Pop Hits",
    "R&B Hits",
    "Taylor Swift",
    "Bruno Mars",
    "Ed Sheeran",
    "The Weeknd",
    "Billie Eilish",
    "Dua Lipa",
    "Adele",
    "Olivia Rodrigo",
    "Coldplay",
    "Ariana Grande",
    "Justin Bieber",
    "Maroon 5",
    "Sabrina Carpenter",
    "Charlie Puth",
    "Post Malone",
    "Lady Gaga",
    "Beyoncé",
    "Harry Styles",
    "Rihanna",
    "Katy Perry",
    "Shawn Mendes",
    "Sam Smith",
    "SZA",
    "Drake",
    "Kendrick Lamar",
    "Eminem",
    "Imagine Dragons",
    "OneRepublic",
    "Sia",
    "Lana Del Rey",
    "Miley Cyrus",
    "Doja Cat",
    "Camila Cabello",
    "Chappell Roan",
    "Teddy Swims",
    "Benson Boone",
    "One Direction",
    "Hozier"
  ],
  Party: [
    "Dance Party",
    "EDM Hits",
    "Festival Bangers",
    "Club Anthems",
    "House Party",
    "Dance Pop",
    "Party Starter",
    "Night Out",
    "Remix Việt Bay Lắc",
    "Vinahouse Hay Nhất",
    "EDM Mainstage",
    "Bass Boosted Party",
    "Summer Dance Hits",
    "Electro House Hits",
    "Calvin Harris",
    "David Guetta",
    "Avicii",
    "The Chainsmokers",
    "Marshmello",
    "Alan Walker",
    "Zedd",
    "Kygo",
    "Pitbull",
    "Black Eyed Peas",
    "Tiësto",
    "Martin Garrix",
    "Skrillex",
    "DJ Snake",
    "Diplo",
    "Major Lazer",
    "Steve Aoki",
    "Afrojack",
    "Hardwell",
    "Swedish House Mafia",
    "Armin van Buuren",
    "Fisher",
    "Peggy Gou",
    "Fred again..",
    "Alok",
    "KSHMR",
    "Galantis",
    "Robin Schulz",
    "Lost Frequencies",
    "Daft Punk",
    "LMFAO",
    "Flo Rida",
    "Clean Bandit",
    "Jonas Blue",
    "Alesso"
  ],
  Classics: [
    "Làn Sóng Xanh Thời Đầu",
    "Nhạc Trẻ Thập Niên 90",
    "Nhạc Trẻ Thập Niên 2000",
    "Tình Khúc Vàng",
    "Nhạc Xưa Bất Hủ",
    "Những Bài Ca Đi Cùng Năm Tháng",
    "Nhạc Tiền Chiến Bất Hủ",
    "Tình Khúc Trịnh Công Sơn",
    "Tình Khúc Ngô Thụy Miên",
    "Tình Khúc Lam Phương",
    "Tình Khúc Vũ Thành An",
    "Tuyệt Phẩm Nhạc Trẻ 2000",
    "Nhạc Phim Việt Nam Kinh Điển",
    "Mỹ Tâm",
    "Lam Trường",
    "Phương Thanh",
    "Hồng Nhung",
    "Quang Dũng",
    "Thanh Lam",
    "Lê Hiếu",
    "Ưng Hoàng Phúc",
    "Đan Trường",
    "Cẩm Ly",
    "Khánh Ly",
    "Bằng Kiều",
    "Trần Thu Hà",
    "Mỹ Linh",
    "Thu Phương",
    "Tuấn Ngọc",
    "Ý Lan",
    "Nguyễn Hưng",
    "Thanh Hà",
    "Jimmii Nguyễn",
    "Quang Vinh",
    "Bảo Thy",
    "Đông Nhi",
    "Noo Phước Thịnh",
    "Tuấn Hưng",
    "Duy Mạnh",
    "Minh Tuyết",
    "Phạm Quỳnh Anh",
    "Hiền Thục",
    "Hồ Quỳnh Hương",
    "Lệ Quyên",
    "Elvis Phương",
    "Thái Hiền",
    "Sỹ Phú",
    "Trịnh Công Sơn",
    "Ngô Thụy Miên"
  ]
};

// Official Spotify CDN Artist Avatars
const ARTIST_AVATARS = {
  "Sơn Tùng M-TP": "https://i.scdn.co/image/ab676161000051748885185d1e914c51c15c3a13",
  "HIEUTHUHAI": "https://i.scdn.co/image/ab67616100005174f39f3b8365b39fd757b442d7",
  "MONO": "https://i.scdn.co/image/ab67616100005174a0936954c350fe8e9aaf1add",
  "Wren Evans": "https://i.scdn.co/image/ab676161000051749df9185bb090509181d1f275",
  "RPT MCK": "https://i.scdn.co/image/ab676161000051746a6065f675433dde99716a7e",
  "Tăng Duy Tân": "https://i.scdn.co/image/ab67616100005174f62a5dda940d17262800d582",
  "Bích Phương": "https://i.scdn.co/image/ab67616100005174906404e01b48537145d163ba",
  "MIN": "https://i.scdn.co/image/ab676161000051747a2969bce359f6c1a39b26a8",
  "AMEE": "https://i.scdn.co/image/ab67616100005174fd70279a04a9b3796e7dcd4d",
  "Đức Phúc": "https://i.scdn.co/image/ab67616100005174e4b06740e275331ee84c5a26",
  "Hòa Minzy": "https://i.scdn.co/image/ab6761610000517439aa67b9769a50405845c15a",
  "SOOBIN": "https://i.scdn.co/image/ab6761610000517430db194110c51d9e7fd3c7e7",
  "Isaac": "https://i.scdn.co/image/ab67616100005174391cabbe4921e4363301157b",
  "Vũ.": "https://i.scdn.co/image/ab676161000051742d7150aa7e90e9a85610ab3d",
  "tlinh": "https://i.scdn.co/image/ab67616100005174cd3c7bfb73a04b6b481e9357",
  "Phương Ly": "https://i.scdn.co/image/ab67616100005174d44b24dd66374b59c07e319e",
  "Grey D": "https://i.scdn.co/image/ab676161000051749f18e7cce7be5f16dc7103f8",
  "Quang Hùng MasterD": "https://i.scdn.co/image/ab67616100005174114e6e6e87d44db768bc8cea",
  "Lệ Quyên": "https://i.scdn.co/image/ab67616100005174ea9b15c80810bae0bb0e87ad",
  "Đàm Vĩnh Hưng": "https://i.scdn.co/image/ab67616100005174254b884054d5c995519dcb62",
  "Quang Lê": "https://i.scdn.co/image/ab67616100005174f3592639d5d6ef4a66f1f8c0",
  "Như Quỳnh": "https://i.scdn.co/image/ab67616100005174747c4ac04d72b0672d19acc8",
  "Phi Nhung": "https://i.scdn.co/image/ab67616d00001e025b196058a535f9f2ff617187",
  "Cẩm Ly": "https://i.scdn.co/image/ab67616100005174c4ae488af28de73b81fbb82c",
  "Đan Trường": "https://i.scdn.co/image/ab6761610000517424a75319586262b8fb2b3a23",
  "Chế Linh": "https://i.scdn.co/image/ab67616100005174f75ab9e4c7d4526a5d392d20",
  "Mạnh Quỳnh": "https://i.scdn.co/image/ab676161000051746e12fc9c5fc152e0fbc385e0",
  "Ngọc Sơn": "https://i.scdn.co/image/ab67616d00001e025d301f9b9a0aea3d4d35fc26",
  "Duy Khánh": "https://i.scdn.co/image/ab67616d00001e021d9245157a30e1c3780c3125",
  "Tuấn Vũ": "https://i.scdn.co/image/ab67616d00001e02c8d1946440a3c674a5e4cd39",
  "Giao Linh": "https://i.scdn.co/image/ab67616d00001e02903000971d8a500b919efb62",
  "Khánh Ly": "https://i.scdn.co/image/ab67616d00001e025c67e87133fcec5d6e9144bf",
  "Bằng Kiều": "https://i.scdn.co/image/ab67616100005174004ae448e0ac5f697c71d654",
  "NewJeans": "https://i.scdn.co/image/ab67616100005174841bdcf28a956f3a384ffcf4",
  "BTS": "https://i.scdn.co/image/ab67616100005174f80ec63ea7a0ef0fba60957d",
  "BLACKPINK": "https://i.scdn.co/image/ab67616100005174623538b7014238c54ceee056",
  "aespa": "https://i.scdn.co/image/ab67616100005174053bbb910dda6d4ab0618b8b",
  "TWICE": "https://i.scdn.co/image/ab676161000051743d8820046fd455b38d644864",
  "SEVENTEEN": "https://i.scdn.co/image/ab676161000051748da3a229445fd3cd896cdd5c",
  "Stray Kids": "https://i.scdn.co/image/ab6761610000517491be1e574fd2e0992f94decb",
  "IVE": "https://i.scdn.co/image/ab67616100005174e9134cc9371327f8238b1840",
  "LE SSERAFIM": "https://i.scdn.co/image/ab67616100005174b976b6defd4f7343c78d63c0",
  "IU": "https://i.scdn.co/image/ab67616100005174617ede1145fa0b7d1076129a",
  "(G)I-DLE": "https://i.scdn.co/image/ab67616100005174a6d269fc34884864c3f0f914",
  "ITZY": "https://i.scdn.co/image/ab67616100005174a60be8af61d6184cd0402f80",
  "ENHYPEN": "https://i.scdn.co/image/ab67616100005174f28334d02274b673b8201299",
  "TXT": "https://i.scdn.co/image/ab6761610000517454fc4bff90d96d3ef0179e62",
  "BABYMONSTER": "https://i.scdn.co/image/ab6761610000517443a4c69b563a55f307bde271",
  "ILLIT": "https://i.scdn.co/image/ab676161000051747fabcc2491d95050faa5b710",
  "Taylor Swift": "https://i.scdn.co/image/ab67616100005174becdf71ce387eccac2a8c66e",
  "Bruno Mars": "https://i.scdn.co/image/ab67616100005174c7688aad1bf03986934d7e26",
  "Ed Sheeran": "https://i.scdn.co/image/ab67616100005174d55c95ad400aed87da52daec",
  "The Weeknd": "https://i.scdn.co/image/ab67616100005174c1719ac9e6a75c1c25835018",
  "Billie Eilish": "https://i.scdn.co/image/ab676161000051744a21b4760d2ecb7b0dcdc8da",
  "Dua Lipa": "https://i.scdn.co/image/ab676161000051740c68f6c95232e716f0abee8d",
  "Adele": "https://i.scdn.co/image/ab6761610000517468f6e5892075d7f22615bd17",
  "Olivia Rodrigo": "https://i.scdn.co/image/ab67616100005174b14eb4dcfd2f3858bed06e44",
  "Ariana Grande": "https://i.scdn.co/image/ab6761610000517468412f2d0177a9ebc265ff58",
  "Justin Bieber": "https://i.scdn.co/image/ab67616100005174af20f7db5288bce9beede034",
  "Coldplay": "https://i.scdn.co/image/ab676161000051741ba8fc5f5c73e7e9313cc6eb",
  "Maroon 5": "https://i.scdn.co/image/ab67616100005174f8349dfb619a7f842242de77",
  "Sabrina Carpenter": "https://i.scdn.co/image/ab6761610000517478e45cfa4697ce3c437cb455",
  "Charlie Puth": "https://i.scdn.co/image/ab676161000051746721f541fb123145d4cb3ace",
  "Calvin Harris": "https://i.scdn.co/image/ab676161000051748ebba5e60113b48de8c11f6b",
  "David Guetta": "https://i.scdn.co/image/ab67616100005174f150017ca69c8793503c2d4f",
  "Avicii": "https://i.scdn.co/image/ab67616100005174ae07171f989fb39736674113",
  "Black Eyed Peas": "https://i.scdn.co/image/ab67616100005174f2200ce505d25e1d7e1561be",
  "The Chainsmokers": "https://i.scdn.co/image/ab676161000051744567279fac84a0375c3d819b",
  "Marshmello": "https://i.scdn.co/image/ab67616100005174fa62d7b4d09a4ea9b4c5f05d",
  "Alan Walker": "https://i.scdn.co/image/ab67616100005174572a8eae56feae217f618078",
  "Kygo": "https://i.scdn.co/image/ab67616100005174e5ea1aa1404629c12ad86658",
  "Pitbull": "https://i.scdn.co/image/ab67616100005174e75db75543a89589514259b2",
  "Zedd": "https://i.scdn.co/image/ab67616100005174eefa05f0b8fcafd4beb19d31",
  "Mỹ Tâm": "https://i.scdn.co/image/ab676161000051745d4a6001ce67c78aa3873c6a",
  "Lam Trường": "https://i.scdn.co/image/ab67616100005174a61c5c97b1b318f1b04fcd97",
  "Phương Thanh": "https://i.scdn.co/image/ab676161000051746fd1664084748ff23fc8825e",
  "Hồng Nhung": "https://i.scdn.co/image/ab67616100005174ea82dc852299be010ce41f97",
  "Quang Dũng": "https://i.scdn.co/image/ab67616100005174380b20bffad8c5cab7decf75",
  "Thanh Lam": "https://i.scdn.co/image/ab67616d00001e02b6a9ebe9a5d62bc553973262",
  "Lê Hiếu": "https://i.scdn.co/image/ab676161000051742a3fdc3fb15974c8e07c04fb",
  "Ưng Hoàng Phúc": "https://i.scdn.co/image/ab676161000051744531871401673bf445597001",
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
  { n: "MONO", q: "MONO Việt Nam", sq: "MONO", g: "vpop" },
  { n: "Wren Evans", q: "Wren Evans", g: "vpop" },
  { n: "RPT MCK", q: "RPT MCK", sq: "MCK", g: "vpop" },
  { n: "Tăng Duy Tân", q: "Tăng Duy Tân", g: "vpop" },
  { n: "Bích Phương", q: "Bích Phương", g: "vpop" },
  { n: "MIN", q: "MIN Việt Nam", sq: "MIN", g: "vpop" },
  { n: "AMEE", q: "AMEE", g: "vpop" },
  { n: "Đức Phúc", q: "Đức Phúc", g: "vpop" },
  { n: "Hòa Minzy", q: "Hòa Minzy", g: "vpop" },
  { n: "SOOBIN", q: "SOOBIN", sq: "SOOBIN", g: "vpop" },
  { n: "Isaac", q: "Isaac Việt Nam", sq: "Isaac", g: "vpop" },
  { n: "Vũ.", q: "Vũ. ca sĩ", sq: "Vũ.", g: "vpop" },
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
  { n: "Duy Khánh", q: "Duy Khánh nhạc vàng", sq: "Duy Khánh", g: "bolero" },
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
  { n: "(G)I-DLE", q: "(G)I-DLE", sq: "(G)I-DLE", g: "kpop" },
  { n: "ITZY", q: "ITZY", g: "kpop" },
  { n: "ENHYPEN", q: "ENHYPEN", g: "kpop" },
  { n: "TXT", q: "TOMORROW X TOGETHER", sq: "TOMORROW X TOGETHER", g: "kpop" },
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

favoritesToggle.addEventListener("click", () => {
  if (favoritesViewActive) backToExplore();
  else void showFavorites();
});

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
    const avatarUrl = ARTIST_AVATARS[s.n] || "";
    btn.innerHTML = `
      <span class="singer-avatar g-${s.g}">
        <span class="singer-avatar-initial"></span>
        ${avatarUrl ? `<img class="singer-avatar-img" src="${avatarUrl}" alt="${s.n}" loading="lazy" onerror="this.remove()" />` : ""}
      </span>
      <span class="singer-name"></span>
    `;
    btn.querySelector(".singer-avatar-initial").textContent = [...s.n][0];
    btn.querySelector(".singer-name").textContent = s.n;
    btn.onclick = () => selectSinger(s);
    row.appendChild(btn);
  }
}

function selectGenre(g) {
  setFavoritesView(false);
  activeGenre = g;
  activeKey = `genre:${g}`;
  renderGenreTabs();
  renderSingers();
  const queries = currentSearchPlatform === "spotify"
    ? (GENRE_QUERIES_SPOTIFY[g] || GENRE_QUERIES[g])
    : GENRE_QUERIES[g];
  startBrowse(queries);
}

function selectSinger(s) {
  activeKey = `singer:${s.n}`;
  renderGenreTabs();
  renderSingers();
  if (currentSearchPlatform === "spotify") {
    const sq = s.sq || "";
    startBrowse([
      `artist:::${s.n}:::${sq}:::0`,
      `artist:::${s.n}:::${sq}:::1`,
      `artist:::${s.n}:::${sq}:::2`,
      `artist:::${s.n}:::${sq}:::3`,
      `artist:::${s.n}:::${sq}:::4`,
      `artist:::${s.n}:::${sq}:::5`,
      `artist:::${s.n}:::${sq}:::6`,
      `artist:::${s.n}:::${sq}:::7`,
      `artist:::${s.n}:::${sq}:::8`,
      `artist:::${s.n}:::${sq}:::9`
    ]);
  } else {
    startBrowse([
      s.q,
      `${s.q} bài hát nổi bật`,
      `${s.q} hits`,
      `${s.q} top hits`,
      `${s.q} hay nhất`,
      `${s.q} tuyển chọn`,
      `${s.q} album`,
      `${s.q} liveshow`
    ]);
  }
}

// ---- Load More Card (+ Card) in Results Grid -----------------------------
function removeLoadMoreCard() {
  resultsEl.querySelectorAll(".load-more-card").forEach((el) => el.remove());
}

function createLoadMoreCard(onClick) {
  const li = document.createElement("li");
  li.className = "load-more-card";
  li.setAttribute("role", "button");
  li.setAttribute("tabindex", "0");
  li.setAttribute("title", "Tìm thêm bài hát");
  li.setAttribute("aria-label", "Tìm thêm bài hát");
  li.innerHTML = `
    <div class="load-more-icon-wrap">
      <svg class="load-more-plus" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="5" x2="12" y2="19"></line>
        <line x1="5" y1="12" x2="19" y2="12"></line>
      </svg>
      <svg class="load-more-spinner hidden" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
        <circle cx="12" cy="12" r="9" stroke-opacity="0.25" stroke="currentColor"></circle>
        <path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor"></path>
      </svg>
    </div>
  `;

  let busy = false;
  const trigger = async (e) => {
    e?.preventDefault?.();
    if (busy || li.classList.contains("is-loading")) return;
    busy = true;
    li.classList.add("is-loading");
    li.querySelector(".load-more-plus")?.classList.add("hidden");
    li.querySelector(".load-more-spinner")?.classList.remove("hidden");
    li.setAttribute("aria-busy", "true");
    try {
      await Promise.all([
        onClick(),
        new Promise((resolve) => setTimeout(resolve, 350)),
      ]);
    } finally {
      busy = false;
      if (li.isConnected) {
        li.classList.remove("is-loading");
        li.querySelector(".load-more-plus")?.classList.remove("hidden");
        li.querySelector(".load-more-spinner")?.classList.add("hidden");
        li.removeAttribute("aria-busy");
      }
    }
  };

  li.addEventListener("click", trigger);
  li.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      trigger(e);
    }
  });

  return li;
}

async function startBrowse(queries) {
  browse.queries = queries;
  browse.idx = 0;
  browse.page = 0;
  browse.seen = new Set();
  browse.gen++; // invalidate any loadMoreSongs call from the previous tab/search
  resultsEl.innerHTML = "";
  removeLoadMoreCard();
  moreBtn?.classList.add("hidden");
  await loadMoreSongs();
}

// Walk query variants (one /api/browse call per variant) until at least one
// unseen song is found or variants are exhausted. A variant containing only
// duplicates must not silently add nothing (D3).
async function loadMoreSongs() {
  const gen = browse.gen;
  if (browse.seen.size === 0) {
    removeLoadMoreCard();
    setLoading(true, currentSearchPlatform === "spotify" ? "Đang tải bài hát Spotify…" : "Đang tải bài hát…");
  }
  try {
    const isSpotify = currentSearchPlatform === "spotify";
    const isSingerBrowse = typeof activeKey === "string" && activeKey.startsWith("singer:");
    const maxPages = isSpotify && !isSingerBrowse ? 5 : 1;

    while (browse.idx < browse.queries.length || (browse.page || 0) + 1 < maxPages) {
      if (browse.idx >= browse.queries.length) {
        if ((browse.page || 0) + 1 >= maxPages) break;
        browse.page = (browse.page || 0) + 1;
        browse.idx = 0;
      }
      const q = browse.queries[browse.idx++];
      const pageOffset = (browse.page || 0) * 10;
      const platformParam = isSpotify ? "&platform=spotify" : "";
      const offsetParam = (isSpotify && pageOffset > 0 && !q.startsWith("artist:::")) ? `&offset=${pageOffset}` : "";
      const res = await fetch("/api/browse?q=" + encodeURIComponent(q) + platformParam + offsetParam);
      if (browse.gen !== gen) return; // stale; a newer tab/search/random action replaced it
      const data = await res.json();
      if (browse.gen !== gen) return;
      if (!res.ok) throw new Error(data.error || "Không thể tải bài hát.");
      let fresh = (data.results || []).filter((r) => r.videoId && !browse.seen.has(r.videoId));
      if (fresh.length === 0) continue; // all results duplicate; try the next variant
      for (const r of fresh) browse.seen.add(r.videoId);
      if (!isSingerBrowse) {
        fresh = shuffleArray(fresh); // avoid showing the same order every time for generic genre tabs (A4)
      }
      setLoading(false);
      if (data.fallback === "youtube" && data.notice) {
        setStatus(`⚠️ ${data.notice}`);
      } else {
        setStatus("");
      }
      appendResults(fresh);
      break;
    }
    if (browse.gen === gen) {
      setLoading(false);
      const hasMoreQueries = browse.idx < browse.queries.length || (browse.page || 0) + 1 < maxPages;
      if (browse.seen.size === 0) {
        removeLoadMoreCard();
        setStatus(isSpotify
          ? "Không tìm thấy bài hát trên Spotify — hãy thử danh mục khác."
          : "Không tìm thấy bài hát — hãy thử danh mục khác.");
      } else if (hasMoreQueries) {
        if (!resultsEl.querySelector(".load-more-card")) {
          resultsEl.appendChild(createLoadMoreCard(loadMoreSongs));
        }
      } else {
        removeLoadMoreCard();
      }
    }
  } catch (err) {
    if (browse.gen === gen) {
      setLoading(false);
      if (browse.seen.size === 0) {
        removeLoadMoreCard();
        if (err.message && (err.message.includes("giới hạn") || err.message.includes("429"))) {
          setStatus(`⚠️ ${err.message} <button class="status-switch-btn" style="margin-left:8px;padding:3px 10px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;display:inline-block;vertical-align:middle;" onclick="window.switchToYouTubePlatform && window.switchToYouTubePlatform()">Chuyển sang YouTube</button>`, { allowHtml: true });
        } else {
          setStatus("😕 " + err.message);
        }
      } else {
        toast("bad", "!", err.message || "Không thể tải thêm bài hát.");
        const isSpotify = currentSearchPlatform === "spotify";
        const isSingerBrowse = typeof activeKey === "string" && activeKey.startsWith("singer:");
        const maxPages = isSpotify && !isSingerBrowse ? 5 : 1;
        const hasMoreQueries = browse.idx < browse.queries.length || (browse.page || 0) + 1 < maxPages;
        if (hasMoreQueries) {
          if (!resultsEl.querySelector(".load-more-card")) {
            resultsEl.appendChild(createLoadMoreCard(loadMoreSongs));
          }
        } else {
          removeLoadMoreCard();
        }
      }
    }
  }
}

document.getElementById("shuffle").onclick = () => {
  // Re-run the current selection with query variants in a new order.
  startBrowse(shuffleArray(browse.queries));
};

// ---- Search Platform Tabs -----------------------------------------------
let currentSearchPlatform = "youtube";

function initSearchPlatformTabs() {
  const tabsWrap = document.getElementById("search-platform-tabs");
  if (!tabsWrap) return;
  const tabs = tabsWrap.querySelectorAll(".platform-tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const targetPlatform = tab.dataset.platform || "youtube";
      if (targetPlatform === currentSearchPlatform) return;
      currentSearchPlatform = targetPlatform;
      tabs.forEach((t) => {
        const isActive = t === tab;
        t.classList.toggle("active", isActive);
        t.setAttribute("aria-selected", isActive ? "true" : "false");
      });
      qEl.placeholder = currentSearchPlatform === "spotify"
        ? "Tìm bài hát hoặc ca sĩ trên Spotify…"
        : "Tìm bài hát hoặc ca sĩ…";
      const currentQuery = qEl.value.trim();
      if (currentQuery && sugSection.classList.contains("hidden")) {
        doSearch(currentQuery);
      } else {
        if (activeKey.startsWith("genre:")) {
          const g = activeKey.replace("genre:", "");
          const queries = currentSearchPlatform === "spotify"
            ? (GENRE_QUERIES_SPOTIFY[g] || GENRE_QUERIES[g])
            : GENRE_QUERIES[g];
          startBrowse(queries);
        } else if (activeKey.startsWith("singer:")) {
          const singerName = activeKey.replace("singer:", "");
          const singerObj = SINGERS.find((s) => s.n === singerName);
          if (singerObj) selectSinger(singerObj);
          else startBrowse(browse.queries);
        } else {
          startBrowse(browse.queries);
        }
      }
    });
  });
}

window.switchToYouTubePlatform = function() {
  const ytTab = document.querySelector('.platform-tab[data-platform="youtube"]');
  if (ytTab) ytTab.click();
};

// ---- Search & Search Pagination ------------------------------------------
const searchState = {
  q: "",
  platform: "youtube",
  offset: 0,
  seen: new Set(),
  hasMore: true,
};

document.getElementById("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  doSearch(qEl.value.trim());
});

async function doSearch(q) {
  if (!q) return backToExplore(); // an empty form restores discovery

  const gen = ++browse.gen; // prevent older requests from overwriting the newest search
  setFavoritesView(false);
  qEl.blur();
  resultsEl.innerHTML = "";
  removeLoadMoreCard();
  sugSection.classList.add("hidden"); // hide discovery while searching
  moreBtn?.classList.add("hidden");
  backToExploreBtn.classList.remove("hidden");

  searchState.q = q;
  searchState.platform = currentSearchPlatform;
  searchState.offset = 0;
  searchState.seen = new Set();
  searchState.hasMore = true;

  await loadMoreSearchResults(gen);
}

async function loadMoreSearchResults(gen = browse.gen) {
  if (searchState.offset === 0) {
    removeLoadMoreCard();
    setLoading(true, searchState.platform === "spotify" ? "Đang tìm kiếm trên Spotify…" : "Đang tìm kiếm…");
  }

  try {
    const platformParam = searchState.platform === "spotify" ? "&platform=spotify" : "";
    const offsetParam = `&offset=${searchState.offset}`;
    const res = await fetch("/api/search?q=" + encodeURIComponent(searchState.q) + platformParam + offsetParam);
    if (browse.gen !== gen) return;
    const data = await res.json();
    if (browse.gen !== gen) return;
    if (!res.ok) throw new Error(data.error || "Tìm kiếm thất bại.");

    setLoading(false);
    if (data.fallback === "youtube" && data.notice) {
      setStatus(`⚠️ ${data.notice}`);
    } else {
      setStatus("");
    }

    const rawResults = data.results || [];
    const fresh = rawResults.filter((r) => r.videoId && !searchState.seen.has(r.videoId));
    for (const r of fresh) searchState.seen.add(r.videoId);

    if (searchState.offset === 0 && fresh.length === 0) {
      searchState.hasMore = false;
      removeLoadMoreCard();
      return setStatus("Không có kết quả, hãy thử từ khóa khác.");
    }

    if (fresh.length > 0) {
      appendResults(fresh);
    }

    if (rawResults.length < 10 || fresh.length === 0) {
      searchState.hasMore = false;
      removeLoadMoreCard();
    } else {
      searchState.offset += 10;
      searchState.hasMore = true;
      if (!resultsEl.querySelector(".load-more-card")) {
        resultsEl.appendChild(createLoadMoreCard(() => loadMoreSearchResults(gen)));
      }
    }
  } catch (err) {
    if (browse.gen === gen) {
      setLoading(false);
      if (searchState.offset === 0) {
        removeLoadMoreCard();
        if (err.message && (err.message.includes("giới hạn") || err.message.includes("429"))) {
          setStatus(`⚠️ ${err.message} <button class="status-switch-btn" style="margin-left:8px;padding:3px 10px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;display:inline-block;vertical-align:middle;" onclick="window.switchToYouTubePlatform && window.switchToYouTubePlatform()">Chuyển sang YouTube</button>`, { allowHtml: true });
        } else {
          setStatus("😕 " + err.message);
        }
      } else {
        toast("bad", "!", err.message || "Không thể tải thêm kết quả.");
        if (searchState.hasMore) {
          if (!resultsEl.querySelector(".load-more-card")) {
            resultsEl.appendChild(createLoadMoreCard(() => loadMoreSearchResults(gen)));
          }
        } else {
          removeLoadMoreCard();
        }
      }
    }
  }
}

// Restore discovery after a search by re-running the selected genre or singer.
function backToExplore() {
  setFavoritesView(false);
  qEl.value = "";
  resultsEl.innerHTML = "";
  removeLoadMoreCard();
  setStatus("");
  backToExploreBtn.classList.add("hidden");
  sugSection.classList.remove("hidden");
  startBrowse(browse.queries);
}

backToExploreBtn.onclick = backToExplore;

function setStatus(text, { allowHtml = false } = {}) {
  statusEl.classList.remove("loading-status");
  if (!text) {
    statusEl.innerHTML = "";
    return statusEl.classList.add("hidden");
  }
  if (allowHtml) {
    statusEl.innerHTML = text;
  } else {
    statusEl.textContent = text;
  }
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
  const badgeHtml = getPlatformIconBadge(r.provider);
  li.innerHTML = `
    <img src="${safeImageUrl(r.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
    <div class="r-meta">
      <div class="r-title-row">
        <span class="r-title"></span>
        ${badgeHtml}
      </div>
      <div class="r-sub"></div>
    </div>
    <div class="r-actions">
      <span class="r-favorite-slot"></span>
      <button class="add-btn" title="Thêm bài hát" aria-label="Thêm bài hát">+</button>
    </div>`;
  li.querySelector(".r-title").textContent = r.title;
  updateMarqueeTitle(li.querySelector(".r-title"));
  li.querySelector(".r-sub").textContent = r.channel + (r.duration ? ` · ${r.duration}` : "");
  li.querySelector(".r-favorite-slot").replaceWith(createFavoriteButton(r, "result-favorite-btn"));
  const btn = li.querySelector(".add-btn");
  btn.onclick = () => requestSong(r, btn);
  return li;
}

function appendResults(results) {
  const loadMoreCard = resultsEl.querySelector(".load-more-card");
  for (const r of results) {
    const card = resultCard(r);
    if (loadMoreCard) {
      resultsEl.insertBefore(card, loadMoreCard);
    } else {
      resultsEl.appendChild(card);
    }
  }
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
  const providerLabel = song.provider === "spotify"
    ? " · Spotify"
    : song.provider === "soundcloud"
      ? " · SoundCloud"
      : song.provider === "tiktok"
        ? " · TikTok"
        : "";
  youtubeLinkSub.textContent = (song.channel || "") + providerLabel;
  youtubeLinkAdd.disabled = false;
  youtubeLinkAdd.textContent = "+";
  youtubeLinkPreview.classList.remove("hidden");
}

youtubeLinkForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = youtubeLinkInput.value.trim();
  if (!url) return setYouTubeLinkStatus("Vui lòng dán link YouTube, Spotify, SoundCloud hoặc TikTok.", "bad");
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
    if (!res.ok || !data.ok) throw new Error(data.reason || "Link bài hát không đúng định dạng hoặc không được hỗ trợ.");
    showYouTubePreview(data.song);
    setYouTubeLinkStatus("Đã tìm thấy bài hát. Bạn có thể thêm vào hàng đợi.", "ok");
  } catch (err) {
    setYouTubeLinkStatus(err.message || "Không thể kiểm tra link bài hát.", "bad");
  } finally {
    youtubeLinkSubmit.disabled = false;
    youtubeLinkSubmit.textContent = "Kiểm tra";
  }
});

youtubeLinkAdd.onclick = () => {
  if (resolvedYouTubeSong) requestSong(resolvedYouTubeSong, youtubeLinkAdd);
};

// ---- Guest device identity ------------------------------------------------
// Send a persisted random ID with every request so the server applies limits
// per device/browser rather than per IP (office Wi-Fi shares one public IP).
function getPersistentClientId() {
  let id = null;
  try { id = localStorage.getItem("clientId"); } catch {}
  if (!id) {
    try { id = sessionStorage.getItem("clientId"); } catch {}
  }
  if (!id && typeof document !== "undefined" && document.cookie) {
    const match = document.cookie.match(/(?:^|;\s*)jukebox_client_id=([^;]+)/);
    if (match && match[1]) id = decodeURIComponent(match[1]);
  }
  if (!id) {
    id = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now().toString(36);
  }
  try { localStorage.setItem("clientId", id); } catch {}
  try { sessionStorage.setItem("clientId", id); } catch {}
  try {
    document.cookie = `jukebox_client_id=${encodeURIComponent(id)}; path=/; max-age=31536000; SameSite=Lax`;
  } catch {}
  return id;
}
const clientId = getPersistentClientId();


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

// ---- Real-time Synced Lyrics (Guest Inline) --------------------------------
let guestLyricsActive = false;
let currentGuestLyrics = null;
let currentGuestLyricsActiveIndex = -1;
let currentGuestLyricsTrackId = "";
let isGuestLyricsLoading = false;
let guestLyricsAnchorPosition = 0; // ms
let guestLyricsAnchorTime = 0; // performance.now()
let guestLyricsPaused = true;
let guestLyricsRafId = null;
let lastGuestTickReceivedTime = 0;
let lastHandledSpotifyTrackId = "";
let userCollapsedTrackId = "";

async function loadGuestLyrics(np, { autoOpen = false } = {}) {
  if (!np || typeof np !== "object") return;
  const rawTitle = np.title || "";
  const rawArtist = np.channel || "";
  const duration = np.duration;
  const trackId = np.videoId || np.id || `${rawArtist.toLowerCase()}:::${rawTitle.toLowerCase()}`;

  if (trackId === currentGuestLyricsTrackId && currentGuestLyrics?.lines && currentGuestLyrics.lines.length > 0) {
    if (autoOpen && !guestLyricsActive) {
      if (String(trackId) === String(userCollapsedTrackId)) {
        return;
      }
      guestLyricsActive = true;
      guestLyricsAnchorPosition = 0;
      guestLyricsAnchorTime = performance.now();
      guestLyricsPaused = false;
      if (lastQueueState) renderQueue(lastQueueState);
      startGuestLyricsSyncLoop();
      if (queueWs && queueWs.readyState === WebSocket.OPEN) {
        queueWs.send(JSON.stringify({ type: "requestPlaybackTick" }));
      }
      return;
    }
    renderGuestLyricsLines(currentGuestLyrics.lines);
    return;
  }
  if (trackId === currentGuestLyricsTrackId && isGuestLyricsLoading) {
    return;
  }

  currentGuestLyricsTrackId = trackId;
  isGuestLyricsLoading = true;
  currentGuestLyrics = null;
  currentGuestLyricsActiveIndex = -1;

  const contentEl = document.getElementById("np-lyrics-content");
  const scrollerEl = document.getElementById("np-lyrics-scroller");
  if (contentEl) {
    contentEl.classList.add("is-loading");
    contentEl.classList.remove("is-empty");
    contentEl.innerHTML = `<div class="np-lyrics-loading">Đang tải lời bài hát đồng bộ…</div>`;
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

  const lyricsClient = window.JukeboxLyrics;
  let data = null;
  try {
    data = lyricsClient
      ? await lyricsClient.fetchLyricsClient({
          title: rawTitle,
          artist: rawArtist,
          artists: Array.isArray(np.artists) ? np.artists : [],
          durationSec: durSec,
        })
      : null;
  } catch (err) {
    console.warn("fetchLyricsClient error:", err);
    data = null;
  }

  if (trackId !== currentGuestLyricsTrackId) return;
  isGuestLyricsLoading = false;

  if (!data || !data.lines || data.lines.length === 0) {
    currentGuestLyrics = { empty: true, lines: [] };
    if (autoOpen && guestLyricsActive) {
      guestLyricsActive = false;
      if (guestLyricsRafId) {
        cancelAnimationFrame(guestLyricsRafId);
        guestLyricsRafId = null;
      }
      if (lastQueueState) renderQueue(lastQueueState);
      return;
    }
    const currentContentEl = document.getElementById("np-lyrics-content");
    const currentScrollerEl = document.getElementById("np-lyrics-scroller");
    if (currentContentEl) {
      currentContentEl.classList.remove("is-loading");
      currentContentEl.classList.add("is-empty");
      currentContentEl.innerHTML = `<div class="np-lyrics-empty"><span>🎵</span><span>Chưa có lời bài hát đồng bộ cho bài hát này.</span></div>`;
    }
    if (currentScrollerEl) {
      currentScrollerEl.classList.remove("is-loading");
      currentScrollerEl.classList.add("is-empty");
    }
    return;
  }

  currentGuestLyrics = data;
  if (autoOpen && !guestLyricsActive) {
    if (String(trackId) === String(userCollapsedTrackId)) {
      return;
    }
    guestLyricsActive = true;
    guestLyricsAnchorPosition = 0;
    guestLyricsAnchorTime = performance.now();
    guestLyricsPaused = false;
    if (lastQueueState) renderQueue(lastQueueState);
    startGuestLyricsSyncLoop();
    if (queueWs && queueWs.readyState === WebSocket.OPEN) {
      queueWs.send(JSON.stringify({ type: "requestPlaybackTick" }));
    }
    return;
  }
  renderGuestLyricsLines(data.lines);
}

function updateLyricsCenterPad(scroller) {
  if (!scroller) return;
  const h = scroller.clientHeight;
  if (h > 0) {
    const pad = Math.max(40, Math.round(h / 2 - 19));
    scroller.style.setProperty("--lyrics-center-pad", `${pad}px`);
  }
}

function renderGuestLyricsLines(lines) {
  const contentEl = document.getElementById("np-lyrics-content");
  const scroller = document.getElementById("np-lyrics-scroller");
  if (!contentEl) return;
  contentEl.classList.remove("is-loading", "is-empty");
  if (scroller) {
    scroller.classList.remove("is-loading", "is-empty");
  }
  contentEl.innerHTML = "";

  const frag = document.createDocumentFragment();
  lines.forEach((line, idx) => {
    const lineEl = document.createElement("div");
    lineEl.className = "guest-lyric-line";
    lineEl.dataset.index = idx;
    lineEl.dataset.time = line.time;
    lineEl.textContent = line.text;
    frag.appendChild(lineEl);
  });
  contentEl.appendChild(frag);

  if (scroller) {
    updateLyricsCenterPad(scroller);
    scroller.scrollTop = 0;
    scroller.scrollTo({ top: 0, behavior: "auto" });
    if (window.ResizeObserver && !scroller._hasLyricsResizeObs) {
      scroller._hasLyricsResizeObs = true;
      const ro = new ResizeObserver(() => {
        updateLyricsCenterPad(scroller);
      });
      ro.observe(scroller);
    }
  }

  currentGuestLyricsActiveIndex = -1;
  const elapsed = (!guestLyricsPaused && guestLyricsAnchorTime > 0)
    ? performance.now() - guestLyricsAnchorTime
    : 0;
  const curPos = Math.max(0, (guestLyricsAnchorPosition || 0) + elapsed) / 1000;
  syncGuestLyricsPosition(curPos, true);
}

function syncGuestLyricsPosition(curSec, forceScroll = false) {
  if (!currentGuestLyrics || !Array.isArray(currentGuestLyrics.lines) || currentGuestLyrics.lines.length === 0) return;
  const lines = currentGuestLyrics.lines;

  let activeIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= curSec + 0.25) {
      activeIdx = i;
    } else {
      break;
    }
  }

  if (activeIdx === currentGuestLyricsActiveIndex && !forceScroll) return;
  currentGuestLyricsActiveIndex = activeIdx;

  const contentEl = document.getElementById("np-lyrics-content");
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

  const scroller = document.getElementById("np-lyrics-scroller");
  if (!scroller) return;

  if (activeIdx >= 0 && lineEls[activeIdx]) {
    const activeEl = lineEls[activeIdx];
    updateLyricsCenterPad(scroller);

    const scrollerRect = scroller.getBoundingClientRect();
    const activeRect = activeEl.getBoundingClientRect();
    const currentScroll = scroller.scrollTop;
    const activeCenter = (activeRect.top - scrollerRect.top) + currentScroll + (activeRect.height / 2);
    const scrollerCenter = scroller.clientHeight / 2;
    const targetScroll = Math.max(0, Math.round(activeCenter - scrollerCenter));

    scroller.scrollTo({
      top: targetScroll,
      behavior: forceScroll ? "auto" : "smooth",
    });
  } else if (forceScroll && activeIdx === -1) {
    scroller.scrollTo({
      top: 0,
      behavior: "auto",
    });
  }
}

function startGuestLyricsSyncLoop() {
  if (guestLyricsRafId) cancelAnimationFrame(guestLyricsRafId);
  let lastAutoTickRequestTime = 0;

  function loop() {
    if (!guestLyricsActive) {
      guestLyricsRafId = null;
      return;
    }

    const now = performance.now();
    const curNp = lastQueueState?.nowPlaying;

    if (!guestLyricsPaused) {
      const elapsed = (guestLyricsAnchorTime > 0) ? (now - guestLyricsAnchorTime) : 0;
      const currentPosMs = Math.max(0, guestLyricsAnchorPosition + elapsed);

      // Periodically request a tick from server if more than 4s without a tick to keep drift low,
      // but do NOT pause; smoothly extrapolate so lyrics never freeze.
      if (lastGuestTickReceivedTime > 0 && now - lastGuestTickReceivedTime > 4000) {
        if (now - lastAutoTickRequestTime > 3000) {
          lastAutoTickRequestTime = now;
          if (queueWs && queueWs.readyState === WebSocket.OPEN) {
            queueWs.send(JSON.stringify({ type: "requestPlaybackTick" }));
          }
        }
      }

      let durMs = Infinity;
      if (curNp?.duration) {
        if (typeof curNp.duration === "number") durMs = curNp.duration * 1000;
        else if (typeof curNp.duration === "string" && curNp.duration.includes(":")) {
          const p = curNp.duration.split(":").map(Number);
          if (p.length === 2) durMs = (p[0] * 60 + p[1]) * 1000;
        }
      }

      if (currentPosMs >= durMs + 5000) {
        guestLyricsPaused = true;
      } else {
        syncGuestLyricsPosition(currentPosMs / 1000);
      }
    } else {
      // While paused, hold position
      syncGuestLyricsPosition(guestLyricsAnchorPosition / 1000);
      // If room state says Spotify is currently playing, check with server if paused state ended
      if (curNp && curNp.provider === "spotify" && now - lastAutoTickRequestTime > 4000) {
        lastAutoTickRequestTime = now;
        if (queueWs && queueWs.readyState === WebSocket.OPEN) {
          queueWs.send(JSON.stringify({ type: "requestPlaybackTick" }));
        }
      }
    }

    guestLyricsRafId = requestAnimationFrame(loop);
  }

  guestLyricsRafId = requestAnimationFrame(loop);
}

function toggleGuestLyrics(active) {
  if (typeof active === "boolean") {
    guestLyricsActive = active;
  } else {
    guestLyricsActive = !guestLyricsActive;
  }

  const np = lastQueueState?.nowPlaying;
  const currentTrackId = np ? (np.videoId || np.id || `${(np.channel || "").toLowerCase()}:::${(np.title || "").toLowerCase()}`) : "";

  if (!guestLyricsActive) {
    if (currentTrackId) {
      userCollapsedTrackId = currentTrackId;
    }
  } else {
    userCollapsedTrackId = "";
  }

  if (guestLyricsActive && (!np || np.provider !== "spotify")) {
    guestLyricsActive = false;
    return;
  }

  const npEl = document.getElementById("now-playing");
  if (!guestLyricsActive && npEl) {
    delete npEl.dataset.lyricsTrackId;
  }

  if (lastQueueState) {
    renderQueue(lastQueueState);
  }

  if (guestLyricsActive && np) {
    guestLyricsPaused = false;
    if (queueWs && queueWs.readyState === WebSocket.OPEN) {
      queueWs.send(JSON.stringify({ type: "requestPlaybackTick" }));
    }
    loadGuestLyrics(np, { autoOpen: false });
    startGuestLyricsSyncLoop();
  } else {
    if (guestLyricsRafId) {
      cancelAnimationFrame(guestLyricsRafId);
      guestLyricsRafId = null;
    }
  }
}

function initGuestLyrics() {
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && guestLyricsActive) {
      toggleGuestLyrics(false);
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && guestLyricsActive && queueWs?.readyState === WebSocket.OPEN) {
      queueWs.send(JSON.stringify({ type: "requestPlaybackTick" }));
    }
  });
}

// ---- Live queue (WebSocket) ------------------------------------------------
let lastQueueState = null; // retain state so the owned-request badge can be redrawn

function restartWs() {
  const previous = queueWs;
  queueWs = null;
  pendingOwnSkips.clear();
  if (previous) {
    previous.onclose = null;
    previous.close();
  }
  connectWs();
}

function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}`);
  queueWs = ws;
  ws.onopen = () => {
    if (guestLyricsActive && queueWs?.readyState === WebSocket.OPEN) {
      queueWs.send(JSON.stringify({ type: "requestPlaybackTick" }));
    }
  };
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
    window.JukeboxNotifications?.handleSocketMessage(msg);
    if (msg.type === "state" && msg.state && typeof msg.state === "object") {
      lastQueueState = msg.state;
      if (typeof msg.queueLimitOn === "boolean") queueLimitOn = msg.queueLimitOn;
      if (typeof msg.queueLimit === "number") queueLimit = msg.queueLimit;
      if (typeof msg.userQueueLimitOn === "boolean") userQueueLimitOn = msg.userQueueLimitOn;
      if (typeof msg.userQueueLimit === "number") userQueueLimit = msg.userQueueLimit;
      if (typeof msg.requireName === "boolean") requireName = msg.requireName;
      if (typeof msg.feedbackOn === "boolean") feedbackOn = msg.feedbackOn;
      if (typeof msg.chatOn === "boolean") chatOn = msg.chatOn;
      if (typeof msg.chatAiOn === "boolean") chatAiOn = msg.chatAiOn;
      if (typeof msg.chatAiName === "string") chatAiName = msg.chatAiName.slice(0, 40);
      renderRequestSettings();
      renderFeedback();
      renderChatSettings();
      renderQueue(msg.state);

      const curNp = msg.state?.nowPlaying;
      const isSpotify = curNp?.provider === "spotify";
      const trackId = isSpotify
        ? (curNp.videoId || curNp.id || `${(curNp.channel || "").toLowerCase()}:::${(curNp.title || "").toLowerCase()}`)
        : "";

      if (isSpotify && trackId) {
        const isNewSpotifySong = String(trackId) !== String(lastHandledSpotifyTrackId);
        if (isNewSpotifySong) {
          lastHandledSpotifyTrackId = trackId;
          userCollapsedTrackId = "";
          guestLyricsAnchorPosition = 0;
          guestLyricsAnchorTime = performance.now();
          guestLyricsPaused = false;
          loadGuestLyrics(curNp, { autoOpen: true });
          if (queueWs && queueWs.readyState === WebSocket.OPEN) {
            queueWs.send(JSON.stringify({ type: "requestPlaybackTick" }));
          }
        } else if (guestLyricsActive && String(trackId) !== String(currentGuestLyricsTrackId)) {
          guestLyricsAnchorPosition = 0;
          guestLyricsAnchorTime = performance.now();
          guestLyricsPaused = false;
          loadGuestLyrics(curNp, { autoOpen: true });
          if (queueWs && queueWs.readyState === WebSocket.OPEN) {
            queueWs.send(JSON.stringify({ type: "requestPlaybackTick" }));
          }
        }
      } else {
        lastHandledSpotifyTrackId = "";
        userCollapsedTrackId = "";
        if (guestLyricsActive) {
          toggleGuestLyrics(false);
          if (curNp) {
            toast("info", "🎵", "Bài hát Spotify đã kết thúc.");
          }
        }
      }
    } else if (msg.type === "playbackTick") {
      if (guestLyricsActive) {
        const curNp = lastQueueState?.nowPlaying;
        if (curNp && curNp.provider === "spotify" && (!msg.videoId || msg.videoId === curNp.videoId)) {
          const isPaused = Boolean(msg.paused);
          const rawDelay = typeof msg.serverTime === "number" ? Date.now() - msg.serverTime : 0;
          const networkDelay = (!isPaused && rawDelay >= 0 && rawDelay <= 2000) ? rawDelay : 0;
          const targetPosition = (typeof msg.position === "number" ? msg.position : 0) + networkDelay;

          const now = performance.now();
          const currentExpectedPos = guestLyricsPaused
            ? guestLyricsAnchorPosition
            : guestLyricsAnchorPosition + (guestLyricsAnchorTime > 0 ? (now - guestLyricsAnchorTime) : 0);
          const drift = targetPosition - currentExpectedPos;

          if (msg.seek || guestLyricsPaused !== isPaused || Math.abs(drift) > 500 || guestLyricsAnchorTime === 0) {
            guestLyricsAnchorPosition = targetPosition;
            guestLyricsAnchorTime = now;
          } else {
            guestLyricsAnchorPosition = currentExpectedPos + drift * 0.3;
            guestLyricsAnchorTime = now;
          }

          guestLyricsPaused = isPaused;
          lastGuestTickReceivedTime = now;

          if (msg.seek) {
            syncGuestLyricsPosition(guestLyricsAnchorPosition / 1000, true);
          } else if (guestLyricsPaused) {
            syncGuestLyricsPosition(guestLyricsAnchorPosition / 1000, false);
          }
        }
      }
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
    } else if (msg.type === "pointDropClosed" && currentActiveDrop?.id === msg.dropId) {
      hidePointDropBanner();
      toast("info", "🎁", "Đợt quà tặng đã kết thúc.");
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
        if (msg.avatarUrl !== undefined) currentUser.avatarUrl = msg.avatarUrl;
        renderUserAuthBar();
      }
    } else if (msg.type === "rankUpdated") {
      if (currentUser && msg.rank) {
        const previousLevel = Number(currentUser.rank?.level || 1);
        currentUser.rank = msg.rank;
        renderUserAuthBar();
        const checkinModal = document.getElementById("checkin-modal");
        if (checkinModal && !checkinModal.classList.contains("hidden")) updateRankBenefitModal();
        if (Number(msg.rank.level || 1) > previousLevel) {
          toast("ok", "🏆", `Bạn đã lên hạng ${msg.rank.name || "mới"}!`);
        }
      }
    } else if (msg.type === "sessionRevoked") {
      currentUser = null;
      syncFavoritesIdentity();
      syncHistoryIdentity();
      hidePointDropBanner();
      renderUserAuthBar();
      if (lastQueueState) renderQueue(lastQueueState);
      restartWs();
      toast("bad", "!", msg.reason || "Phiên đăng nhập không còn hiệu lực.");
    } else if (msg.type === "removeOwnResult") {
      pendingRemovals.delete(msg.id);
      if (msg.ok) toast("ok", "✓", "Đã xóa khỏi hàng đợi.");
      else toast("bad", "!", msg.reason || "Không thể xóa bài hát này.");
      if (lastQueueState) renderQueue(lastQueueState);
    } else if (msg.type === "skipOwnResult") {
      pendingOwnSkips.delete(msg.id);
      if (msg.ok) toast("ok", "⏭️", "Đã bỏ qua bài hát của bạn.", { sub: "Điểm vote đã dùng không được hoàn lại." });
      else toast("bad", "!", msg.reason || "Không thể bỏ qua bài hát đang phát.");
      if (lastQueueState) renderQueue(lastQueueState);
    }
  };
  ws.onclose = () => {
    if (queueWs !== ws) return;
    queueWs = null;
    pendingOwnSkips.clear();
    resetChatPending();
    setChatStatus("Mất kết nối chat, đang thử kết nối lại…", "bad");
    setTimeout(() => {
      if (!queueWs) connectWs();
    }, 2000);
  };
}

function requestOwnSkip(id, button) {
  if (!id || !button || !queueWs || queueWs.readyState !== WebSocket.OPEN || pendingOwnSkips.has(id)) return;
  const confirmed = window.confirm("Bỏ qua bài hát đang phát? Điểm vote đã dùng sẽ không được hoàn lại.");
  if (!confirmed) return;
  pendingOwnSkips.add(id);
  button.disabled = true;
  queueWs.send(JSON.stringify({ type: "skipOwn", id, clientId }));
}

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

function renderQueue(state) {
  const np = state.nowPlaying;
  const npEl = document.getElementById("now-playing");
  const myIds = loadMyRequestIds();
  if (np) {
    npEl.classList.remove("hidden");
    const isSpotify = np.provider === "spotify";
    if (!isSpotify) {
      guestLyricsActive = false;
      if (guestLyricsRafId) {
        cancelAnimationFrame(guestLyricsRafId);
        guestLyricsRafId = null;
      }
    }

    if (guestLyricsActive && isSpotify) {
      const trackId = np.videoId || np.id || `${(np.channel || "").toLowerCase()}:::${(np.title || "").toLowerCase()}`;
      const isSameTrack = npEl.classList.contains("lyrics-mode") && String(npEl.dataset.lyricsTrackId) === String(trackId);

      if (isSameTrack) {
        const skipButton = npEl.querySelector(".np-skip-own");
        if (skipButton) {
          skipButton.className = `np-skip-own${myIds.has(np.id) ? "" : " hidden"}`;
          skipButton.disabled = pendingOwnSkips.has(np.id);
        }
        const favSlot = npEl.querySelector(".np-favorite-slot");
        if (favSlot) {
          favSlot.replaceWith(createFavoriteButton(np, "np-favorite-btn"));
        } else {
          const favBtn = npEl.querySelector(".np-favorite-btn");
          if (favBtn) {
            favBtn.dataset.favoriteVideoId = np.videoId;
            syncFavoriteButton(favBtn);
          }
        }
      } else {
        npEl.classList.add("lyrics-mode");
        npEl.dataset.lyricsTrackId = String(trackId);
        npEl.innerHTML = `
          <div class="np-lyrics-header">
            <div class="np-lyrics-meta">
              <img class="np-lyrics-thumb" src="${safeImageUrl(np.thumbnail)}" alt="" referrerpolicy="no-referrer" />
              <div class="np-lyrics-track">
                <div class="np-lyrics-badge">
                  <span class="eq"><span></span><span></span><span></span></span>
                  <span>Lời bài hát · Đồng bộ</span>
                </div>
                <div class="np-lyrics-title"></div>
                <div class="np-lyrics-sub"></div>
              </div>
            </div>
            <div class="np-actions np-lyrics-actions">
              <button class="np-lyrics-toggle-btn" id="np-lyrics-toggle-btn" type="button" title="Thu nhỏ về khung đang phát" aria-label="Thu nhỏ về khung đang phát">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                <span>Thu nhỏ</span>
              </button>
              <span class="np-favorite-slot"></span>
              <button class="np-skip-own${myIds.has(np.id) ? "" : " hidden"}" type="button" title="Bỏ qua bài hát của bạn" aria-label="Bỏ qua bài hát của bạn"${pendingOwnSkips.has(np.id) ? " disabled" : ""}>Bỏ qua</button>
            </div>
          </div>
          <div class="np-lyrics-scroller is-loading" id="np-lyrics-scroller">
            <div class="np-lyrics-content is-loading" id="np-lyrics-content">
              <div class="np-lyrics-loading">Đang tải lời bài hát đồng bộ…</div>
            </div>
          </div>`;
        npEl.querySelector(".np-lyrics-title").textContent = np.title;
        updateMarqueeTitle(npEl.querySelector(".np-lyrics-title"));
        npEl.querySelector(".np-lyrics-sub").textContent =
          (np.channel || "") + (np.addedBy ? ` · Người chọn: ${np.addedBy}` : "");
        const skipButton = npEl.querySelector(".np-skip-own");
        if (skipButton) skipButton.onclick = () => requestOwnSkip(np.id, skipButton);
        npEl.querySelector(".np-favorite-slot").replaceWith(createFavoriteButton(np, "np-favorite-btn"));
        const collapseBtn = npEl.querySelector("#np-lyrics-toggle-btn");
        if (collapseBtn) {
          collapseBtn.onclick = () => toggleGuestLyrics(false);
        }

        currentGuestLyricsActiveIndex = -1;
        if (String(trackId) === String(currentGuestLyricsTrackId) && currentGuestLyrics?.lines) {
          renderGuestLyricsLines(currentGuestLyrics.lines);
        } else {
          loadGuestLyrics(np, { autoOpen: true });
        }
      }
    } else {
      delete npEl.dataset.lyricsTrackId;
      npEl.classList.remove("lyrics-mode");
      npEl.innerHTML = `
        <img src="${safeImageUrl(np.thumbnail)}" alt="" referrerpolicy="no-referrer" />
        <div class="np-body">
          <div class="np-label">
            <span class="eq"><span></span><span></span><span></span></span>
            ĐANG PHÁT
          </div>
          <div class="np-title"></div>
          <div class="np-sub"></div>
        </div>
        <div class="np-actions">
          <button class="np-lyrics-btn${isSpotify ? "" : " hidden"}" id="np-lyrics-btn" type="button" title="Xem lời bài hát" aria-label="Xem lời bài hát">
            <svg width="16" height="16" viewBox="0 0 256 256" fill="currentColor"><path d="M115.06 46.36a4 4 0 0 0-6.11.54A71.54 71.54 0 0 0 96 88a73.29 73.29 0 0 0 .63 9.42L27.12 192.22A15.93 15.93 0 0 0 28.71 213L43 227.29a15.93 15.93 0 0 0 20.78 1.59l94.81-69.53A73.29 73.29 0 0 0 168 160a71.54 71.54 0 0 0 41.09-12.93 4 4 0 0 0 .54-6.11Zm2.61 103.28-16 16a8 8 0 1 1-11.31-11.31l16-16a8 8 0 0 1 11.31 11.31Zm109.4-20.56a4 4 0 0 1-6.12.54L126.38 35.05a4 4 0 0 1 .54-6.12A71.93 71.93 0 0 1 227.07 129.08Z"/></svg>
          </button>
          <span class="np-favorite-slot"></span>
          <button class="np-skip-own${myIds.has(np.id) ? "" : " hidden"}" type="button" title="Bỏ qua bài hát của bạn" aria-label="Bỏ qua bài hát của bạn"${pendingOwnSkips.has(np.id) ? " disabled" : ""}>Bỏ qua</button>
        </div>`;
      npEl.querySelector(".np-title").textContent = np.title;
      updateMarqueeTitle(npEl.querySelector(".np-title"));
      npEl.querySelector(".np-sub").textContent =
        (np.channel || "") + (np.addedBy ? ` · Người chọn: ${np.addedBy}` : "");
      const skipButton = npEl.querySelector(".np-skip-own");
      if (skipButton) skipButton.onclick = () => requestOwnSkip(np.id, skipButton);
      npEl.querySelector(".np-favorite-slot").replaceWith(createFavoriteButton(np, "np-favorite-btn"));
      const lyricsBtn = npEl.querySelector("#np-lyrics-btn");
      if (lyricsBtn) {
        lyricsBtn.onclick = () => toggleGuestLyrics(true);
      }
    }
  } else {
    npEl.classList.add("hidden");
    npEl.classList.remove("lyrics-mode");
    guestLyricsActive = false;
    if (guestLyricsRafId) {
      cancelAnimationFrame(guestLyricsRafId);
      guestLyricsRafId = null;
    }
  }

  const queue = state.queue || [];
  document.getElementById("queue-count").textContent = queue.length;
  if (previousHistoryCount !== null && typeof state.historyCount === "number" && state.historyCount > previousHistoryCount) {
    if (activeQueueTab === "history") {
      void loadHistory({ reset: true });
    } else {
      historyController.requestReset();
      void refreshHistoryCount();
    }
  }
  if (typeof state.historyCount === "number") {
    previousHistoryCount = state.historyCount;
  }
  const limitNotice = document.getElementById("queue-limit-notice");
  const limitReached = queueLimitOn && queue.length >= queueLimit;
  let myActiveCount = 0;
  for (const item of queue) {
    if (myIds.has(item.id)) myActiveCount++;
  }
  const userLimitReached = userQueueLimitOn && myActiveCount >= userQueueLimit;

  if (userLimitReached) {
    limitNotice.classList.remove("hidden");
    limitNotice.textContent = `Bạn đã có ${myActiveCount}/${userQueueLimit} bài trong hàng đợi — vui lòng đợi bài của bạn được phát trước khi thêm tiếp.`;
  } else if (limitReached) {
    limitNotice.classList.remove("hidden");
    limitNotice.textContent = `Hàng đợi đã đạt giới hạn ${queueLimit} bài — hãy chờ phát bớt trước khi thêm bài mới.`;
  } else {
    limitNotice.classList.add("hidden");
  }
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
      <img src="${safeImageUrl(item.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
      <div class="q-text">
        <div class="t-row">
          <span class="t"></span>
          ${getPlatformIconBadge(item.provider)}
          ${isPinned ? '<span class="q-pinned-badge">Ghim</span>' : ""}
          <span class="q-favorite-slot"></span>
        </div>
        <div class="q-byline">
          <span class="s"></span>
          <span class="q-requester-row"><span class="q-requester-avatar"></span><span class="q-requester"></span></span>
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
    li.querySelector(".q-favorite-slot").replaceWith(createFavoriteButton(item, "q-favorite-btn"));
    li.querySelector(".s").textContent = item.channel;
    li.querySelector(".q-requester").textContent = item.addedBy
      ? `Người chọn: ${item.addedBy}`
      : "Người chọn: Khách ẩn danh";
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

// ---- Queue and Playback History Tabs & Lazy Loading --------------------------
let activeQueueTab = "queue";
let historyItems = [];
let historyPage = 1;
let historyHasMore = true;
let historyLoadedOnce = false;
let previousHistoryCount = null;
const historyController = window.JukeboxHistoryController.create();

function updateHistoryBadgeCount(count) {
  const badgeEl = document.getElementById("history-count-badge");
  if (!badgeEl) return;
  const num = typeof count === "number" ? count : Number(count) || 0;
  badgeEl.textContent = num > 99 ? "99+" : String(num);
  badgeEl.classList.toggle("hidden", num <= 0);
}

function updateHistoryEmptyCopy() {
  const titleEl = document.getElementById("history-empty-title");
  const descriptionEl = document.getElementById("history-empty-description");
  if (!titleEl || !descriptionEl) return;

  const requiresAuthentication = historyController.emptyReason === "authentication-required";
  titleEl.textContent = requiresAuthentication ? "Đăng nhập để xem lịch sử" : "Chưa có lịch sử phát";
  descriptionEl.textContent = requiresAuthentication
    ? "Lịch sử chỉ hiển thị các bài hát do chính tài khoản của bạn đã chọn."
    : "Các bài hát bạn chọn sẽ xuất hiện tại đây sau khi phát xong.";
}

function clearHistoryView() {
  historyItems = [];
  historyPage = 1;
  historyHasMore = true;
  historyLoadedOnce = false;
  document.getElementById("history-list")?.replaceChildren();
  document.getElementById("history-end")?.classList.add("hidden");
  document.getElementById("history-empty")?.classList.add("hidden");
  updateHistoryBadgeCount(0);
  updateHistoryEmptyCopy();
}

function syncHistoryIdentity() {
  if (!historyController.setIdentity(currentUser?.id || null)) return;
  clearHistoryView();
  if (activeQueueTab === "history") {
    void loadHistory({ reset: true });
  } else {
    void refreshHistoryCount();
  }
}

async function refreshHistoryCount() {
  const requestedUserId = currentUser?.id || null;
  if (!requestedUserId) {
    updateHistoryBadgeCount(0);
    return;
  }

  try {
    const res = await fetch("/api/history?page=1&limit=1");
    if (!historyController.isIdentityCurrent(requestedUserId)) return;
    if (res.status === 401) {
      currentUser = null;
      renderUserAuthBar();
      syncHistoryIdentity();
      return;
    }
    const data = await res.json();
    if (data.ok && typeof data.total === "number") updateHistoryBadgeCount(data.total);
  } catch {}
}

function switchQueueTab(tabName) {
  if (tabName !== "queue" && tabName !== "history") return;
  activeQueueTab = tabName;

  const btnQueue = document.getElementById("tab-btn-queue");
  const btnHistory = document.getElementById("tab-btn-history");
  const paneQueue = document.getElementById("pane-queue");
  const paneHistory = document.getElementById("pane-history");

  if (tabName === "queue") {
    btnQueue?.classList.add("active");
    btnQueue?.setAttribute("aria-selected", "true");
    btnHistory?.classList.remove("active");
    btnHistory?.setAttribute("aria-selected", "false");
    paneQueue?.classList.remove("hidden");
    paneHistory?.classList.add("hidden");
  } else {
    btnHistory?.classList.add("active");
    btnHistory?.setAttribute("aria-selected", "true");
    btnQueue?.classList.remove("active");
    btnQueue?.setAttribute("aria-selected", "false");
    paneHistory?.classList.remove("hidden");
    paneQueue?.classList.add("hidden");

    if (!historyLoadedOnce || historyController.refreshPending) {
      void loadHistory({ reset: true });
    }
  }
}

function formatHistoryTime(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const now = Date.now();
  const diffMinutes = Math.floor((now - date.getTime()) / 60000);
  if (diffMinutes < 1) return "Vừa xong";
  if (diffMinutes < 60) return `${diffMinutes} phút trước`;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function loadHistory({ reset = false } = {}) {
  if (!reset && !historyHasMore) return;
  if (!historyController.begin(reset)) return;

  const requestedUserId = currentUser?.id || null;

  const loadingEl = document.getElementById("history-loading");
  const emptyEl = document.getElementById("history-empty");
  const endEl = document.getElementById("history-end");
  const listEl = document.getElementById("history-list");

  loadingEl?.classList.remove("hidden");

  if (reset) {
    historyPage = 1;
    historyHasMore = true;
    historyItems = [];
    if (listEl) listEl.innerHTML = "";
    emptyEl?.classList.add("hidden");
    endEl?.classList.add("hidden");
  }

  try {
    if (!requestedUserId) {
      historyLoadedOnce = true;
      updateHistoryBadgeCount(0);
      updateHistoryEmptyCopy();
      emptyEl?.classList.remove("hidden");
      return;
    }

    const res = await fetch(`/api/history?page=${historyPage}&limit=10`);
    if (!historyController.isIdentityCurrent(requestedUserId)) return;
    if (res.status === 401) {
      currentUser = null;
      renderUserAuthBar();
      syncHistoryIdentity();
      return;
    }
    const data = await res.json();
    if (data.ok) {
      historyLoadedOnce = true;
      const newItems = Array.isArray(data.items) ? data.items : [];
      historyItems.push(...newItems);
      historyHasMore = !!data.hasMore;
      historyPage++;

      if (typeof data.total === "number") {
        updateHistoryBadgeCount(data.total);
      }

      if (historyItems.length === 0) {
        updateHistoryEmptyCopy();
        emptyEl?.classList.remove("hidden");
      } else {
        emptyEl?.classList.add("hidden");
      }

      renderHistoryItems(newItems, listEl);

      if (!historyHasMore && historyItems.length > 0) {
        endEl?.classList.remove("hidden");
      } else {
        endEl?.classList.add("hidden");
      }
    }
  } catch (err) {
    console.error("[history] load error:", err);
  } finally {
    const refreshPending = historyController.finish();
    loadingEl?.classList.add("hidden");
    if (refreshPending && activeQueueTab === "history") {
      void loadHistory({ reset: true });
    }
  }
}

function renderHistoryItems(items, listEl) {
  if (!listEl || !Array.isArray(items)) return;
  for (const item of items) {
    const li = document.createElement("li");
    li.className = "history-item";
    li.dataset.id = item.id;

    const isSkipped = item.finishReason === "skipped" || item.finishReason === "owner_skipped";
    const statusText = isSkipped ? "Bỏ qua" : "Đã phát";
    const statusClass = isSkipped ? "skipped" : "played";
    const timeText = formatHistoryTime(item.finishedAt);
    const addedByText = item.addedBy ? `Người chọn: ${item.addedBy}` : "Người chọn: Khách ẩn danh";

    li.innerHTML = `
      <img src="${safeImageUrl(item.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
      <div class="history-text">
        <div class="history-title-row">
          <span class="history-title"></span>
          ${getPlatformIconBadge(item.provider)}
        </div>
        <span class="history-byline"></span>
        <div class="history-meta">
          <span class="history-tag ${statusClass}">${statusText}</span>
          ${timeText ? `<span class="history-time">${escapeHtml(timeText)}</span>` : ""}
        </div>
      </div>
      <button class="history-readd-btn" type="button" title="Thêm lại vào hàng đợi" aria-label="Thêm lại bài hát ${escapeHtml(item.title)}">
        <span>+</span> Thêm lại
      </button>
    `;

    li.querySelector(".history-title").textContent = item.title;
    updateMarqueeTitle(li.querySelector(".history-title"));
    li.querySelector(".history-byline").textContent = `${item.channel || ""} · ${addedByText}`.trim();

    const readdBtn = li.querySelector(".history-readd-btn");
    readdBtn.onclick = () => {
      requestSong(
        {
          videoId: item.videoId,
          title: item.title,
          channel: item.channel,
          duration: item.duration,
          thumbnail: item.thumbnail,
        },
        readdBtn
      );
    };

    listEl.appendChild(li);
  }
}

function setupHistoryInfiniteScroll() {
  const sentinel = document.getElementById("history-sentinel");
  if (sentinel && "IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry && entry.isIntersecting && activeQueueTab === "history" && historyHasMore && !historyController.loading) {
          void loadHistory();
        }
      },
      {
        root: null,
        rootMargin: "150px",
        threshold: 0.1,
      }
    );
    observer.observe(sentinel);
  }

  const checkScroll = () => {
    if (activeQueueTab !== "history" || !historyHasMore || historyController.loading) return;
    const queueSection = document.querySelector(".queue-section");
    if (queueSection && queueSection.scrollHeight - queueSection.scrollTop - queueSection.clientHeight < 150) {
      void loadHistory();
      return;
    }
    const docHeight = document.documentElement.scrollHeight;
    const scrollPos = window.innerHeight + window.scrollY;
    if (docHeight - scrollPos < 200) {
      void loadHistory();
    }
  };

  document.querySelector(".queue-section")?.addEventListener("scroll", checkScroll, { passive: true });
  window.addEventListener("scroll", checkScroll, { passive: true });

  document.getElementById("tab-btn-queue")?.addEventListener("click", () => switchQueueTab("queue"));
  document.getElementById("tab-btn-history")?.addEventListener("click", () => switchQueueTab("history"));
}

renderSingers();
selectGenre("All"); // render the tab and load real songs on page open
renderRequestSettings();
renderFeedback();
setupHistoryInfiniteScroll();
initSearchPlatformTabs();
initGuestLyrics();
window.addEventListener("jukebox:notification", (event) => {
  if (currentUser) toast("info", "🔔", "Bạn có thông báo mới", { sub: event.detail?.title || "Mở chuông để xem cập nhật." });
});
fetchMe();
connectWs();
setInterval(() => {
  if (lastQueueState) renderQueue(lastQueueState);
}, 30000);
