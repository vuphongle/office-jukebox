const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const LEDGER_LABELS = {
  daily_checkin: "Điểm danh hằng ngày",
  streak_bonus: "Thưởng chuỗi điểm danh",
  vote_spend: "Vote bài hát",
  vote_refund: "Hoàn điểm vote",
  admin_adjustment: "Điều chỉnh bởi quản trị viên",
  airdrop_direct: "Nhận điểm từ quản trị viên",
  point_drop_claim: "Nhận điểm phát thưởng",
};

let currentUser = null;
let currentDrop = null;
let ledgerDirection = "all";
let ledgerPage = 0;
let ledgerTotal = 0;
let ledgerItems = [];
let ledgerPending = false;
let accountAuthMode = "login";
let accountSocket = null;
let socketReconnectTimer = null;
let queueRefreshTimer = null;
let statusTimer = null;
let profileDisplayName = "";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  let data;
  try {
    data = await response.json();
  } catch {
    data = { ok: false, reason: "Phản hồi từ máy chủ không hợp lệ." };
  }
  if (response.status === 401 && !url.startsWith("/api/auth/")) {
    showAuthGate("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
    throw new Error(data.reason || "Phiên đăng nhập đã hết hạn.");
  }
  return { response, data };
}

function setButtonLoading(button, loading) {
  if (!button) return;
  button.classList.toggle("is-loading", loading);
  button.disabled = loading;
  button.setAttribute("aria-busy", String(loading));
}

function showStatus(message, kind = "success") {
  const status = $("#global-status");
  window.clearTimeout(statusTimer);
  status.textContent = message;
  status.className = `global-status show${kind === "error" ? " error" : ""}`;
  statusTimer = window.setTimeout(() => {
    status.className = "global-status";
  }, 4200);
}

function showAuthGate(message = "") {
  currentUser = null;
  $("#account-loading").classList.add("hidden");
  $("#account-dashboard").classList.add("hidden");
  $("#auth-gate").classList.remove("hidden");
  if (message) setAuthSummary(message);
  $("#auth-gate-title").focus?.();
}

function showDashboard() {
  $("#account-loading").classList.add("hidden");
  $("#auth-gate").classList.add("hidden");
  $("#account-dashboard").classList.remove("hidden");
}

function setAuthSummary(message) {
  const summary = $("#account-auth-error");
  summary.textContent = message;
  summary.classList.toggle("hidden", !message);
  if (message) summary.focus();
}

function setAuthConfirmError(message) {
  const input = $("#account-auth-confirm");
  const error = $("#account-auth-confirm-error");
  error.textContent = message;
  error.classList.toggle("hidden", !message);
  input.setAttribute("aria-invalid", String(!!message));
}

function setAccountAuthMode(mode) {
  accountAuthMode = mode;
  const register = mode === "register";
  const loginTab = $("#account-auth-login-tab");
  const registerTab = $("#account-auth-register-tab");
  const displayField = $("#account-auth-display-field");
  const confirmField = $("#account-auth-confirm-field");
  const confirmInput = $("#account-auth-confirm");
  const confirmToggle = $('[data-password-toggle="account-auth-confirm"]');

  loginTab.classList.toggle("active", !register);
  registerTab.classList.toggle("active", register);
  loginTab.setAttribute("aria-selected", String(!register));
  registerTab.setAttribute("aria-selected", String(register));
  displayField.classList.toggle("hidden", !register);
  confirmField.classList.toggle("hidden", !register);
  confirmInput.disabled = !register;
  confirmInput.required = register;
  confirmToggle.disabled = !register;
  $("#account-auth-password").autocomplete = register ? "new-password" : "current-password";
  $("#account-auth-submit .button-label").textContent = register ? "Tạo tài khoản" : "Đăng nhập";
  setAuthSummary("");
  setAuthConfirmError("");
}

