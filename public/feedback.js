const listEl = document.getElementById("feedback-list");
const toggleEl = document.getElementById("feedback-toggle");
const statusEl = document.getElementById("page-status");
let feedbackOn = true;

function setStatus(message, bad = false) {
  statusEl.textContent = message;
  statusEl.className = `page-status${bad ? " bad" : ""}`;
}

function renderToggle() {
  toggleEl.textContent = `Góp ý: ${feedbackOn ? "Bật" : "Tắt"}`;
  toggleEl.classList.toggle("on", feedbackOn);
  toggleEl.setAttribute("aria-pressed", String(feedbackOn));
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("vi-VN", { dateStyle: "medium", timeStyle: "short" });
}

function render(data) {
  feedbackOn = !!data.feedbackOn;
  renderToggle();
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

toggleEl.onclick = async () => {
  toggleEl.disabled = true;
  try {
    const res = await fetch("/api/feedback/settings", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: !feedbackOn }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.reason || "Không thể cập nhật cài đặt.");
    feedbackOn = data.feedbackOn;
    renderToggle();
    setStatus(`Đã ${feedbackOn ? "bật" : "tắt"} tính năng góp ý.`);
  } catch (error) {
    setStatus(error.message || "Không thể cập nhật cài đặt.", true);
  } finally {
    toggleEl.disabled = false;
  }
};

load();
