// Admin Dashboard Logic: Member management, Airdrops, Audit Ledger, Feedback & Chat

let ws = null;
let currentTab = "tab-users";
let adminUser = null;
let selectedUserId = null;
let dashboardStarted = false;

// Pagination states
let usersPage = 1;
let dropsPage = 1;
let ledgerPage = 1;

// --- Khởi tạo & Tab Navigation -------------------------------------------
document.addEventListener("DOMContentLoaded", async () => {
  setupTabs();
  document.getElementById("admin-login-form")?.addEventListener("submit", handleAdminLogin);
  document.getElementById("admin-logout-btn")?.addEventListener("click", handleAdminLogout);
  if (await initAuthAndProfile()) startDashboard();
  else showLoginGate();
});

function startDashboard() {
  document.getElementById("admin-login-gate").classList.add("hidden");
  document.getElementById("admin-app").classList.remove("hidden");
  if (dashboardStarted) {
    if (!ws) initWebSocket();
    selectTab(currentTab);
    return;
  }
  dashboardStarted = true;
  initUsersTab();
  initDropsTab();
  initLedgerTab();
  initFeedbackTab();
  initWebSocket();
  const requestedTab = location.hash === "#feedback" ? "tab-feedback" : "tab-users";
  selectTab(requestedTab);
}

function showLoginGate(message = "") {
  document.getElementById("admin-app").classList.add("hidden");
  document.getElementById("admin-login-gate").classList.remove("hidden");
  const error = document.getElementById("admin-login-error");
  error.textContent = message;
  error.classList.toggle("hidden", !message);
  document.getElementById("admin-login-username")?.focus();
}

async function handleAdminLogin(event) {
  event.preventDefault();
  const submit = document.getElementById("admin-login-submit");
  const error = document.getElementById("admin-login-error");
  submit.disabled = true;
  submit.textContent = "Đang đăng nhập…";
  error.classList.add("hidden");

  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: document.getElementById("admin-login-username").value.trim(),
        password: document.getElementById("admin-login-password").value,
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.reason || "Không thể đăng nhập.");
    if (data.user?.role !== "admin") {
      await fetch("/api/auth/logout", { method: "POST" });
      throw new Error("Tài khoản này không có quyền quản trị.");
    }
    adminUser = data.user;
    renderAdminProfile();
    startDashboard();
  } catch (err) {
    showLoginGate(err.message || "Không thể đăng nhập.");
  } finally {
    submit.disabled = false;
    submit.textContent = "Đăng nhập quản trị";
  }
}

async function handleAdminLogout() {
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  adminUser = null;
  document.getElementById("admin-login-password").value = "";
  showLoginGate();
}

function setupTabs() {
  const tabBtns = document.querySelectorAll(".tab-btn");
  tabBtns.forEach((btn, index) => {
    btn.addEventListener("click", () => selectTab(btn.dataset.tab));
    btn.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const offset = event.key === "ArrowRight" ? 1 : -1;
      const next = tabBtns[(index + offset + tabBtns.length) % tabBtns.length];
      next.focus();
      selectTab(next.dataset.tab);
    });
  });
}

