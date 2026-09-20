const rankBadgeIcons = Object.freeze({
  "headphones-blue": "🎧",
  pulse: "⚡",
  flame: "🔥",
  turntable: "🎛️",
  "stage-star": "🌟",
  "neon-crown": "👑",
});

const leaderboardModes = Object.freeze({
  weekly: {
    endpoint: "/api/rank/weekly-leaderboard",
    kicker: "Music XP tuần",
    title: "Top 10 DJ tuần này",
    description: "Cơ hội mới mỗi tuần: đóng góp qua bài hát và vote để cùng tạo không khí.",
    note: "Music XP tính từ bài hát được phát hợp lệ và lượt vote cho bài đó. Chat XP vẫn thuộc hạng Lifetime.",
    empty: "Tuần này chưa có Music XP. Hãy thêm bài hoặc vote cho bài được phát để bắt đầu.",
    score: (entry) => Number(entry.weeklyMusicXp || 0),
    scoreLabel: "Music XP",
  },
  lifetime: {
    endpoint: "/api/rank/leaderboard",
    kicker: "XP tích lũy",
    title: "Top 10 hành trình",
    description: "Ghi nhận hành trình đóng góp dài hạn của các thành viên trong sự kiện.",
    note: "Chỉ hiển thị tên hiển thị, hạng và XP. Bảng xếp hạng được cập nhật khi bạn làm mới.",
    empty: "Chưa có thành viên trên bảng xếp hạng.",
    score: (entry) => Number(entry.xpTotal || 0),
    scoreLabel: "XP",
  },
});

const status = document.getElementById("leaderboard-status");
const podium = document.getElementById("leaderboard-podium");
const list = document.getElementById("leaderboard-list");
const refresh = document.getElementById("leaderboard-refresh");
const tabs = [...document.querySelectorAll("[data-leaderboard-mode]")];
const description = document.getElementById("leaderboard-description");
const kicker = document.getElementById("leaderboard-kicker");
const title = document.getElementById("leaderboard-card-title");
const note = document.getElementById("leaderboard-note");
const periodLabel = document.getElementById("leaderboard-period");
const leaderboardCard = document.getElementById("leaderboard-card");
const weeklyStanding = document.getElementById("weekly-standing");
const weeklyStandingPosition = document.getElementById("weekly-standing-position");
const weeklyStandingCopy = document.getElementById("weekly-standing-copy");
const initialMode = new URLSearchParams(window.location.search).get("view");
let selectedMode = Object.hasOwn(leaderboardModes, initialMode) ? initialMode : "weekly";
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

