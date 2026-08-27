// Pure helpers for the persistent activity/rank system.
// Rank XP is intentionally separate from wallet points used for voting.

export const RANK_LEVELS = Object.freeze([
  Object.freeze({ level: 1, minXp: 0, name: "Người mới bắt nhịp", badge: "headphones-blue" }),
  Object.freeze({ level: 2, minXp: 100, name: "Bắt nhịp", badge: "pulse" }),
  Object.freeze({ level: 3, minXp: 300, name: "Tạo vibe", badge: "flame" }),
  Object.freeze({ level: 4, minXp: 700, name: "DJ cộng đồng", badge: "turntable" }),
  Object.freeze({ level: 5, minXp: 1_500, name: "Headliner", badge: "stage-star" }),
  Object.freeze({ level: 6, minXp: 3_000, name: "Huyền thoại", badge: "neon-crown" }),
]);

export const RANK_XP_DEFAULTS = Object.freeze({
  qualifiedPlay: 10,
  voteParticipation: 2,
  chatWindowCap: 8,
  dailyCap: 100,
});

const DEFAULT_DURATION_SECONDS = 210;

/**
 * Return the rank descriptor for a cumulative XP value.
 * Levels are one-based (1..6) to match the user-facing rank labels.
 */
export function rankForXp(xp) {
  const normalizedXp = normalizeXp(xp);
  let current = RANK_LEVELS[0];
  for (const rank of RANK_LEVELS) {
    if (normalizedXp >= rank.minXp) current = rank;
    else break;
  }

  const next = RANK_LEVELS.find((rank) => rank.minXp > normalizedXp) || null;
  return {
    ...current,
    xp: normalizedXp,
    nextLevel: next?.level || null,
    nextMinXp: next?.minXp || null,
    xpToNext: next ? Math.max(0, next.minXp - normalizedXp) : 0,
  };
}

// Named alias makes call sites read naturally while retaining a concise helper.
export const getRankForXp = rankForXp;

/**
 * The minimum amount of a song that must have played before a host skip earns
 * rank XP. Natural ended playback is always eligible and does not use this.
 * The threshold is bounded to 30..90 seconds and is 30% of known duration.
 */
export function qualifiedPlayThreshold(duration) {
  const seconds = durationToSeconds(duration);
  // played_seconds is persisted as an integer; ceil prevents a short skip
  // from qualifying when 30% of the duration is fractional.
  return Math.min(90, Math.max(30, Math.ceil(seconds * 0.3)));
}

export function isQualifiedPlay({ finishReason, playedSeconds, duration } = {}) {
  if (finishReason === "ended") return true;
  if (finishReason !== "skipped") return false;
  const played = Number(playedSeconds);
  return Number.isFinite(played) && played >= qualifiedPlayThreshold(duration);
}

export function durationToSeconds(duration) {
  if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
    return duration;
  }
  if (typeof duration !== "string") return DEFAULT_DURATION_SECONDS;
  const normalized = duration.trim();
  if (!/^\d+(?::\d+){0,2}$/.test(normalized)) return DEFAULT_DURATION_SECONDS;
  const parts = normalized.split(":");
  if (parts.length > 1 && parts.slice(1).some((part) => Number(part) >= 60)) {
    return DEFAULT_DURATION_SECONDS;
  }
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_DURATION_SECONDS;
}

function normalizeXp(xp) {
  const numeric = Number(xp);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.floor(numeric));
}
