const rankBadgeIcons = Object.freeze({
  "headphones-blue": "🎧",
  pulse: "⚡",
  flame: "🔥",
  turntable: "🎛️",
  "stage-star": "🌟",
  "neon-crown": "👑",
});

const status = document.getElementById("leaderboard-status");
const podium = document.getElementById("leaderboard-podium");
const list = document.getElementById("leaderboard-list");
const refresh = document.getElementById("leaderboard-refresh");
let leaderboardRequest = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function clearLeaderboard() {
  podium.replaceChildren();
  list.replaceChildren();
}

function renderLeaderboard(items) {
  if (!items.length) {
    clearLeaderboard();
    status.textContent = "Chưa có thành viên trên bảng xếp hạng.";
    return;
  }

  status.textContent = `Top ${items.length} thành viên có XP nổi bật nhất`;
  podium.innerHTML = items.slice(0, 3).map((entry) => {
    const position = Number(entry.position) || 0;
    const level = Number(entry.rank?.level || 1);
    const icon = rankBadgeIcons[entry.rank?.badge] || "🎧";
    return `<article class="leaderboard-podium-card place-${position}">
      <span class="leaderboard-place">#${position}</span>
      <span class="leaderboard-avatar" aria-hidden="true">${icon}</span>
      <strong>${escapeHtml(entry.displayName || "Thành viên")}</strong>
      <small>Hạng ${level} · ${Number(entry.xpTotal || 0).toLocaleString("vi-VN")} XP</small>
    </article>`;
  }).join("");

  list.innerHTML = items.slice(3).map((entry) => {
    const icon = rankBadgeIcons[entry.rank?.badge] || "🎧";
    return `<div class="leaderboard-row">
      <span class="leaderboard-number">#${Number(entry.position) || 0}</span>
      <span class="leaderboard-row-icon" aria-hidden="true">${icon}</span>
      <span class="leaderboard-row-copy"><strong>${escapeHtml(entry.displayName || "Thành viên")}</strong><small>${escapeHtml(entry.rank?.name || "Người mới bắt nhịp")}</small></span>
      <span class="leaderboard-xp">${Number(entry.xpTotal || 0).toLocaleString("vi-VN")} XP</span>
    </div>`;
  }).join("");
}

async function loadLeaderboard() {
  if (leaderboardRequest) return leaderboardRequest;

  refresh.disabled = true;
  status.classList.add("is-loading");
  status.textContent = "Đang tải bảng xếp hạng…";
  leaderboardRequest = fetch("/api/rank/leaderboard")
    .then(async (response) => {
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error("Phản hồi bảng xếp hạng không hợp lệ.");
      }
      if (!data || !response.ok || !data.ok || !Array.isArray(data.leaderboard)) {
        throw new Error(data?.reason || "Không thể tải bảng xếp hạng.");
      }
      renderLeaderboard(data.leaderboard.slice(0, 10));
    })
    .catch((error) => {
      clearLeaderboard();
      status.textContent = `${error.message} Hãy thử làm mới.`;
    })
    .finally(() => {
      leaderboardRequest = null;
      refresh.disabled = false;
      status.classList.remove("is-loading");
    });

  return leaderboardRequest;
}

refresh.addEventListener("click", loadLeaderboard);
loadLeaderboard();