function selectTab(tabId) {
  document.querySelectorAll(".tab-btn").forEach((button) => {
    const active = button.dataset.tab === tabId;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll(".tab-pane").forEach((pane) => pane.classList.toggle("active", pane.id === tabId));
  currentTab = tabId;
  history.replaceState(null, "", tabId === "tab-feedback" ? "#feedback" : "#" + tabId.replace("tab-", ""));
  if (!dashboardStarted) return;
  if (currentTab === "tab-users") loadUsers();
  else if (currentTab === "tab-drops") loadDrops();
  else if (currentTab === "tab-ledger") loadLedger();
  else if (currentTab === "tab-feedback") {
    loadFeedback();
    loadChatAiSettings();
  }
}

function showStatus(text, isError = false) {
  const el = document.getElementById("global-status");
  if (!el) return;
  el.textContent = text;
  el.className = isError ? "global-status bad" : "global-status";
  if (text) {
    setTimeout(() => {
      if (el.textContent === text) el.textContent = "";
    }, 4000);
  }
}

async function initAuthAndProfile() {
  try {
    const res = await fetch("/api/me");
    const data = await res.json();
    if (data.ok && data.authenticated && data.user?.role === "admin") {
      adminUser = data.user;
      renderAdminProfile();
      return true;
    }
  } catch (err) {
    console.error("Lỗi lấy thông tin admin:", err);
  }
  return false;
}

function renderAdminProfile() {
  const el = document.getElementById("admin-user-info");
  if (el && adminUser) el.textContent = `${adminUser.displayName || adminUser.username} · Admin`;
}

// --- TAB 1: USER MANAGEMENT -----------------------------------------------

function initUsersTab() {
  document.getElementById("user-search-input")?.addEventListener("input", debounce(() => {
    usersPage = 1;
    loadUsers();
  }, 300));

  document.getElementById("user-status-filter")?.addEventListener("change", () => {
    usersPage = 1;
    loadUsers();
  });

  document.getElementById("user-refresh-btn")?.addEventListener("click", () => {
    loadUsers();
  });

  // Modal Point Adjust
  document.getElementById("modal-close-btn")?.addEventListener("click", closePointsModal);
  document.getElementById("modal-cancel-btn")?.addEventListener("click", closePointsModal);
  document.getElementById("adjust-points-form")?.addEventListener("submit", handlePointsAdjustment);

  // Modal User Ledger
  document.getElementById("user-ledger-close-btn")?.addEventListener("click", closeUserLedgerModal);

}

async function loadUsers() {
  const search = document.getElementById("user-search-input")?.value || "";
  const status = document.getElementById("user-status-filter")?.value || "";
  const tbody = document.getElementById("users-tbody");
  if (!tbody) return;

  try {
    const res = await fetch(`/api/admin/users?search=${encodeURIComponent(search)}&status=${encodeURIComponent(status)}&page=${usersPage}&limit=20`);
    const data = await res.json();
    if (!data.ok) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-center">${data.reason || "Lỗi tải người dùng"}</td></tr>`;
      renderPagination("users-pagination", 1, 0, 20, () => {});
      return;
    }

    renderPagination("users-pagination", usersPage, data.total, 20, (page) => {
      usersPage = page;
      loadUsers();
    });

    if (!data.users.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-center">Không tìm thấy thành viên nào</td></tr>`;
      return;
    }

    tbody.innerHTML = data.users
      .map((u) => {
        const roleBadge = u.role === "admin" ? '<span class="badge badge-admin">Admin</span>' : '<span class="badge badge-user">User</span>';
        const statusBadge = u.status === "active" ? '<span class="badge badge-active">Hoạt động</span>' : '<span class="badge badge-blocked">Bị khóa</span>';
        const blockBtnText = u.status === "active" ? "Khóa" : "Mở khóa";
        const blockBtnClass = u.status === "active" ? "action-btn btn-sm btn-warn" : "action-btn btn-sm";

        return `
          <tr>
            <td><strong>${escapeHtml(u.username)}</strong></td>
            <td>${escapeHtml(u.display_name)}</td>
            <td>${roleBadge}</td>
            <td>${statusBadge}</td>
            <td><strong class="delta-pos">${u.points_balance}</strong> điểm</td>
            <td>${u.current_streak} ngày</td>
            <td>${u.last_checkin_date || "—"}</td>
            <td>
              <button class="action-btn btn-sm" onclick="openPointsModal('${u.id}', '${escapeHtml(u.username)}', ${u.points_balance})">Điểm ±</button>
              <button class="action-btn btn-sm" onclick="openUserLedger('${u.id}', '${escapeHtml(u.username)}')">Ledger</button>
              <button class="${blockBtnClass}" onclick="toggleUserStatus('${u.id}', '${u.status}')">${blockBtnText}</button>
            </td>
          </tr>
        `;
      })
      .join("");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center">Lỗi mạng: ${err.message}</td></tr>`;
  }
}

window.openPointsModal = function (userId, username, currentBalance) {
  selectedUserId = userId;
  document.getElementById("modal-target-username").textContent = `Tài khoản @${username}`;
  document.getElementById("modal-current-balance").textContent = currentBalance;
  document.getElementById("adjust-delta").value = "";
  document.getElementById("adjust-reason").value = "";
  document.getElementById("points-modal").classList.remove("hidden");
  document.getElementById("adjust-delta").focus();
};

function closePointsModal() {
  selectedUserId = null;
  document.getElementById("points-modal").classList.add("hidden");
}

async function handlePointsAdjustment(e) {
  e.preventDefault();
  if (!selectedUserId) return;
  const submit = e.submitter;
  const delta = parseInt(document.getElementById("adjust-delta").value, 10);
  const reason = document.getElementById("adjust-reason").value.trim();
  submit.disabled = true;

  try {
    const res = await fetch(`/api/admin/users/${selectedUserId}/points`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delta, reason }),
    });
    const data = await res.json();
    if (data.ok) {
      showStatus("Đã điều chỉnh điểm thành công!");
      closePointsModal();
      loadUsers();
    } else {
      alert(data.reason || "Lỗi điều chỉnh điểm");
    }
  } catch (err) {
    alert("Lỗi kết nối: " + err.message);
  } finally {
    submit.disabled = false;
  }
}

