import { RANK_LEVELS } from "./rank.js";

export const DEFAULT_EVENT_ID = "default_event";
export const PERSONAL_AWARD_SCOPE = "lifetime";

// The recurring bonus is intentionally non-stacking: a check-in receives only
// the highest tier it has reached. The exact 3/7/14/30 milestone bonus remains
// additive and is calculated by checkin.js.
export const STREAK_TIERS = Object.freeze([
  { minStreak: 0, bonusPoints: 0, label: "Khởi động" },
  { minStreak: 10, bonusPoints: 1, label: "Bền bỉ 10 ngày" },
  { minStreak: 20, bonusPoints: 2, label: "Bền bỉ 20 ngày" },
  { minStreak: 30, bonusPoints: 3, label: "Bền bỉ 30 ngày" },
]);

export const STREAK_MILESTONE_REWARDS = Object.freeze({
  10: 3,
  20: 5,
  30: 10,
});

export const RANK_MILESTONE_REWARDS = Object.freeze({
  2: 3,
  3: 5,
  4: 10,
  5: 15,
  6: 25,
});

export const STREAK_PODIUM_REWARDS = Object.freeze({
  10: Object.freeze({ 1: 5, 2: 3 }),
  20: Object.freeze({ 1: 10, 2: 5 }),
  30: Object.freeze({ 1: 20, 2: 10 }),
});

export const RANK_PODIUM_REWARDS = Object.freeze({
  2: Object.freeze({ 1: 5, 2: 3 }),
  3: Object.freeze({ 1: 10, 2: 5 }),
  4: Object.freeze({ 1: 15, 2: 8 }),
  5: Object.freeze({ 1: 25, 2: 12 }),
  6: Object.freeze({ 1: 40, 2: 20 }),
});

export const CLAIMABLE_DROP_DURATION_PRESETS = Object.freeze([1, 4, 8, 24]);
export const DEFAULT_CLAIMABLE_DROP_DURATION_HOURS = 8;

export function streakTierFor(streak) {
  const safeStreak = Math.max(0, Math.floor(Number(streak) || 0));
  return STREAK_TIERS.reduce((current, tier) => (
    safeStreak >= tier.minStreak ? tier : current
  ), STREAK_TIERS[0]);
}

export function streakTierBonusFor(streak) {
  return streakTierFor(streak).bonusPoints;
}

export function milestoneRewardFor(table, milestone) {
  return Number(table?.[milestone] || 0);
}

export function rankDefinitionFor(level) {
  return RANK_LEVELS.find((rank) => rank.level === Number(level)) || null;
}

export function getEngagementRules() {
  return {
    eventId: DEFAULT_EVENT_ID,
    policy: {
      retroactive: false,
      personalRewards: "one_time_per_account",
      podiumRewards: "first_and_second_per_event",
      recurringStreakBonus: "highest_tier_only",
    },
    streak: {
      tiers: STREAK_TIERS.map((tier) => ({ ...tier })),
      legacyMilestones: [
        { day: 3, points: 2 },
        { day: 7, points: 5 },
        { day: 14, points: 10 },
        { day: 30, points: 20 },
      ],
      personalRewards: Object.entries(STREAK_MILESTONE_REWARDS).map(([day, points]) => ({
        day: Number(day),
        points,
      })),
      podiumRewards: Object.entries(STREAK_PODIUM_REWARDS).map(([day, places]) => ({
        day: Number(day),
        places: Object.entries(places).map(([place, points]) => ({ place: Number(place), points })),
      })),
    },
    ranks: {
      levels: RANK_LEVELS.map((rank) => ({
        level: rank.level,
        minXp: rank.minXp,
        name: rank.name,
        badge: rank.badge,
        checkinPoints: rank.checkinPoints,
      })),
      personalRewards: Object.entries(RANK_MILESTONE_REWARDS).map(([level, points]) => ({
        level: Number(level),
        points,
        name: rankDefinitionFor(level)?.name || "",
      })),
      podiumRewards: Object.entries(RANK_PODIUM_REWARDS).map(([level, places]) => ({
        level: Number(level),
        name: rankDefinitionFor(level)?.name || "",
        places: Object.entries(places).map(([place, points]) => ({ place: Number(place), points })),
      })),
    },
    claimableDrop: {
      durationPresetsHours: [...CLAIMABLE_DROP_DURATION_PRESETS],
      defaultDurationHours: DEFAULT_CLAIMABLE_DROP_DURATION_HOURS,
      previousActiveDrop: "superseded",
      adminCancellation: true,
    },
    notifications: {
      inbox: {
        dailyCheckin: false,
        streakMilestone: true,
        rankPromotion: true,
        rewardAward: true,
        voteRefund: true,
        directAirdrop: true,
        claimableDropClaim: false,
      },
      groupChat: {
        streakMilestone: true,
        rankPromotion: true,
        podium: true,
      },
    },
  };
}
