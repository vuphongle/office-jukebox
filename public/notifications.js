(() => {
  const MAX_ITEMS = 20;
  const state = {
    user: null,
    items: [],
    unreadCount: 0,
    open: false,
    loading: false,
    error: "",
    pendingIds: new Set(),
  };

  const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

  function bell() {
    return document.querySelector("[data-notification-bell]");
  }

  function modal() {
    return document.getElementById("notification-modal");
  }

  function updateBell() {
    const button = bell();
    if (!button) return;
    const count = Math.max(0, Number(state.unreadCount) || 0);
    const badge = button.querySelector("[data-notification-count]");
    button.classList.toggle("hidden", !state.user);
    button.disabled = !state.user;
    button.setAttribute("aria-label", count ? `Có ${count} thông báo chưa đọc` : "Mở thông báo");
    if (badge) {
      badge.textContent = count > 99 ? "99+" : String(count);
      badge.classList.toggle("hidden", count === 0);
    }
  }

  function syncUser(user) {
    const nextUser = user && user.id ? user : null;
    if (!nextUser) {
      state.user = null;
      state.items = [];
      state.unreadCount = 0;
      state.error = "";
      close();
    } else {
      const sameUserObject = state.user === nextUser;
      state.user = nextUser;
      if (!sameUserObject && Number.isSafeInteger(nextUser.unreadNotificationCount)) {
        state.unreadCount = nextUser.unreadNotificationCount;
      }
    }
    updateBell();
  }

  function formatTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString("vi-VN", { dateStyle: "medium", timeStyle: "short" });
  }

  function kindLabel(kind) {
    return { maintenance: "Bảo trì", feature: "Tính năng", info: "Thông tin" }[kind] || "Thông tin";
  }

  function setUnreadCount(value) {
    if (!Number.isSafeInteger(value)) return;
    state.unreadCount = Math.max(0, value);
    if (state.user) state.user.unreadNotificationCount = state.unreadCount;
  }

  function render() {
    const list = document.getElementById("notification-list");
    const summary = document.getElementById("notification-summary");
    const readAll = document.querySelector("[data-notification-read-all]");
    if (!list) return;

    const unread = Math.max(0, Number(state.unreadCount) || 0);
    if (summary) summary.textContent = unread ? `${unread} chưa đọc` : "Tất cả đã đọc";
    if (readAll) readAll.disabled = state.loading || unread === 0;

    if (state.loading && !state.items.length) {
      list.innerHTML = '<div class="notification-state">Đang tải thông báo…</div>';
      return;
    }
    if (state.error && !state.items.length) {
      list.innerHTML = `<div class="notification-state"><strong>Không thể tải thông báo</strong><p>${escapeHtml(state.error)}</p><button class="notification-retry" type="button" data-notification-retry>Thử lại</button></div>`;
      return;
    }
    if (!state.items.length) {
      list.innerHTML = '<div class="notification-state"><strong>Chưa có thông báo</strong><p>Các cập nhật từ Ban Tổ Chức sẽ xuất hiện tại đây.</p></div>';
      return;
    }

    list.innerHTML = state.items.slice(0, MAX_ITEMS).map((item) => {
      const id = escapeHtml(item.id);
      const pending = state.pendingIds.has(item.id);
      return `<button class="notification-item${item.read ? "" : " is-unread"}${pending ? " is-pending" : ""}" type="button" data-notification-id="${id}"${pending ? " disabled" : ""}>
        <span class="notification-item-meta"><span class="notification-kind kind-${escapeHtml(item.kind)}">${kindLabel(item.kind)}</span><time>${escapeHtml(formatTime(item.createdAt))}</time></span>
        <strong>${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(item.body)}</span>
      </button>`;
    }).join("");
  }

  async function load() {
    if (!state.user || state.loading) return;
    state.loading = true;
    state.error = "";
    render();
    try {
      const response = await fetch("/api/me/notifications?limit=20");
      const data = await response.json();
      if (response.status === 401) {
        syncUser(null);
        return;
      }
      if (!response.ok || !data.ok) throw new Error(data.reason || "Không thể tải thông báo.");
      state.items = Array.isArray(data.items) ? data.items.slice(0, MAX_ITEMS) : [];
      setUnreadCount(data.unreadCount);
    } catch (error) {
      state.error = error.message || "Không thể tải thông báo.";
    } finally {
      state.loading = false;
      updateBell();
      render();
    }
  }

  async function markRead(id) {
    if (!state.user || !id || state.pendingIds.has(id)) return;
    const item = state.items.find((entry) => entry.id === id);
    if (!item || item.read) return;
    state.pendingIds.add(id);
    render();
    try {
      const response = await fetch(`/api/me/notifications/${encodeURIComponent(id)}/read`, { method: "POST" });
      const data = await response.json();
      if (response.status === 401) {
        syncUser(null);
        return;
      }
      if (!response.ok || !data.ok) throw new Error(data.reason || "Không thể đánh dấu thông báo.");
      item.read = true;
      item.readAt = new Date().toISOString();
      setUnreadCount(data.unreadCount);
      state.error = "";
    } catch (error) {
      state.error = error.message || "Không thể đánh dấu thông báo.";
    } finally {
      state.pendingIds.delete(id);
      updateBell();
      render();
    }
  }

  async function markAllRead() {
    if (!state.user || !state.unreadCount) return;
    const button = document.querySelector("[data-notification-read-all]");
    if (button) button.disabled = true;
    try {
      const response = await fetch("/api/me/notifications/read-all", { method: "POST" });
      const data = await response.json();
      if (response.status === 401) {
        syncUser(null);
        return;
      }
      if (!response.ok || !data.ok) throw new Error(data.reason || "Không thể đánh dấu tất cả.");
      state.items.forEach((item) => {
        item.read = true;
        item.readAt ||= new Date().toISOString();
      });
      setUnreadCount(Number.isSafeInteger(data.unreadCount) ? data.unreadCount : 0);
      state.error = "";
    } catch (error) {
      state.error = error.message || "Không thể đánh dấu tất cả thông báo.";
    } finally {
      updateBell();
      render();
    }
  }

  function open() {
    if (!state.user) return;
    const dialog = modal();
    if (!dialog) return;
    state.open = true;
    state.error = "";
    dialog.classList.remove("hidden");
    render();
    load();
    dialog.querySelector("[data-notification-close]")?.focus();
  }

  function close() {
    state.open = false;
    modal()?.classList.add("hidden");
  }

  function handleSocketMessage(message) {
    if (!state.user || !message || typeof message !== "object") return;
    if (message.type === "notificationCreated" && message.notification?.id) {
      state.items = [message.notification, ...state.items.filter((item) => item.id !== message.notification.id)].slice(0, MAX_ITEMS);
      setUnreadCount(message.unreadCount);
      state.error = "";
      updateBell();
      if (state.open) render();
      window.dispatchEvent(new CustomEvent("jukebox:notification", { detail: message.notification }));
    } else if (message.type === "notificationsUpdated") {
      setUnreadCount(message.unreadCount);
      updateBell();
      if (state.open) load();
    }
  }

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-notification-bell]")) {
      event.preventDefault();
      open();
      return;
    }
    if (target.closest("[data-notification-close]")) {
      close();
      return;
    }
    if (target.closest("[data-notification-read-all]")) {
      markAllRead();
      return;
    }
    if (target.closest("[data-notification-retry]")) {
      load();
      return;
    }
    const item = target.closest("[data-notification-id]");
    if (item) markRead(item.dataset.notificationId);
    if (target.id === "notification-modal") close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.open) close();
  });

  window.JukeboxNotifications = Object.freeze({ syncUser, reset: () => syncUser(null), open, close, handleSocketMessage });
})();