window.toggleUserStatus = async function (userId, currentStatus) {
  const nextStatus = currentStatus === "active" ? "blocked" : "active";
  const actionName = nextStatus === "blocked" ? "KHÓA" : "MỞ KHÓA";
  if (!confirm(`Bạn có chắc chắn muốn ${actionName} tài khoản này?`)) return;

  try {
    const res = await fetch(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: nextStatus }),
    });
    const data = await res.json();
    if (data.ok) {
      showStatus(`Đã ${actionName.toLowerCase()} tài khoản thành công.`);
      loadUsers();
    } else {
      alert(data.reason || "Không thể cập nhật trạng thái");
    }
  } catch (err) {
    alert("Lỗi: " + err.message);
  }
};

window.openUserLedger = async function (userId, username) {
  document.getElementById("user-ledger-target").textContent = `@${username}`;
  const tbody = document.getElementById("user-ledger-tbody");
  tbody.innerHTML = `<tr><td colspan="4" class="text-center">Đang tải…</td></tr>`;
  document.getElementById("user-ledger-modal").classList.remove("hidden");
  document.getElementById("user-ledger-close-btn").focus();

  try {
    const res = await fetch(`/api/admin/users/${userId}/ledger?limit=50`);
    const data = await res.json();
    if (!data.ok || !data.ledger.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center">Chưa có giao dịch điểm nào</td></tr>`;
      return;
    }

    tbody.innerHTML = data.ledger
      .map((l) => {
        const deltaClass = l.delta >= 0 ? "delta-pos" : "delta-neg";
        const deltaSign = l.delta >= 0 ? `+${l.delta}` : `${l.delta}`;
        return `
          <tr>
            <td>${formatTime(l.created_at)}</td>
            <td><strong class="${deltaClass}">${deltaSign}</strong> điểm</td>
            <td><code>${l.type}</code></td>
            <td>${escapeHtml(l.reason || "—")}</td>
          </tr>
        `;
      })
      .join("");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-center">Lỗi: ${err.message}</td></tr>`;
  }
};

function closeUserLedgerModal() {
  document.getElementById("user-ledger-modal").classList.add("hidden");
}

// --- TAB 2: AIRDROPS & POINT DROPS ----------------------------------------

function initDropsTab() {
  document.getElementById("direct-airdrop-form")?.addEventListener("submit", handleDirectAirdrop);
  document.getElementById("claimable-drop-form")?.addEventListener("submit", handleClaimableDrop);
}