function togglePassword(button) {
  const input = document.getElementById(button.dataset.passwordToggle);
  if (!input) return;
  const reveal = input.type === "password";
  input.type = reveal ? "text" : "password";
  button.setAttribute("aria-label", reveal ? "Ẩn mật khẩu" : "Hiện mật khẩu");
  input.focus();
}

async function submitAccountAuth(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;

  const username = $("#account-auth-username").value.trim();
  const password = $("#account-auth-password").value;
  const displayName = $("#account-auth-display").value.trim();
  const confirmation = $("#account-auth-confirm").value;
  const button = $("#account-auth-submit");

  setAuthSummary("");
  if (accountAuthMode === "register") {
    const error = window.JukeboxAuth.validateRegistrationPassword(password, confirmation);
    setAuthConfirmError(error);
    if (error) {
      $("#account-auth-confirm").focus();
      return;
    }
  }

  const endpoint = accountAuthMode === "login" ? "/api/auth/login" : "/api/auth/register";
  const payload = accountAuthMode === "login"
    ? { username, password }
    : { username, password, displayName };

  setButtonLoading(button, true);
  try {
    const { data } = await requestJson(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!data.ok) {
      setAuthSummary(data.reason || "Không thể xác thực tài khoản.");
      return;
    }
    form.reset();
    restartSocket();
    await loadAccount();
    showStatus(accountAuthMode === "login" ? "Đăng nhập thành công." : "Tài khoản đã được tạo.");
  } catch (error) {
    if (!$("#account-auth-error").textContent) setAuthSummary(`Không thể kết nối: ${error.message}`);
  } finally {
    setButtonLoading(button, false);
  }
}

async function loadAccount() {
  try {
    const { data } = await requestJson("/api/me");
    if (!data.ok || !data.authenticated || !data.user) {
      showAuthGate();
      return;
    }
    currentUser = data.user;
    currentDrop = data.user.activeClaimableDrop || null;
    renderAccount();
    showDashboard();
    await Promise.all([loadLedger({ reset: true }), loadActiveVotes()]);
  } catch (error) {
    showAuthGate(`Không thể tải tài khoản: ${error.message}`);
  }
}

function renderAccount() {
  if (!currentUser) return;
  const displayName = currentUser.displayName || currentUser.username;
  const profileInput = $("#profile-display-name");
  const hasUnsavedProfileDraft = profileDisplayName
    && profileInput.value.trim() !== profileDisplayName;
  $("#account-title").textContent = displayName;
  $("#account-username").textContent = `@${currentUser.username}`;
  $("#account-avatar").textContent = displayName.trim().charAt(0).toUpperCase() || "U";
  $("#points-value").textContent = Number(currentUser.pointsBalance || 0).toLocaleString("vi-VN");
  $("#streak-value").textContent = `${currentUser.currentStreak || 0} ngày`;
  $("#reward-streak").textContent = currentUser.currentStreak || 0;
  $("#checkin-value").textContent = currentUser.hasCheckedInToday ? "Đã điểm danh" : "Chưa điểm danh";
  $("#checkin-stat-icon").classList.toggle("success", !!currentUser.hasCheckedInToday);
  $("#checkin-stat-icon").classList.toggle("muted", !currentUser.hasCheckedInToday);

  const checkinButton = $("#account-checkin");
  checkinButton.disabled = !!currentUser.hasCheckedInToday;
  checkinButton.querySelector(".button-label").textContent = currentUser.hasCheckedInToday
    ? "Đã điểm danh hôm nay"
    : "Điểm danh nhận +1 điểm";
  $("#checkin-description").textContent = currentUser.hasCheckedInToday
    ? "Hãy quay lại vào ngày mai để duy trì chuỗi điểm danh."
    : "Điểm danh mỗi ngày để nhận điểm vote và mở khóa mốc thưởng.";

  const streak = currentUser.currentStreak || 0;
  const cycle = streak % 30;
  $$(".milestone").forEach((milestone) => {
    const days = Number(milestone.dataset.days);
    const achieved = days === 30 ? cycle === 0 && streak > 0 : cycle >= days;
    milestone.classList.toggle("achieved", achieved);
  });

  $("#profile-username").value = currentUser.username;
  profileDisplayName = displayName;
  if (!hasUnsavedProfileDraft) profileInput.value = displayName;
  updateDisplayNameForm();
  renderPointDrop();
}

