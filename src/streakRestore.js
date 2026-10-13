import { randomUUID } from "node:crypto";
import {
  DEFAULT_TIMEZONE,
  getLocalDate,
  getYesterdayLocalDate,
  computeStreakView,
  getTzOffsetMs,
} from "./checkin.js";

function resolveTimezone(timezone) {
  return timezone || process.env.APP_TIMEZONE || DEFAULT_TIMEZONE;
}

export function getMonthKey(timezone = null, date = new Date()) {
  const localDate = getLocalDate(timezone, date);
  return localDate.slice(0, 7); // YYYY-MM
}

export function getStreakRestoreStatus(db, userId, { now = new Date(), timezone = null } = {}) {
  const resolvedTz = resolveTimezone(timezone);
  const today = getLocalDate(resolvedTz, now);
  const yesterday = getYesterdayLocalDate(resolvedTz, now);
  const dayBeforeYesterday = getLocalDate(resolvedTz, new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000));
  const monthKey = getMonthKey(resolvedTz, now);

  const user = db.query("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) {
    return {
      restoreAvailable: false,
      restoreEligible: false,
      hasQuota: false,
      restoresUsedThisMonth: 0,
      restoresLeftThisMonth: 0,
      monthKey,
      restoreResetsAt: null,
      brokenStreak: 0,
      missedDate: yesterday,
    };
  }

  const existingRestore = db
    .query("SELECT id FROM streak_restores WHERE user_id = ? AND month_key = ?")
    .get(userId, monthKey);

  const hasQuota = !existingRestore;
  const restoresUsedThisMonth = existingRestore ? 1 : 0;
  const restoresLeftThisMonth = hasQuota ? 1 : 0;

  // Case A: Not checked in today, last checkin was dayBeforeYesterday
  const isCaseA = user.last_checkin_date === dayBeforeYesterday && (user.current_streak || 0) > 0;
  // Case B: Checked in today, but broke streak yesterday
  const isCaseB =
    user.last_checkin_date === today &&
    user.broken_missed_date === yesterday &&
    (user.broken_streak || 0) > 0;

  const restoreEligible = Boolean(isCaseA || isCaseB);
  const restoreAvailable = Boolean(hasQuota && restoreEligible);

  // Compute next month reset date: 01 of next month at 00:00:00 in timezone
  const [y, m] = today.split("-").map(Number);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const targetUtcMs = Date.UTC(nextY, nextM - 1, 1, 0, 0, 0);
  const nextOffsetMs = getTzOffsetMs(new Date(targetUtcMs), resolvedTz);
  const restoreResetsAt = new Date(targetUtcMs - nextOffsetMs).toISOString();

  const brokenStreak = isCaseB
    ? user.broken_streak
    : isCaseA
    ? user.current_streak
    : 0;

  return {
    restoreAvailable,
    restoreEligible,
    hasQuota,
    restoresUsedThisMonth,
    restoresLeftThisMonth,
    monthKey,
    restoreResetsAt,
    brokenStreak,
    missedDate: yesterday,
  };
}

export function performStreakRestore(
  db,
  userId,
  {
    now = new Date(),
    timezone = null,
    notificationRepo = null,
  } = {}
) {
  const resolvedTz = resolveTimezone(timezone);
  const today = getLocalDate(resolvedTz, now);
  const yesterday = getYesterdayLocalDate(resolvedTz, now);
  const dayBeforeYesterday = getLocalDate(resolvedTz, new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000));
  const monthKey = getMonthKey(resolvedTz, now);

  const tx = db.transaction(() => {
    const user = db.query("SELECT * FROM users WHERE id = ?").get(userId);
    if (!user || user.status !== "active") {
      throw new Error("Tài khoản không hợp lệ hoặc bị khóa");
    }

    // 1. Quota check
    const existingRestore = db
      .query("SELECT id FROM streak_restores WHERE user_id = ? AND month_key = ?")
      .get(userId, monthKey);

    if (existingRestore) {
      throw new Error("Bạn đã dùng lượt khôi phục chuỗi của tháng này");
    }

    const isCaseA = user.last_checkin_date === dayBeforeYesterday && (user.current_streak || 0) > 0;
    const isCaseB =
      user.last_checkin_date === today &&
      user.broken_missed_date === yesterday &&
      (user.broken_streak || 0) > 0;

    if (!isCaseA && !isCaseB) {
      throw new Error("Chuỗi không đủ điều kiện khôi phục");
    }

    const nowIso = now.toISOString();
    let streakBefore = 0;
    let streakAfter = 0;

    if (isCaseA) {
      streakBefore = user.current_streak || 0;
      streakAfter = streakBefore + 1; // yesterday restored

      // Insert restored checkin for yesterday
      const checkinId = randomUUID();
      db.run(
        `INSERT INTO checkins
         (id, user_id, local_date, streak_after, base_points, bonus_points, tier_bonus_points, achievement_points, checked_in_at, is_restored)
         VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?, 1)`,
        [checkinId, userId, yesterday, streakAfter, nowIso]
      );

      // Update user: current_streak = streakAfter, last_checkin_date = yesterday, clear broken_*
      db.run(
        `UPDATE users
         SET current_streak = ?, last_checkin_date = ?, broken_streak = 0, broken_missed_date = NULL, updated_at = ?
         WHERE id = ?`,
        [streakAfter, yesterday, nowIso, userId]
      );
    } else {
      // Case B: Already checked in today, streak was reset to 1
      streakBefore = user.broken_streak || 0;
      const restoredYesterdayStreak = streakBefore + 1;
      streakAfter = streakBefore + 2; // yesterday restored + today

      // Insert restored checkin for yesterday
      const checkinId = randomUUID();
      db.run(
        `INSERT INTO checkins
         (id, user_id, local_date, streak_after, base_points, bonus_points, tier_bonus_points, achievement_points, checked_in_at, is_restored)
         VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?, 1)`,
        [checkinId, userId, yesterday, restoredYesterdayStreak, nowIso]
      );

      // Update today's checkin row streak_after
      db.run(
        `UPDATE checkins
         SET streak_after = ?
         WHERE user_id = ? AND local_date = ?`,
        [streakAfter, userId, today]
      );

      // Update user: current_streak = streakAfter, clear broken_*
      db.run(
        `UPDATE users
         SET current_streak = ?, broken_streak = 0, broken_missed_date = NULL, updated_at = ?
         WHERE id = ?`,
        [streakAfter, nowIso, userId]
      );
    }

    // Insert streak_restores record
    const restoreId = randomUUID();
    db.run(
      `INSERT INTO streak_restores
       (id, user_id, month_key, missed_date, streak_before, streak_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [restoreId, userId, monthKey, yesterday, streakBefore, streakAfter, nowIso]
    );

    // Create in-app notification if notificationRepo provided
    if (notificationRepo && typeof notificationRepo.createNotification === "function") {
      try {
        notificationRepo.createNotification({
          userId,
          title: "Khôi phục chuỗi thành công",
          message: `Đã khôi phục chuỗi ${streakAfter} ngày 🔥`,
          type: "streak_restore",
        });
      } catch (err) {
        console.warn("[streakRestore] Failed to create notification:", err.message);
      }
    }

    const userAfter = db.query("SELECT * FROM users WHERE id = ?").get(userId);
    const view = computeStreakView(userAfter, now, resolvedTz);

    return {
      ok: true,
      streak: streakAfter,
      restoresLeftThisMonth: 0,
      view,
    };
  });

  return tx.immediate();
}
