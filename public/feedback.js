const listEl = document.getElementById("feedback-list");
const toggleEl = document.getElementById("feedback-toggle");
const chatToggleEl = document.getElementById("chat-toggle");
const chatClearEl = document.getElementById("chat-clear");
const statusEl = document.getElementById("page-status");
const adminChatMessagesEl = document.getElementById("admin-chat-messages");
const adminChatForm = document.getElementById("admin-chat-form");
const adminChatNameEl = document.getElementById("admin-chat-name");
const adminChatMessageEl = document.getElementById("admin-chat-message");
const adminChatSendEl = document.getElementById("admin-chat-send");
const adminChatStatusEl = document.getElementById("admin-chat-status");
let feedbackOn = true;
let chatOn = true;
let adminChatWs = null;
let adminChatPending = false;
let adminChatMessages = [];
const adminClientId = (() => {
  const key = "adminChatClientId";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const value = window.crypto?.randomUUID?.() || `admin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(key, value);
  return value;
})();

adminChatNameEl.value = localStorage.getItem("adminChatName") || "Admin";

function setAdminChatStatus(message, bad = false) {
  adminChatStatusEl.textContent = message;
  adminChatStatusEl.className = `admin-chat-status${bad ? " bad" : ""}`;
}

function renderAdminChatMessages() {
  adminChatMessagesEl.innerHTML = "";
  if (!adminChatMessages.length) {
    adminChatMessagesEl.innerHTML = '<p class="admin-chat-empty">Chưa có tin nhắn trong phòng chat.</p>';
    return;
  }
  for (const message of adminChatMessages) {
    const item = document.createElement("article");
    item.className = `admin-chat-message${message.senderId === adminClientId ? " is-own" : ""}${message.isAdmin ? " is-admin" : ""}`;
    const head = document.createElement("div");
    head.className = "admin-chat-message-head";
    const name = document.createElement("strong");
    name.textContent = message.name;
    head.appendChild(name);
    if (message.isAdmin) {
      const badge = document.createElement("span");
      badge.className = "admin-badge compact";
      badge.textContent = "ADMIN";
      head.appendChild(badge);
    }
    const text = document.createElement("p");
    text.textContent = message.text;
    item.append(head, text);
    adminChatMessagesEl.appendChild(item);
  }
  adminChatMessagesEl.scrollTop = adminChatMessagesEl.scrollHeight;
}

function appendAdminChatMessage(message) {
  if (!message || typeof message.name !== "string" || typeof message.text !== "string") return;
  adminChatMessages.push({
    name: message.name.slice(0, 40),
    text: message.text.slice(0, 280),
    senderId: typeof message.senderId === "string" ? message.senderId.slice(0, 64) : "",
    isAdmin: message.isAdmin === true,
  });
  if (adminChatMessages.length > 40) adminChatMessages = adminChatMessages.slice(-40);
  renderAdminChatMessages();
}

function renderAdminChatAvailability() {
  const disabled = !chatOn;
  adminChatNameEl.disabled = disabled;
  adminChatMessageEl.disabled = disabled;
  adminChatSendEl.disabled = disabled || adminChatPending;
  if (disabled) setAdminChatStatus("Chat đang tắt.");
}

async function connectAdminChat() {
  try {
    const tokenResponse = await fetch("/api/host-token");
    if (!tokenResponse.ok) throw new Error("Không thể xác thực phòng chat admin.");
    const { token = "" } = await tokenResponse.json();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}`);
    adminChatWs = ws;
    ws.onopen = () => {
      if (token) ws.send(JSON.stringify({ type: "auth", token }));
      if (chatOn) setAdminChatStatus("Đã kết nối phòng chat.");
    };
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "state") {
        if (typeof message.chatOn === "boolean") chatOn = message.chatOn;
        if (!chatOn) {
          adminChatPending = false;
          adminChatMessages = [];
          renderAdminChatMessages();
        }
        renderAdminChatAvailability();
      } else if (message.type === "chatHistory") {
        adminChatMessages = [];
        for (const item of Array.isArray(message.messages) ? message.messages.slice(-40) : []) appendAdminChatMessage(item);
      } else if (message.type === "chatMessage") {
        appendAdminChatMessage(message.message);
      } else if (message.type === "chatCleared") {
        adminChatMessages = [];
        renderAdminChatMessages();
        setAdminChatStatus("Tin nhắn đã được làm mới.");
      } else if (message.type === "chatSendResult") {
        adminChatPending = false;
        renderAdminChatAvailability();
        if (message.ok) {
          adminChatMessageEl.value = "";
          setAdminChatStatus("Đã gửi tin nhắn admin.");
        } else {
          setAdminChatStatus(message.reason || "Không thể gửi tin nhắn.", true);
        }
      }
    };
    ws.onclose = () => {
      adminChatPending = false;
      renderAdminChatAvailability();
      if (chatOn) setAdminChatStatus("Mất kết nối, đang thử lại…", true);
      window.setTimeout(connectAdminChat, 2000);
    };
  } catch (error) {
    setAdminChatStatus(error.message || "Không thể kết nối phòng chat admin.", true);
    window.setTimeout(connectAdminChat, 2000);
  }
}

adminChatNameEl.addEventListener("change", () => {
  localStorage.setItem("adminChatName", adminChatNameEl.value.trim().slice(0, 40));
});

adminChatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!chatOn || adminChatPending) return;
  if (!adminChatWs || adminChatWs.readyState !== WebSocket.OPEN) {
    setAdminChatStatus("Mất kết nối, đang thử lại…", true);
    return;
  }
  const name = adminChatNameEl.value.trim();
  const text = adminChatMessageEl.value.trim();
  if (!name) {
    setAdminChatStatus("Vui lòng nhập tên admin.", true);
    adminChatNameEl.focus();
    return;
  }
  if (!text) {
    setAdminChatStatus("Vui lòng nhập nội dung tin nhắn.", true);
    adminChatMessageEl.focus();
    return;
  }
  localStorage.setItem("adminChatName", name);
  adminChatPending = true;
  renderAdminChatAvailability();
  adminChatWs.send(JSON.stringify({ type: "chatSend", admin: true, name, text, clientId: adminClientId }));
});

function setStatus(message, bad = false) {
  statusEl.textContent = message;
  statusEl.className = `page-status${bad ? " bad" : ""}`;
}

function renderToggle() {
  toggleEl.textContent = `Góp ý: ${feedbackOn ? "Bật" : "Tắt"}`;
  toggleEl.classList.toggle("on", feedbackOn);
  toggleEl.setAttribute("aria-pressed", String(feedbackOn));
}

function renderChatToggle() {
  chatToggleEl.textContent = `Chat: ${chatOn ? "Bật" : "Tắt"}`;
  chatToggleEl.classList.toggle("on", chatOn);
  chatToggleEl.setAttribute("aria-pressed", String(chatOn));
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("vi-VN", { dateStyle: "medium", timeStyle: "short" });
}

function render(data) {
  feedbackOn = !!data.feedbackOn;
  chatOn = data.chatOn !== false;
  renderToggle();
  renderChatToggle();
  renderAdminChatAvailability();
  document.getElementById("stat-total").textContent = data.stats.total;
  document.getElementById("stat-today").textContent = data.stats.today;
  document.getElementById("stat-week").textContent = data.stats.last7Days;
  document.getElementById("list-count").textContent = `${data.items.length} mục`;
  listEl.innerHTML = "";
  if (!data.items.length) {
    listEl.innerHTML = '<p class="empty">Chưa có góp ý nào.</p>';
    return;
  }
  for (const item of data.items) {
    const card = document.createElement("article");
    card.className = "feedback-item";
    const del = document.createElement("button");
    del.className = "delete-btn";
    del.type = "button";
    del.title = "Xóa góp ý";
    del.setAttribute("aria-label", "Xóa góp ý");
    del.textContent = "×";
    del.onclick = () => deleteFeedback(item.id);
    const head = document.createElement("div");
    head.className = "feedback-item-head";
    const name = document.createElement("strong");
    name.className = "feedback-name";
    name.textContent = item.name;
    const date = document.createElement("time");
    date.className = "feedback-date";
    date.dateTime = item.createdAt;
    date.textContent = formatDate(item.createdAt);
    head.append(name, date);
    const content = document.createElement("p");
    content.className = "feedback-content";
    content.textContent = item.content;
    card.append(del, head, content);
    listEl.appendChild(card);
  }
}

async function load() {
  try {
    const res = await fetch("/api/feedback");
    if (!res.ok) throw new Error("Không thể tải danh sách góp ý.");
    render(await res.json());
    setStatus("");
  } catch (error) {
    setStatus(error.message || "Không thể tải danh sách góp ý.", true);
  }
}

async function deleteFeedback(id) {
  if (!window.confirm("Xóa góp ý này?")) return;
  try {
    const res = await fetch(`/api/feedback/${encodeURIComponent(id)}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.reason || "Không thể xóa góp ý.");
    await load();
  } catch (error) {
    setStatus(error.message || "Không thể xóa góp ý.", true);
  }
}

async function updateSettings(payload, successMessage) {
  try {
    const res = await fetch("/api/feedback/settings", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.reason || "Không thể cập nhật cài đặt.");
    if (typeof data.feedbackOn === "boolean") feedbackOn = data.feedbackOn;
    if (typeof data.chatOn === "boolean") chatOn = data.chatOn;
    renderToggle();
    renderChatToggle();
    renderAdminChatAvailability();
    setStatus(successMessage);
  } catch (error) {
    setStatus(error.message || "Không thể cập nhật cài đặt.", true);
  }
}

toggleEl.onclick = async () => {
  toggleEl.disabled = true;
  await updateSettings({ on: !feedbackOn }, `Đã ${!feedbackOn ? "bật" : "tắt"} tính năng góp ý.`);
  toggleEl.disabled = false;
};

chatToggleEl.onclick = async () => {
  chatToggleEl.disabled = true;
  await updateSettings({ chatOn: !chatOn }, `Đã ${!chatOn ? "bật" : "tắt"} tính năng chat.`);
  chatToggleEl.disabled = false;
};

chatClearEl.onclick = async () => {
  if (!window.confirm("Xóa toàn bộ tin nhắn chat hiện tại? Tin nhắn không thể khôi phục.")) return;
  chatClearEl.disabled = true;
  try {
    const res = await fetch("/api/chat", { method: "DELETE" });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.reason || "Không thể xóa tin nhắn chat.");
    setStatus(data.cleared ? `Đã xóa ${data.cleared} tin nhắn chat.` : "Chat hiện không có tin nhắn.");
  } catch (error) {
    setStatus(error.message || "Không thể xóa tin nhắn chat.", true);
  } finally {
    chatClearEl.disabled = false;
  }
};

load();
connectAdminChat();