function renderPointDrop() {
  const card = $("#point-drop-card");
  if (!currentDrop) {
    card.classList.add("hidden");
    return;
  }
  $("#point-drop-title").textContent = currentDrop.title;
  $("#point-drop-copy").textContent = `Nhận +${currentDrop.points} điểm vào tài khoản.`;
  card.classList.remove("hidden");
}

async function loadActiveVotes() {
  if (!currentUser) return;
  try {
    const { data } = await requestJson("/api/me/votes/active");
    if (!data.ok) throw new Error(data.reason || "Không thể tải bài đã vote.");
    renderActiveVotes(Array.isArray(data.votes) ? data.votes : []);
  } catch (error) {
    if (!currentUser) return;
    const section = $("#active-votes-section");
    section.classList.remove("hidden");
    $("#active-votes-list").innerHTML = `<div class="ledger-state"><div><strong>Chưa tải được bài đã vote</strong><p>${escapeHtml(error.message)}</p><button class="secondary-button" type="button" data-retry-votes>Thử lại</button></div></div>`;
    $("[data-retry-votes]")?.addEventListener("click", loadActiveVotes);
  }
}

function renderActiveVotes(votes) {
  const section = $("#active-votes-section");
  const list = $("#active-votes-list");
  if (!votes.length) {
    section.classList.add("hidden");
    list.innerHTML = "";
    return;
  }
  list.innerHTML = votes.map((vote) => `
    <article class="vote-row">
      <img src="${escapeHtml(vote.thumbnail || "/assets/favicon.png")}" alt="" width="52" height="52" loading="lazy" />
      <div class="vote-copy">
        <strong>${escapeHtml(vote.title)}</strong>
        <span>${escapeHtml(vote.channel || "Không rõ kênh")} · Vị trí ${vote.queuePosition}</span>
      </div>
      <div class="vote-score"><strong>${vote.pointsSpent} điểm</strong><span>Bài hát: ${vote.voteScore}</span></div>
    </article>
  `).join("");
  section.classList.remove("hidden");
}

function ledgerSkeleton() {
  $("#ledger-content").setAttribute("aria-busy", "true");
  $("#ledger-content").innerHTML = '<div class="ledger-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>';
}

async function loadLedger({ reset = false } = {}) {
  if (!currentUser || ledgerPending) return;
  if (reset) {
    ledgerPage = 0;
    ledgerTotal = 0;
    ledgerItems = [];
    ledgerSkeleton();
  }
  ledgerPending = true;
  const moreButton = $("#ledger-more");
  setButtonLoading(moreButton, !reset);
  try {
    const nextPage = ledgerPage + 1;
    const { data } = await requestJson(`/api/me/points/history?page=${nextPage}&limit=20&direction=${ledgerDirection}`);
    if (!data.ok) throw new Error(data.reason || "Không thể tải hoạt động điểm.");
    ledgerPage = data.page;
    ledgerTotal = data.total;
    ledgerItems = reset ? data.ledger : [...ledgerItems, ...data.ledger];
    renderLedger();
  } catch (error) {
    if (!currentUser) return;
    $("#ledger-content").innerHTML = `<div class="ledger-state"><div><strong>Không thể tải hoạt động điểm</strong><p>${escapeHtml(error.message)}</p><button class="secondary-button" type="button" data-retry-ledger>Thử lại</button></div></div>`;
    $("[data-retry-ledger]")?.addEventListener("click", () => loadLedger({ reset: true }));
    moreButton.classList.add("hidden");
  } finally {
    ledgerPending = false;
    $("#ledger-content").setAttribute("aria-busy", "false");
    setButtonLoading(moreButton, false);
  }
}

