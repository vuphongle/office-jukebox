const listEl = document.getElementById("feedback-list");
const toggleEl = document.getElementById("feedback-toggle");
const chatToggleEl = document.getElementById("chat-toggle");
const statusEl = document.getElementById("page-status");
let feedbackOn = true;
let chatOn = true;

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

load();