function formatPeriod(period) {
  if (!period?.startDate || !period?.endDate) return "";
  const end = new Date(`${period.endDate}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  const formatDate = (value) => {
    const [year, month, day] = value.split("-");
    return `${day}/${month}/${year}`;
  };
  return `Tuần ${formatDate(period.startDate)} - ${formatDate(end.toISOString().slice(0, 10))} · Giờ Việt Nam`;
}

function updateModeCopy(mode, period = null) {
  const config = leaderboardModes[mode];
  description.textContent = config.description;
  kicker.textContent = config.kicker;
  title.textContent = config.title;
  note.textContent = config.note;
  periodLabel.textContent = mode === "weekly" ? formatPeriod(period) : "";
  tabs.forEach((tab) => {
    const active = tab.dataset.leaderboardMode === mode;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-pressed", String(active));
  });
}

function writeModeToUrl(mode) {
  const url = new URL(window.location.href);
  if (mode === "weekly") url.searchParams.delete("view");
  else url.searchParams.set("view", mode);
  window.history.replaceState(null, "", url);
}

function renderLeaderboard(items, mode) {
  const config = leaderboardModes[mode];
  if (!items.length) {
    clearLeaderboard();
    status.textContent = config.empty;
    return;
  }

  status.textContent = `Top ${items.length} thành viên theo ${config.scoreLabel}`;
  podium.innerHTML = items.slice(0, 3).map((entry) => {
    const position = Number(entry.position) || 0;
    const level = Number(entry.rank?.level || 1);
    const icon = rankBadgeIcons[entry.rank?.badge] || "🎧";
    const score = config.score(entry).toLocaleString("vi-VN");
    return `<article class="leaderboard-podium-card place-${position}">
      <span class="leaderboard-place">#${position}</span>
      <span class="leaderboard-avatar" data-avatar-url="${escapeHtml(entry.avatarUrl || "")}" data-avatar-name="${escapeHtml(icon)}" aria-hidden="true">${icon}</span>
      <strong>${escapeHtml(entry.displayName || "Thành viên")}</strong>
      <small>Hạng ${level} · ${score} ${config.scoreLabel}</small>
    </article>`;
  }).join("");

  list.innerHTML = items.slice(3).map((entry) => {
    const icon = rankBadgeIcons[entry.rank?.badge] || "🎧";
    const score = config.score(entry).toLocaleString("vi-VN");
    return `<div class="leaderboard-row">
      <span class="leaderboard-number">#${Number(entry.position) || 0}</span>
      <span class="leaderboard-row-icon" data-avatar-url="${escapeHtml(entry.avatarUrl || "")}" data-avatar-name="${escapeHtml(icon)}" aria-hidden="true">${icon}</span>
      <span class="leaderboard-row-copy"><strong>${escapeHtml(entry.displayName || "Thành viên")}</strong><small>${escapeHtml(entry.rank?.name || "Người mới bắt nhịp")}</small></span>
      <span class="leaderboard-xp">${score} ${config.scoreLabel}</span>
    </div>`;
  }).join("");
  document.querySelectorAll("[data-avatar-url]").forEach((element) => {
    window.JukeboxAvatars?.apply(element, {
      avatarUrl: element.dataset.avatarUrl,
      name: element.dataset.avatarName,
    });
  });
}

async function loadWeeklyStanding() {
  try {
    const response = await fetch("/api/me/rank/weekly");
    if (response.status === 401) {
      weeklyStanding.classList.add("hidden");
      return;
    }
    const data = await response.json();
    if (!response.ok || !data?.ok || !data.weeklyRank) throw new Error("Không thể tải vị trí cá nhân.");
    const standing = data.weeklyRank;
    const score = Number(standing.weeklyMusicXp || 0).toLocaleString("vi-VN");
    weeklyStandingPosition.textContent = standing.position ? `#${standing.position}` : "—";
    weeklyStandingCopy.textContent = standing.position
      ? `${score} Music XP · ${standing.participantCount} người đang tham gia`
      : "Bạn chưa có Music XP tuần này. Thêm bài được phát hoặc vote cho bài đó để bắt đầu.";
    weeklyStanding.classList.remove("hidden");
  } catch {
    weeklyStanding.classList.add("hidden");
  }
}

async function loadLeaderboard() {
  if (leaderboardRequest) return leaderboardRequest;
  const mode = selectedMode;
  const config = leaderboardModes[mode];

  refresh.disabled = true;
  tabs.forEach((tab) => { tab.disabled = true; });
  leaderboardCard.setAttribute("aria-busy", "true");
  status.classList.add("is-loading");
  status.textContent = "Đang tải bảng xếp hạng…";
  leaderboardRequest = fetch(config.endpoint)
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
      updateModeCopy(mode, data.period);
      renderLeaderboard(data.leaderboard.slice(0, 10), mode);
      if (mode === "weekly") await loadWeeklyStanding();
      else weeklyStanding.classList.add("hidden");
    })
    .catch((error) => {
      clearLeaderboard();
      weeklyStanding.classList.add("hidden");
      status.textContent = `${error.message} Hãy thử làm mới.`;
    })
    .finally(() => {
      leaderboardRequest = null;
      refresh.disabled = false;
      tabs.forEach((tab) => { tab.disabled = false; });
      leaderboardCard.setAttribute("aria-busy", "false");
      status.classList.remove("is-loading");
    });

  return leaderboardRequest;
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const nextMode = tab.dataset.leaderboardMode;
    if (!leaderboardModes[nextMode] || nextMode === selectedMode || leaderboardRequest) return;
    selectedMode = nextMode;
    writeModeToUrl(selectedMode);
    updateModeCopy(selectedMode);
    weeklyStanding.classList.add("hidden");
    clearLeaderboard();
    loadLeaderboard();
  });
});
refresh.addEventListener("click", loadLeaderboard);
updateModeCopy(selectedMode);
loadLeaderboard();