function renderLedger() {
  $("#ledger-total").textContent = `${ledgerTotal.toLocaleString("vi-VN")} giao dịch`;
  if (!ledgerItems.length) {
    const canCheckin = !currentUser.hasCheckedInToday;
    $("#ledger-content").innerHTML = `<div class="ledger-state"><div><strong>Chưa có hoạt động điểm</strong><p>${canCheckin ? "Hãy điểm danh hôm nay để nhận điểm đầu tiên." : "Các giao dịch nhận và sử dụng điểm sẽ xuất hiện tại đây."}</p>${canCheckin ? '<button class="secondary-button" type="button" data-empty-checkin>Điểm danh ngay</button>' : ""}</div></div>`;
    $("[data-empty-checkin]")?.addEventListener("click", performCheckin);
  } else {
    $("#ledger-content").innerHTML = `<ul class="ledger-list">${ledgerItems.map((entry) => {
      const delta = Number(entry.delta || 0);
      const directionClass = delta > 0 ? "earned" : delta < 0 ? "spent" : "";
      const deltaText = delta > 0 ? `+${delta}` : String(delta).replace("-", "−");
      const date = new Date(entry.created_at);
      const formattedDate = Number.isNaN(date.getTime()) ? "" : date.toLocaleString("vi-VN", { dateStyle: "medium", timeStyle: "short" });
      return `<li class="ledger-row"><div class="ledger-copy"><strong>${escapeHtml(LEDGER_LABELS[entry.type] || "Hoạt động điểm")}</strong>${entry.reason ? `<span class="ledger-reason">${escapeHtml(entry.reason)}</span>` : ""}<time datetime="${escapeHtml(entry.created_at)}">${escapeHtml(formattedDate)}</time></div><span class="ledger-delta ${directionClass}">${escapeHtml(deltaText)}</span></li>`;
    }).join("")}</ul>`;
  }
  $("#ledger-more").classList.toggle("hidden", ledgerItems.length >= ledgerTotal || ledgerTotal === 0);
}

async function performCheckin() {
  const button = $("#account-checkin");
  if (!currentUser || currentUser.hasCheckedInToday) return;
  setButtonLoading(button, true);
  try {
    const { data } = await requestJson("/api/me/checkin", { method: "POST" });
    if (!data.ok) throw new Error(data.reason || "Không thể điểm danh.");
    currentUser.pointsBalance = data.newBalance;
    currentUser.currentStreak = data.streak;
    currentUser.hasCheckedInToday = true;
    renderAccount();
    await loadLedger({ reset: true });
    const totalAwarded = Number(data.pointsAwarded || 0) + Number(data.bonusPoints || 0);
    showStatus(`Điểm danh thành công, bạn nhận +${totalAwarded} điểm.`);
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setButtonLoading(button, false);
    if (currentUser?.hasCheckedInToday) button.disabled = true;
  }
}

async function claimPointDrop() {
  if (!currentDrop) return;
  const button = $("#claim-drop");
  setButtonLoading(button, true);
  try {
    const { data } = await requestJson(`/api/me/point-drops/${currentDrop.id}/claim`, { method: "POST" });
    if (!data.ok) throw new Error(data.reason || "Không thể nhận điểm.");
    currentUser.pointsBalance = data.newBalance;
    const received = data.pointsReceived;
    currentDrop = null;
    renderAccount();
    await loadLedger({ reset: true });
    showStatus(`Đã nhận +${received} điểm vào tài khoản.`);
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setButtonLoading(button, false);
  }
}

function setProfileError(message) {
  const input = $("#profile-display-name");
  const error = $("#profile-display-error");
  error.textContent = message;
  error.classList.toggle("hidden", !message);
  input.setAttribute("aria-invalid", String(!!message));
}