async function handleDirectAirdrop(e) {
  e.preventDefault();
  const points = parseInt(document.getElementById("direct-points").value, 10);
  const title = document.getElementById("direct-reason").value.trim();

  if (!confirm(`Xác nhận phát ${points} điểm cho TOÀN BỘ thành viên đang hoạt động?`)) return;
  const submit = e.submitter;
  submit.disabled = true;
  const previousLabel = submit.textContent;
  submit.textContent = "Đang phát điểm…";

  try {
    const res = await fetch("/api/admin/point-drops", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "direct", points, title }),
    });
    const data = await res.json();
    if (data.ok) {
      showStatus(`Đã phát ${points} điểm trực tiếp cho ${data.userCount} người dùng!`);
      document.getElementById("direct-points").value = "";
      document.getElementById("direct-reason").value = "";
      loadDrops();
    } else {
      alert(data.reason || "Lỗi phát điểm");
    }
  } catch (err) {
    alert("Lỗi: " + err.message);
  } finally {
    submit.disabled = false;
    submit.textContent = previousLabel;
  }
}

async function handleClaimableDrop(e) {
  e.preventDefault();
  const points = parseInt(document.getElementById("claimable-points").value, 10);
  const title = document.getElementById("claimable-title").value.trim();
  const submit = e.submitter;
  submit.disabled = true;
  const previousLabel = submit.textContent;
  submit.textContent = "Đang phát sóng…";

  try {
    const res = await fetch("/api/admin/point-drops", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "claimable", points, title }),
    });
    const data = await res.json();
    if (data.ok) {
      showStatus(`Đã phát sóng quà tặng "${title}" (${points} điểm) realtime!`);
      document.getElementById("claimable-points").value = "";
      document.getElementById("claimable-title").value = "";
      loadDrops();
    } else {
      alert(data.reason || "Lỗi tạo quà tặng");
    }
  } catch (err) {
    alert("Lỗi: " + err.message);
  } finally {
    submit.disabled = false;
    submit.textContent = previousLabel;
  }
}

async function loadDrops() {
  const tbody = document.getElementById("drops-tbody");
  if (!tbody) return;

  try {
    const res = await fetch(`/api/admin/point-drops?page=${dropsPage}&limit=20`);
    const data = await res.json();
    renderPagination("drops-pagination", dropsPage, data.total || 0, 20, (page) => {
      dropsPage = page;
      loadDrops();
    });
    if (!data.ok || !data.drops.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center">Chưa có đợt phát điểm nào</td></tr>`;
      return;
    }

    tbody.innerHTML = data.drops
      .map((d) => {
        let statusBadge = "";
        if (d.status === "active") statusBadge = '<span class="badge badge-active">Đang mở</span>';
        else if (d.status === "superseded") statusBadge = '<span class="badge badge-blocked">Hết hạn</span>';
        else statusBadge = '<span class="badge badge-user">Đã đóng</span>';

        const typeLabel = d.type === "direct" ? "Trực tiếp" : "Chờ nhận (Claim)";

        return `
          <tr>
            <td><strong>${escapeHtml(d.title)}</strong></td>
            <td>${typeLabel}</td>
            <td><strong class="delta-pos">+${d.points}</strong> điểm</td>
            <td>${statusBadge}</td>
            <td>${d.type === "claimable" ? `${d.claim_count || 0} người` : "Tất cả"}</td>
            <td>${escapeHtml(d.created_by_username || "Admin")}</td>
            <td>${formatTime(d.created_at)}</td>
          </tr>
        `;
      })
      .join("");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center">Lỗi: ${err.message}</td></tr>`;
  }
}

// --- TAB 3: LEDGER AUDIT LOG ----------------------------------------------

function initLedgerTab() {
  document.getElementById("ledger-search-input")?.addEventListener("input", debounce(() => {
    ledgerPage = 1;
    loadLedger();
  }, 300));

  document.getElementById("ledger-type-filter")?.addEventListener("change", () => {
    ledgerPage = 1;
    loadLedger();
  });

  document.getElementById("ledger-refresh-btn")?.addEventListener("click", () => {
    loadLedger();
  });

}

