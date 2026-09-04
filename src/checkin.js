import { randomUUID } from "node:crypto";
import { rankForXp } from "./rank.js";

export const DEFAULT_TIMEZONE = "Asia/Ho_Chi_Minh";

function resolveTimezone(timezone) {
  return timezone || process.env.APP_TIMEZONE || DEFAULT_TIMEZONE;
}

export function getLocalDate(timezone = null, date = new Date()) {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: resolveTimezone(timezone),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return formatter.format(date); // YYYY-MM-DD
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function getYesterdayLocalDate(timezone = null, date = new Date()) {
  const yesterday = new Date(date.getTime() - 24 * 60 * 60 * 1000);
  return getLocalDate(timezone, yesterday);
}

export function calculateMilestoneBonus(streakAfter) {
  // Milestone bonuses: day 3: +2, day 7: +5, day 14: +10, day 30: +20.
  // After day 30, the cycle repeats modulo 30.
  const cycleDay = ((streakAfter - 1) % 30) + 1;
  if (cycleDay === 3) return { bonus: 2, isMilestone: true, milestoneDay: 3 };
  if (cycleDay === 7) return { bonus: 5, isMilestone: true, milestoneDay: 7 };
  if (cycleDay === 14) return { bonus: 10, isMilestone: true, milestoneDay: 14 };
  if (cycleDay === 30) return { bonus: 20, isMilestone: true, milestoneDay: 30 };
  return { bonus: 0, isMilestone: false, milestoneDay: cycleDay };
}

export function performCheckin(db, userId, { timezone = null, now = new Date() } = {}) {
  const today = getLocalDate(timezone, now);
  const yesterday = getYesterdayLocalDate(timezone, now);

  const tx = db.transaction(() => {
    const user = db.query("SELECT * FROM users WHERE id = ?").get(userId);
    if (!user || user.status !== "active") {
      throw new Error("Tài khoản không hợp lệ hoặc bị khóa");
    }

    const rankProfile = db.query("SELECT xp_total FROM user_rank_profiles WHERE user_id = ?").get(userId);
    const rank = rankForXp(rankProfile?.xp_total || 0);

    // Check if already checked in today (Idempotent check)
    const existingCheckin = db
      .query("SELECT * FROM checkins WHERE user_id = ? AND local_date = ?")
      .get(userId, today);

    if (existingCheckin) {
      return {
        ok: true,
        alreadyCheckedIn: true,
        streak: user.current_streak,
        pointsAwarded: 0,
        basePoints: rank.checkinPoints,
        newBalance: user.points_balance,
        isMilestone: false,
        localDate: today,
        rank: {
          level: rank.level,
          name: rank.name,
          checkinPoints: rank.checkinPoints,
        },
      };
    }

    // Calculate streak
    let streakAfter = 1;
    if (user.last_checkin_date === yesterday) {
      streakAfter = (user.current_streak || 0) + 1;
    }

    const { bonus: bonusPoints, isMilestone } = calculateMilestoneBonus(streakAfter);
    const basePoints = rank.checkinPoints;
    const totalAwarded = basePoints + bonusPoints;
    const newBalance = user.points_balance + totalAwarded;
    const nowIso = now.toISOString();

    const checkinId = randomUUID();
    db.run(
      `INSERT INTO checkins (id, user_id, local_date, streak_after, base_points, bonus_points, checked_in_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [checkinId, userId, today, streakAfter, basePoints, bonusPoints, nowIso]
    );

    // Ledger for base point
    const baseLedgerId = randomUUID();
    db.run(
      `INSERT INTO point_ledger (id, user_id, delta, type, reference_id, actor_user_id, reason, created_at)
       VALUES (?, ?, ?, 'daily_checkin', ?, NULL, ?, ?)`,
      [baseLedgerId, userId, basePoints, checkinId, `Điểm danh ngày ${today}`, nowIso]
    );

    // Ledger for streak bonus if any
    if (bonusPoints > 0) {
      const bonusLedgerId = randomUUID();
      db.run(
        `INSERT INTO point_ledger (id, user_id, delta, type, reference_id, actor_user_id, reason, created_at)
         VALUES (?, ?, ?, 'streak_bonus', ?, NULL, ?, ?)`,
        [bonusLedgerId, userId, bonusPoints, checkinId, `Thưởng chuỗi streak ngày ${streakAfter} (+${bonusPoints}đ)`, nowIso]
      );
    }

    // Update user
    db.run(
      `UPDATE users
       SET points_balance = ?, current_streak = ?, last_checkin_date = ?, updated_at = ?
       WHERE id = ?`,
      [newBalance, streakAfter, today, nowIso, userId]
    );

    return {
      ok: true,
      alreadyCheckedIn: false,
      streak: streakAfter,
      pointsAwarded: totalAwarded,
      basePoints,
      bonusPoints,
      newBalance,
      isMilestone,
      localDate: today,
      rank: {
        level: rank.level,
        name: rank.name,
        checkinPoints: rank.checkinPoints,
      },
    };
  });

  return tx.immediate();
}