function updateDisplayNameForm({ validate = false } = {}) {
  const input = $("#profile-display-name");
  const cleanValue = input.value.trim();
  const error = validate ? window.JukeboxAuth.validateDisplayName(input.value) : "";
  setProfileError(error);
  const count = $("#display-name-count");
  count.textContent = `${input.value.length}/40`;
  count.classList.toggle("hidden", input.value.length < 32);
  $("#profile-submit").disabled = !!error || !cleanValue || cleanValue === profileDisplayName;
}

async function submitProfile(event) {
  event.preventDefault();
  const input = $("#profile-display-name");
  const error = window.JukeboxAuth.validateDisplayName(input.value);
  setProfileError(error);
  if (error) {
    input.focus();
    return;
  }
  const button = $("#profile-submit");
  setButtonLoading(button, true);
  try {
    const { data } = await requestJson("/api/me/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: input.value.trim() }),
    });
    if (!data.ok) throw new Error(data.reason || "Không thể cập nhật tên hiển thị.");
    currentUser.displayName = data.user.displayName;
    profileDisplayName = data.user.displayName;
    renderAccount();
    showStatus("Đã cập nhật tên hiển thị.");
  } catch (requestError) {
    setProfileError(requestError.message);
    input.focus();
  } finally {
    setButtonLoading(button, false);
    updateDisplayNameForm();
  }
}

function setPasswordFieldError(inputId, errorId, message) {
  const input = document.getElementById(inputId);
  const error = document.getElementById(errorId);
  error.textContent = message || "";
  error.classList.toggle("hidden", !message);
  input.setAttribute("aria-invalid", String(!!message));
}

function validatePasswordForm({ focusFirst = false } = {}) {
  const errors = window.JukeboxAuth.validatePasswordChange(
    $("#current-password").value,
    $("#new-password").value,
    $("#confirm-new-password").value
  );
  setPasswordFieldError("current-password", "current-password-error", errors.currentPassword);
  setPasswordFieldError("new-password", "new-password-error", errors.newPassword);
  setPasswordFieldError("confirm-new-password", "confirm-new-password-error", errors.confirmation);
  if (focusFirst) {
    if (errors.currentPassword) $("#current-password").focus();
    else if (errors.newPassword) $("#new-password").focus();
    else if (errors.confirmation) $("#confirm-new-password").focus();
  }
  return errors;
}

function setPasswordExpanded(expanded) {
  $("#password-expand").setAttribute("aria-expanded", String(expanded));
  $("#password-form").classList.toggle("hidden", !expanded);
  if (expanded) $("#current-password").focus();
}

function resetPasswordForm() {
  $("#password-form").reset();
  setPasswordFieldError("current-password", "current-password-error", "");
  setPasswordFieldError("new-password", "new-password-error", "");
  setPasswordFieldError("confirm-new-password", "confirm-new-password-error", "");
  $("#password-form-summary").classList.add("hidden");
  $("#password-form-summary").textContent = "";
  setPasswordExpanded(false);
}

async function submitPassword(event) {
  event.preventDefault();
  const errors = validatePasswordForm({ focusFirst: true });
  if (Object.keys(errors).length) return;
  const button = $("#password-submit");
  const summary = $("#password-form-summary");
  summary.classList.add("hidden");
  setButtonLoading(button, true);
  try {
    const { data } = await requestJson("/api/me/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPassword: $("#current-password").value,
        newPassword: $("#new-password").value,
      }),
    });
    if (!data.ok) {
      if ((data.reason || "").includes("hiện tại")) {
        setPasswordFieldError("current-password", "current-password-error", data.reason);
        $("#current-password").focus();
      } else {
        summary.textContent = data.reason || "Không thể đổi mật khẩu.";
        summary.classList.remove("hidden");
        summary.focus();
      }
      return;
    }
    resetPasswordForm();
    showStatus("Đã đổi mật khẩu. Các phiên đăng nhập cũ đã được kết thúc.");
  } catch (error) {
    if (!currentUser) return;
    summary.textContent = error.message;
    summary.classList.remove("hidden");
    summary.focus();
  } finally {
    setButtonLoading(button, false);
  }
}