async function loadLedger() {
  const search = document.getElementById("ledger-search-input")?.value || "";
  const type = document.getElementById("ledger-type-filter")?.value || "";
  const tbody = document.getElementById("ledger-tbody");
  if (!tbody) return;

  try {
    const res = await fetch(`/api/admin/ledger?search=${encodeURIComponent(search)}&type=${encodeURIComponent(type)}&page=${ledgerPage}&limit=30`);
    const data = await res.json();
    renderPagination("ledger-pagination", ledgerPage, data.total || 0, 30, (page) => {
      ledgerPage = page;
      loadLedger();
    });
    if (!data.ok || !data.ledger.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-center">Không có nhật ký giao dịch nào</td></tr>`;
      return;
    }

    tbody.innerHTML = data.ledger
      .map((l) => {
        const deltaClass = l.delta >= 0 ? "delta-pos" : "delta-neg";
        const deltaSign = l.delta >= 0 ? `+${l.delta}` : `${l.delta}`;
        return `
          <tr>
            <td>${formatTime(l.created_at)}</td>
            <td><strong>${escapeHtml(l.display_name || l.username)}</strong> <small class="text-muted">(@${escapeHtml(l.username)})</small></td>
            <td><strong class="${deltaClass}">${deltaSign}</strong> điểm</td>
            <td><code>${l.type}</code></td>
            <td>${escapeHtml(l.reason || "—")}</td>
            <td><small class="text-muted">${l.reference_id ? escapeHtml(l.reference_id).slice(0, 8) : "—"}</small></td>
          </tr>
        `;
      })
      .join("");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center">Lỗi: ${err.message}</td></tr>`;
  }
}

// --- TAB 4: FEEDBACK & CHAT -----------------------------------------------

function initFeedbackTab() {
  document.getElementById("feedback-toggle")?.addEventListener("click", toggleFeedbackSetting);
  document.getElementById("chat-toggle")?.addEventListener("click", toggleChatSetting);
  document.getElementById("chat-clear")?.addEventListener("click", clearChat);
  document.getElementById("admin-chat-form")?.addEventListener("submit", handleAdminChatSubmit);
  document.getElementById("chat-ai-settings-form")?.addEventListener("submit", saveChatAiSettings);
  document.getElementById("chat-ai-kick")?.addEventListener("click", kickChatAi);
  document.getElementById("chat-ai-memory-reset")?.addEventListener("click", resetChatAiMemory);
  document.getElementById("chat-ai-memory-list")?.addEventListener("click", handleChatAiMemoryAction);
}

async function loadFeedback() {
  try {
    const res = await fetch("/api/feedback");
    const data = await res.json();
    if (data.stats) {
      document.getElementById("stat-total").textContent = data.stats.total;
      document.getElementById("stat-today").textContent = data.stats.today;
      document.getElementById("stat-week").textContent = data.stats.last7Days;
    }

    const fbToggle = document.getElementById("feedback-toggle");
    if (fbToggle) {
      fbToggle.textContent = data.feedbackOn ? "Góp ý: Bật" : "Góp ý: Tắt";
      fbToggle.className = data.feedbackOn ? "toggle-btn on" : "toggle-btn";
    }

    const chatToggle = document.getElementById("chat-toggle");
    if (chatToggle) {
      chatToggle.textContent = data.chatOn ? "Chat: Bật" : "Chat: Tắt";
      chatToggle.className = data.chatOn ? "toggle-btn on" : "toggle-btn";
    }

    const container = document.getElementById("feedback-list");
    document.getElementById("feedback-count").textContent = `${data.items?.length || 0} góp ý`;
    if (!data.items || !data.items.length) {
      container.innerHTML = `<div class="empty">Chưa có góp ý nào từ khách.</div>`;
      return;
    }

    container.innerHTML = data.items
      .map(
        (item) => `
        <div class="feedback-card">
          <div class="feedback-card-head">
            <strong>${escapeHtml(item.name)}</strong>
            <div>
              <span>${formatTime(item.createdAt)}</span>
              <button class="action-btn btn-sm btn-warn" onclick="deleteFeedback('${item.id}')">Xóa</button>
            </div>
          </div>
          <p>${escapeHtml(item.content)}</p>
        </div>
      `
      )
      .join("");
  } catch (err) {
    console.error("Lỗi tải feedback:", err);
  }
}

