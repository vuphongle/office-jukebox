// Admin Dashboard Logic: Member management, Airdrops, Audit Ledger, Feedback & Chat

let ws = null;
let currentTab = "tab-users";
let adminUser = null;
let selectedUserId = null;

// Pagination states
let usersPage = 1;
let dropsPage = 1;
let ledgerPage = 1;

// --- Khởi tạo & Tab Navigation -------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  setupTabs();
  initAuthAndProfile();
  initUsersTab();
  initDropsTab();
  initLedgerTab();
  initFeedbackTab();
  initWebSocket();
});

function setupTabs() {
  const tabBtns = document.querySelectorAll(".tab-btn");
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabBtns.forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-selected", "false");
      });
      document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));

      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      currentTab = btn.dataset.tab;
      document.getElementById(currentTab).classList.add("active");

      // Refresh data on tab switch
      if (currentTab === "tab-users") loadUsers();
      else if (currentTab === "tab-drops") loadDrops();
      else if (currentTab === "tab-ledger") loadLedger();
      else if (currentTab === "tab-feedback") loadFeedback();
    });
  });
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
    if (data.ok && data.authenticated) {
      adminUser = data.user;
      const el = document.getElementById("admin-user-info");
      if (el) {
        el.textContent = `Xin chào, ${adminUser.displayName || adminUser.username} (${adminUser.role})`;
      }
    }
  } catch (err) {
    console.error("Lỗi lấy thông tin admin:", err);
  }
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

  loadUsers();
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
      return;
    }

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
            <td><strong class="delta-pos">${u.points_balance}</strong> 🪙</td>
            <td>🔥 ${u.current_streak}</td>
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
  document.getElementById("modal-target-username").textContent = `@${username}`;
  document.getElementById("modal-current-balance").textContent = currentBalance;
  document.getElementById("adjust-delta").value = "";
  document.getElementById("adjust-reason").value = "";
  document.getElementById("points-modal").classList.remove("hidden");
};

function closePointsModal() {
  selectedUserId = null;
  document.getElementById("points-modal").classList.add("hidden");
}

async function handlePointsAdjustment(e) {
  e.preventDefault();
  if (!selectedUserId) return;
  const delta = parseInt(document.getElementById("adjust-delta").value, 10);
  const reason = document.getElementById("adjust-reason").value.trim();

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
            <td><strong class="${deltaClass}">${deltaSign}</strong> 🪙</td>
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
  loadDrops();
}

async function handleDirectAirdrop(e) {
  e.preventDefault();
  const points = parseInt(document.getElementById("direct-points").value, 10);
  const title = document.getElementById("direct-reason").value.trim();

  if (!confirm(`Xác nhận phát ${points} điểm cho TOÀN BỘ thành viên đang hoạt động?`)) return;

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
  }
}

async function handleClaimableDrop(e) {
  e.preventDefault();
  const points = parseInt(document.getElementById("claimable-points").value, 10);
  const title = document.getElementById("claimable-title").value.trim();

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
  }
}

async function loadDrops() {
  const tbody = document.getElementById("drops-tbody");
  if (!tbody) return;

  try {
    const res = await fetch(`/api/admin/point-drops?page=${dropsPage}&limit=20`);
    const data = await res.json();
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
            <td><strong class="delta-pos">+${d.points}</strong> 🪙</td>
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

  loadLedger();
}

async function loadLedger() {
  const search = document.getElementById("ledger-search-input")?.value || "";
  const type = document.getElementById("ledger-type-filter")?.value || "";
  const tbody = document.getElementById("ledger-tbody");
  if (!tbody) return;

  try {
    const res = await fetch(`/api/admin/ledger?search=${encodeURIComponent(search)}&type=${encodeURIComponent(type)}&page=${ledgerPage}&limit=30`);
    const data = await res.json();
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
            <td><strong class="${deltaClass}">${deltaSign}</strong> 🪙</td>
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
  loadFeedback();
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
  if (!confirm("Bạn có chắc chắn muốn xóa toàn bộ tin nhắn chat trong phòng?")) return;
  await fetch("/api/chat", { method: "DELETE" });
  document.getElementById("admin-chat-messages").innerHTML = "";
  showStatus("Đã xóa sạch tin nhắn phòng chat.");
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

  ws.onopen = async () => {
    document.getElementById("admin-chat-status").textContent = "Đã kết nối phòng chat";
    try {
      const res = await fetch("/api/host-token");
      const data = await res.json();
      if (data.token) {
        ws.send(JSON.stringify({ type: "auth", token: data.token }));
      }
    } catch {}
  };

  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }

    if (msg.type === "chatHistory") {
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
  const badge = isAdmin ? '<span class="admin-badge">ADMIN</span> ' : "";
  return `
    <div style="margin-bottom: 8px; font-size: 13px;">
      <strong style="color: ${isAdmin ? "var(--red)" : "var(--gold)"}">${badge}${escapeHtml(m.name)}:</strong>
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