async function logout() {
  const button = $("#account-logout");
  setButtonLoading(button, true);
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } finally {
    if (accountSocket) accountSocket.close();
    window.location.href = "/guest";
  }
}

function restartSocket() {
  window.clearTimeout(socketReconnectTimer);
  if (accountSocket) {
    accountSocket.onclose = null;
    accountSocket.close();
  }
  connectSocket();
}

function connectSocket() {
  if (accountSocket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(accountSocket.readyState)) return;
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  accountSocket = new WebSocket(`${protocol}://${location.host}`);
  accountSocket.onmessage = (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "state" && currentUser) {
      window.clearTimeout(queueRefreshTimer);
      queueRefreshTimer = window.setTimeout(loadActiveVotes, 160);
    } else if (message.type === "balanceUpdated" && currentUser && Number.isSafeInteger(message.newBalance)) {
      currentUser.pointsBalance = message.newBalance;
      renderAccount();
      loadLedger({ reset: true });
    } else if (message.type === "profileUpdated" && currentUser && message.displayName) {
      currentUser.displayName = message.displayName;
      profileDisplayName = message.displayName;
      renderAccount();
    } else if (message.type === "pointDropAvailable" && currentUser) {
      currentDrop = message.drop;
      renderPointDrop();
    } else if (message.type === "airdropDirect" && currentUser) {
      currentUser.pointsBalance += Number(message.points || 0);
      renderAccount();
      loadLedger({ reset: true });
      showStatus(`Bạn vừa nhận +${message.points} điểm.`);
    } else if (message.type === "sessionRevoked") {
      showAuthGate(message.reason || "Phiên đăng nhập không còn hiệu lực.");
    }
  };
  accountSocket.onclose = () => {
    accountSocket = null;
    if (currentUser) socketReconnectTimer = window.setTimeout(connectSocket, 2000);
  };
}

$("#account-auth-login-tab").addEventListener("click", () => setAccountAuthMode("login"));
$("#account-auth-register-tab").addEventListener("click", () => setAccountAuthMode("register"));
$("#account-auth-form").addEventListener("submit", submitAccountAuth);
$("#account-auth-confirm").addEventListener("blur", () => {
  if (accountAuthMode !== "register") return;
  setAuthConfirmError(window.JukeboxAuth.validateRegistrationPassword(
    $("#account-auth-password").value,
    $("#account-auth-confirm").value
  ));
});
$$('[data-password-toggle]').forEach((button) => button.addEventListener("click", () => togglePassword(button)));
$$('[data-direction]').forEach((button) => button.addEventListener("click", () => {
  ledgerDirection = button.dataset.direction;
  $$('[data-direction]').forEach((item) => {
    const active = item === button;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  });
  loadLedger({ reset: true });
}));
$("#ledger-more").addEventListener("click", () => loadLedger());
$("#account-checkin").addEventListener("click", performCheckin);
$("#claim-drop").addEventListener("click", claimPointDrop);
$("#profile-display-name").addEventListener("input", () => updateDisplayNameForm());
$("#profile-display-name").addEventListener("blur", () => updateDisplayNameForm({ validate: true }));
$("#profile-form").addEventListener("submit", submitProfile);
$("#password-expand").addEventListener("click", () => setPasswordExpanded($("#password-expand").getAttribute("aria-expanded") !== "true"));
$("#password-cancel").addEventListener("click", resetPasswordForm);
$("#password-form").addEventListener("submit", submitPassword);
$("#confirm-new-password").addEventListener("blur", () => validatePasswordForm());
$("#account-logout").addEventListener("click", logout);

window.addEventListener("pageshow", () => {
  if (currentUser) loadAccount();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && currentUser) loadAccount();
});

setAccountAuthMode("login");
connectSocket();
loadAccount();