async function toggleFeedbackSetting() {
  const current = document.getElementById("feedback-toggle").classList.contains("on");
  await fetch("/api/feedback/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ on: !current }),
  });
  loadFeedback();
}

async function toggleChatSetting() {
  const current = document.getElementById("chat-toggle").classList.contains("on");
  await fetch("/api/feedback/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatOn: !current }),
  });
  loadFeedback();
}

async function clearChat() {
  if (!confirm("Xóa toàn bộ tin nhắn, tóm tắt và memory AI chưa ghim trong phòng?")) return;
  await fetch("/api/chat", { method: "DELETE" });
  document.getElementById("admin-chat-messages").innerHTML = "";
  await loadChatAiSettings();
  showStatus("Đã xóa chat và bộ nhớ hội thoại chưa ghim.");
}

async function loadChatAiSettings() {
  const statusEl = document.getElementById("chat-ai-status");
  try {
    const res = await fetch("/api/admin/chat-ai/settings");
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.reason || "Không thể tải cấu hình AI.");
    const settings = data.settings || {};
    document.getElementById("chat-ai-enabled").checked = settings.enabled === true;
    document.getElementById("chat-ai-name").value = settings.name || "Office DJ";
    document.getElementById("chat-ai-autonomy").value = settings.autonomy || "balanced";
    document.getElementById("chat-ai-style").value = settings.stylePrompt || "";
    document.getElementById("chat-ai-knowledge").value = settings.knowledgePrompt || "";
    document.getElementById("chat-ai-context-chars").value = settings.contextCharBudget || 100000;
    document.getElementById("chat-ai-cooldown").value = settings.cooldownSeconds || 30;
    document.getElementById("chat-ai-max-hour").value = settings.maxRepliesPerHour || 12;
    document.getElementById("chat-ai-idle-minutes").value = settings.proactiveIdleMinutes ?? 8;
    document.getElementById("chat-ai-memory-enabled").checked = settings.memoryEnabled !== false;
    document.getElementById("chat-ai-summary-enabled").checked = settings.summaryEnabled !== false;

    const provider = document.getElementById("chat-ai-provider-status");
    provider.textContent = data.configured ? "Provider sẵn sàng" : "Chưa có key AI";
    provider.className = data.configured ? "badge badge-active" : "badge badge-blocked";
    const kickButton = document.getElementById("chat-ai-kick");
    kickButton.disabled = !data.configured || !settings.enabled;

    const stateLabels = {
      idle: "Sẵn sàng",
      thinking: "AI đang suy nghĩ…",
      provider_error: "Lần gọi gần nhất gặp lỗi provider",
    };
    const lastStatus = data.status || {};
    const context = lastStatus.contextCharacters ? ` · context ${Number(lastStatus.contextCharacters).toLocaleString("vi-VN")} ký tự` : "";
    statusEl.textContent = `${stateLabels[lastStatus.state] || "Sẵn sàng"}${context}`;
    document.getElementById("chat-ai-summary").textContent = data.summary?.content || "Chưa có tóm tắt.";
    renderChatAiMemories(data.memories || []);
  } catch (error) {
    statusEl.textContent = error.message || "Không thể tải cấu hình AI.";
  }
}

