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
    liveNotifications: new Map(),
    notificationVersion: 0,
    readOverrides: new Map(),
    userGeneration: 0,
  };
  let activeLoad = null;

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
      if (state.user) state.userGeneration += 1;
      state.user = null;
      state.items = [];
      state.unreadCount = 0;
      state.error = "";
      state.loading = false;
      state.liveNotifications.clear();
      state.readOverrides.clear();
      state.pendingIds.clear();
      close();
    } else {
      const sameUserObject = state.user === nextUser;
      state.user = nextUser;
      if (!sameUserObject) {
        state.userGeneration += 1;
        state.items = [];
        state.unreadCount = 0;
        state.liveNotifications.clear();
        state.readOverrides.clear();
        state.pendingIds.clear();
        state.error = "";
        state.loading = false;
      }
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

  function sortItems(items) {
    return items.sort((a, b) => {
      const createdDiff = Date.parse(b.createdAt || "") - Date.parse(a.createdAt || "");
      if (Number.isFinite(createdDiff) && createdDiff !== 0) return createdDiff;
      return String(b.id || "").localeCompare(String(a.id || ""));
    });
  }

  function applyReadOverrides(items) {
    return items.map((item) => {
      const override = state.readOverrides.get(item.id);
      if (item.read) {
        state.readOverrides.delete(item.id);
        return item;
      }
      return override ? { ...item, ...override } : item;
    });
  }

  function applyLoadedItems(items, unreadCount, versionAtStart) {
    const serverItems = applyReadOverrides(Array.isArray(items) ? items.slice(0, MAX_ITEMS) : []);
    const serverIds = new Set(serverItems.map((item) => item.id));
    const liveEntries = [...state.liveNotifications.values()]
      .filter((entry) => entry.version > versionAtStart && !serverIds.has(entry.item.id));
    const liveItems = liveEntries.map((entry) => entry.item);
    state.items = sortItems([...serverItems, ...liveItems]).slice(0, MAX_ITEMS);
    state.liveNotifications.clear();

    const serverUnread = Number.isSafeInteger(unreadCount) ? Math.max(0, unreadCount) : state.unreadCount;
    const liveUnread = liveEntries.reduce((highest, entry) => {
      if (entry.item.read || !Number.isSafeInteger(entry.unreadCount)) return highest;
      return Math.max(highest, entry.unreadCount);
    }, 0);
    setUnreadCount(Math.max(serverUnread, liveUnread));
  }

  function errorMarkup() {
    if (!state.error) return "";
    return `<div class="notification-error" role="alert"><strong>Không thể cập nhật thông báo</strong><span>${escapeHtml(state.error)}</span><button class="notification-retry" type="button" data-notification-retry>Thử lại</button></div>`;
  }

  async function reloadAfterCurrent() {
    const pendingLoad = activeLoad?.promise;
    if (pendingLoad) await pendingLoad;
    await load();
  }

  function render() {
    const list = document.getElementById("notification-list");
    const summary = document.getElementById("notification-summary");
    const readAll = document.querySelector("[data-notification-read-all]");
    if (!list) return;

    const unread = Math.max(0, Number(state.unreadCount) || 0);
    if (summary) summary.textContent = unread ? `${unread} chưa đọc` : "Tất cả đã đọc";
    if (readAll) readAll.disabled = state.loading || unread === 0;

    const error = errorMarkup();
    if (state.loading && !state.items.length) {
      list.innerHTML = `${error}<div class="notification-state">Đang tải thông báo…</div>`;
      return;
    }
    if (state.error && !state.items.length) {
      list.innerHTML = `${error}<div class="notification-state"><strong>Chưa có thông báo để hiển thị</strong></div>`;
      return;
    }
    if (!state.items.length) {
      list.innerHTML = `${error}<div class="notification-state"><strong>Chưa có thông báo</strong><p>Các cập nhật từ Ban Tổ Chức sẽ xuất hiện tại đây.</p></div>`;
      return;
    }

    list.innerHTML = `${error}${state.items.slice(0, MAX_ITEMS).map((item) => {
      const id = escapeHtml(item.id);
      const pending = state.pendingIds.has(item.id);
      return `<button class="notification-item${item.read ? "" : " is-unread"}${pending ? " is-pending" : ""}" type="button" data-notification-id="${id}"${pending ? " disabled" : ""}>
        <span class="notification-item-meta"><span class="notification-kind kind-${escapeHtml(item.kind)}">${kindLabel(item.kind)}</span><time>${escapeHtml(formatTime(item.createdAt))}</time></span>
        <strong>${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(item.body)}</span>
      </button>`;
    }).join("")}`;
  }

  function load() {
    if (!state.user) return Promise.resolve();
    const generationAtStart = state.userGeneration;
    if (activeLoad?.generation === generationAtStart) return activeLoad.promise;
    const userAtStart = state.user;
    const versionAtStart = state.notificationVersion;
    const request = { generation: generationAtStart, promise: null };
    activeLoad = request;
    request.promise = (async () => {
      state.loading = true;
      state.error = "";
      render();
      try {
        const response = await fetch("/api/me/notifications?limit=20");
        const data = await response.json();
        if (state.user !== userAtStart || state.userGeneration !== generationAtStart) return;
        if (response.status === 401) {
          syncUser(null);
          return;
        }
        if (!response.ok || !data.ok) throw new Error(data.reason || "Không thể tải thông báo.");
        applyLoadedItems(data.items, data.unreadCount, versionAtStart);
      } catch (error) {
        state.error = error.message || "Không thể tải thông báo.";
      } finally {
        if (activeLoad === request) {
          state.loading = false;
          updateBell();
          render();
          activeLoad = null;
        }
      }
    })();
    return request.promise;
  }

  async function markRead(id) {
    if (!state.user || !id || state.pendingIds.has(id)) return;
    const item = state.items.find((entry) => entry.id === id);
    if (!item || item.read) return;
    state.pendingIds.add(id);
    const userAtStart = state.user;
    const versionAtStart = state.notificationVersion;
    const generationAtStart = state.userGeneration;
    render();
    try {
      const response = await fetch(`/api/me/notifications/${encodeURIComponent(id)}/read`, { method: "POST" });
      const data = await response.json();
      if (state.user !== userAtStart || state.userGeneration !== generationAtStart) return;
      if (response.status === 401) {
        syncUser(null);
        return;
      }
      if (!response.ok || !data.ok) throw new Error(data.reason || "Không thể đánh dấu thông báo.");
      const readAt = new Date().toISOString();
      item.read = true;
      item.readAt = readAt;
      state.readOverrides.set(id, { read: true, readAt });
      const currentVersion = state.notificationVersion;
      if (currentVersion === versionAtStart) setUnreadCount(data.unreadCount);
      else setUnreadCount(Math.max(Number(data.unreadCount) || 0, state.items.filter((entry) => !entry.read).length));
      state.error = "";
      await reloadAfterCurrent();
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
    const userAtStart = state.user;
    const versionAtStart = state.notificationVersion;
    const generationAtStart = state.userGeneration;
    try {
      const response = await fetch("/api/me/notifications/read-all", { method: "POST" });
      const data = await response.json();
      if (state.user !== userAtStart || state.userGeneration !== generationAtStart) return;
      if (response.status === 401) {
        syncUser(null);
        return;
      }
      if (!response.ok || !data.ok) throw new Error(data.reason || "Không thể đánh dấu tất cả.");
      if (state.notificationVersion === versionAtStart && Number.isSafeInteger(data.unreadCount)) {
        setUnreadCount(data.unreadCount);
      }
      state.error = "";
      await reloadAfterCurrent();
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
      state.notificationVersion += 1;
      const notification = { ...message.notification, read: false, readAt: null };
      state.liveNotifications.set(notification.id, {
        item: notification,
        unreadCount: message.unreadCount,
        version: state.notificationVersion,
      });
      state.items = [notification, ...state.items.filter((item) => item.id !== notification.id)].slice(0, MAX_ITEMS);
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