async function saveChatAiSettings(event) {
  event.preventDefault();
  const button = document.getElementById("chat-ai-save");
  const statusEl = document.getElementById("chat-ai-status");
  button.disabled = true;
  statusEl.textContent = "Đang lưu…";
  try {
    const res = await fetch("/api/admin/chat-ai/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: document.getElementById("chat-ai-enabled").checked,
        name: document.getElementById("chat-ai-name").value.trim(),
        autonomy: document.getElementById("chat-ai-autonomy").value,
        stylePrompt: document.getElementById("chat-ai-style").value.trim(),
        knowledgePrompt: document.getElementById("chat-ai-knowledge").value.trim(),
        contextCharBudget: Number(document.getElementById("chat-ai-context-chars").value),
        cooldownSeconds: Number(document.getElementById("chat-ai-cooldown").value),
        maxRepliesPerHour: Number(document.getElementById("chat-ai-max-hour").value),
        proactiveIdleMinutes: Number(document.getElementById("chat-ai-idle-minutes").value),
        memoryEnabled: document.getElementById("chat-ai-memory-enabled").checked,
        summaryEnabled: document.getElementById("chat-ai-summary-enabled").checked,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.reason || "Không thể lưu cấu hình AI.");
    await loadChatAiSettings();
    showStatus("Đã lưu cấu hình AI.");
  } catch (error) {
    statusEl.textContent = error.message || "Không thể lưu cấu hình AI.";
  } finally {
    button.disabled = false;
  }
}

async function kickChatAi() {
  const button = document.getElementById("chat-ai-kick");
  button.disabled = true;
  try {
    const res = await fetch("/api/admin/chat-ai/kick", { method: "POST" });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.reason || "Không thể gọi AI.");
    document.getElementById("chat-ai-status").textContent = "Đã yêu cầu AI đánh giá một lượt khuấy động.";
    setTimeout(loadChatAiSettings, 1800);
  } catch (error) {
    document.getElementById("chat-ai-status").textContent = error.message || "Không thể gọi AI.";
  } finally {
    button.disabled = false;
  }
}

function renderChatAiMemories(memories) {
  const container = document.getElementById("chat-ai-memory-list");
  if (!memories.length) {
    container.innerHTML = '<div class="ai-empty">AI chưa ghi nhớ điều gì từ hội thoại.</div>';
    return;
  }
  container.innerHTML = memories
    .map(
      (memory) => `
        <article class="ai-memory-card">
          <div class="ai-memory-card-head">
            <strong class="ai-memory-key">${memory.pinned ? "📌 " : ""}${escapeHtml(memory.type)}/${escapeHtml(memory.key)}</strong>
            <div class="ai-memory-actions">
              <button type="button" class="action-btn btn-sm" data-memory-action="pin" data-memory-id="${escapeHtml(memory.id)}" data-pinned="${memory.pinned}">${memory.pinned ? "Bỏ ghim" : "Ghim"}</button>
              <button type="button" class="action-btn btn-sm btn-warn" data-memory-action="delete" data-memory-id="${escapeHtml(memory.id)}">Xóa</button>
            </div>
          </div>
          <p>${escapeHtml(memory.content)}</p>
          <small class="ai-memory-meta">Độ tin cậy ${Math.round(Number(memory.confidence || 0) * 100)}% · cập nhật ${formatTime(memory.updatedAt)}</small>
        </article>`
    )
    .join("");
}

async function handleChatAiMemoryAction(event) {
  const button = event.target.closest("button[data-memory-action]");
  if (!button) return;
  const id = button.dataset.memoryId;
  const action = button.dataset.memoryAction;
  if (action === "delete" && !confirm("Xóa memory này?")) return;
  button.disabled = true;
  const res = await fetch(`/api/admin/chat-ai/memories/${encodeURIComponent(id)}`, {
    method: action === "pin" ? "PATCH" : "DELETE",
    headers: action === "pin" ? { "Content-Type": "application/json" } : undefined,
    body: action === "pin" ? JSON.stringify({ pinned: button.dataset.pinned !== "true" }) : undefined,
  });
  const data = await res.json();
  if (!res.ok || !data.ok) showStatus(data.reason || "Không thể cập nhật memory.", true);
  await loadChatAiSettings();
}

async function resetChatAiMemory() {
  if (!confirm("Xóa tóm tắt và toàn bộ memory AI chưa ghim? Tin nhắn chat vẫn được giữ.")) return;
  const res = await fetch("/api/admin/chat-ai/memory", { method: "DELETE" });
  const data = await res.json();
  if (!res.ok || !data.ok) return showStatus(data.reason || "Không thể reset bộ nhớ AI.", true);
  await loadChatAiSettings();
  showStatus("Đã reset bộ nhớ AI chưa ghim.");
}

window.deleteFeedback = async function (id) {
  if (!confirm("Xóa góp ý này?")) return;
  await fetch(`/api/feedback/${id}`, { method: "DELETE" });
  loadFeedback();
};

function handleAdminChatSubmit(e) {
  e.preventDefault();
  const input = document.getElementById("admin-chat-message");
  const nameInput = document.getElementById("admin-chat-name");
  const text = input.value.trim();
  const name = nameInput.value.trim() || "Admin";
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({
    type: "chatSend",
    name,
    text,
    admin: true,
    clientId: "admin_panel",
  }));
  input.value = "";
}

// --- WebSocket Live Stream -----------------------------------------------

function initWebSocket() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    document.getElementById("admin-chat-status").textContent = "Đã kết nối phòng chat";
  };

  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }

    if (msg.type === "sessionRevoked") {
      if (ws) {
        ws.onclose = null;
        ws.close();
        ws = null;
      }
      adminUser = null;
      showLoginGate(msg.reason || "Phiên quản trị không còn hiệu lực.");
    } else if (msg.type === "chatHistory") {
      const box = document.getElementById("admin-chat-messages");
      if (box) {
        box.innerHTML = msg.messages.map(renderChatMessage).join("");
        box.scrollTop = box.scrollHeight;
      }
    } else if (msg.type === "chatMessage") {
      const box = document.getElementById("admin-chat-messages");
      if (box) {
        box.innerHTML += renderChatMessage(msg.message);
        box.scrollTop = box.scrollHeight;
      }
    } else if (msg.type === "chatCleared") {
      const box = document.getElementById("admin-chat-messages");
      if (box) box.innerHTML = "";
    } else if (msg.type === "pointDropAvailable" || msg.type === "airdropDirect") {
      loadDrops();
      loadLedger();
    }
  };

  ws.onclose = () => {
    document.getElementById("admin-chat-status").textContent = "Mất kết nối — đang thử lại…";
    setTimeout(initWebSocket, 2000);
  };
}

function renderChatMessage(m) {
  const isAdmin = m.isAdmin;
  const isAI = m.isAI;
  const badge = isAI
    ? '<span class="ai-badge">AI</span> '
    : isAdmin
      ? '<span class="admin-badge">ADMIN</span> '
      : "";
  return `
    <div style="margin-bottom: 8px; font-size: 13px;">
      <strong style="color: ${isAI ? "oklch(82% .12 245)" : isAdmin ? "var(--red)" : "var(--gold)"}">${badge}${escapeHtml(m.name)}:</strong>
      <span style="color: var(--text)">${escapeHtml(m.text)}</span>
    </div>
  `;
}

// --- Helpers --------------------------------------------------------------

function formatTime(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")} ${d.getDate()}/${d.getMonth() + 1}`;
  } catch {
    return iso;
  }
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

function renderPagination(containerId, page, total, limit, onPage) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.replaceChildren();
  const pageCount = Math.ceil(Number(total || 0) / limit);
  if (pageCount <= 1) return;

  const previous = document.createElement("button");
  previous.type = "button";
  previous.className = "action-btn";
  previous.textContent = "Trang trước";
  previous.disabled = page <= 1;
  previous.addEventListener("click", () => onPage(page - 1));

  const status = document.createElement("span");
  status.className = "pagination-status";
  status.textContent = `Trang ${page} / ${pageCount}`;

  const next = document.createElement("button");
  next.type = "button";
  next.className = "action-btn";
  next.textContent = "Trang sau";
  next.disabled = page >= pageCount;
  next.addEventListener("click", () => onPage(page + 1));

  container.append(previous, status, next);
}
