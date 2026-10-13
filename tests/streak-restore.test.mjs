import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb } from "../src/db.js";
import { performCheckin } from "../src/checkin.js";
import { performStreakRestore, getStreakRestoreStatus } from "../src/streakRestore.js";

describe("performStreakRestore", () => {
  let db;
  const tz = "Asia/Ho_Chi_Minh";

  beforeEach(() => {
    db = initDb({ dbPath: ":memory:" });
  });

  function createUser(id, username, { streak = 5, lastCheckin = "2026-10-13", brokenStreak = 0, brokenMissedDate = null } = {}) {
    const nowIso = new Date().toISOString();
    db.run(
      `INSERT INTO users (id, username, password_hash, display_name, role, status, points_balance, current_streak, last_checkin_date, broken_streak, broken_missed_date, created_at, updated_at)
       VALUES (?, ?, 'hash', ?, 'user', 'active', 100, ?, ?, ?, ?, ?, ?)`,
      [id, username, username, streak, lastCheckin, brokenStreak, brokenMissedDate, nowIso, nowIso]
    );
    db.run(
      `INSERT INTO user_rank_profiles (user_id, xp_total, created_at, updated_at) VALUES (?, 100, ?, ?)`,
      [id, nowIso, nowIso]
    );
  }

  it("restores streak when 1 day missed and not checked in today yet (Case A)", () => {
    // Last checked in: 2026-10-13 (streak = 5). Missed: 2026-10-14. Today: 2026-10-15.
    const now = new Date("2026-10-15T03:00:00.000Z"); // 10:00 AM UTC+7
    createUser("u1", "alice", { streak: 5, lastCheckin: "2026-10-13" });

    const statusBefore = getStreakRestoreStatus(db, "u1", { now, timezone: tz });
    expect(statusBefore.restoreAvailable).toBe(true);

    const res = performStreakRestore(db, "u1", { now, timezone: tz });
    expect(res.ok).toBe(true);
    expect(res.streak).toBe(6); // 5 + 1 (yesterday restored)

    const userAfter = db.query("SELECT * FROM users WHERE id = 'u1'").get();
    expect(userAfter.current_streak).toBe(6);
    expect(userAfter.last_checkin_date).toBe("2026-10-14");

    // Checkin record created with is_restored = 1 and base_points = 0
    const checkin = db.query("SELECT * FROM checkins WHERE user_id = 'u1' AND local_date = '2026-10-14'").get();
    expect(checkin).not.toBeNull();
    expect(checkin.is_restored).toBe(1);
    expect(checkin.base_points).toBe(0);

    // No daily_checkin ledger created for restored checkin
    const ledger = db.query("SELECT * FROM point_ledger WHERE user_id = 'u1' AND reference_id = ?").get(checkin.id);
    expect(ledger).toBeNull();

    // Now user performs regular checkin today -> streak becomes 7!
    const checkinToday = performCheckin(db, "u1", { timezone: tz, now });
    expect(checkinToday.ok).toBe(true);
    expect(checkinToday.streak).toBe(7);
  });

  it("restores streak when 1 day missed and user already checked in today (Case B)", () => {
    // Missed 2026-10-14. User checked in on 2026-10-15 (streak reset to 1).
    const now = new Date("2026-10-15T03:00:00.000Z");
    createUser("u2", "bob", { streak: 5, lastCheckin: "2026-10-13" });

    // Bob checks in today
    const checkinToday = performCheckin(db, "u2", { timezone: tz, now });
    expect(checkinToday.streak).toBe(1);

    const user = db.query("SELECT * FROM users WHERE id = 'u2'").get();
    expect(user.broken_streak).toBe(5);
    expect(user.broken_missed_date).toBe("2026-10-14");

    // Bob restores
    const restoreRes = performStreakRestore(db, "u2", { now, timezone: tz });
    expect(restoreRes.ok).toBe(true);
    expect(restoreRes.streak).toBe(7); // 5 (broken) + 1 (restored yesterday) + 1 (today) = 7

    const userAfter = db.query("SELECT * FROM users WHERE id = 'u2'").get();
    expect(userAfter.current_streak).toBe(7);
    expect(userAfter.broken_streak).toBe(0);
    expect(userAfter.broken_missed_date).toBeNull();
  });

  it("rejects when 2 or more days were missed", () => {
    // Last checked in: 2026-10-12. Today: 2026-10-15. Missed 2 days (13 & 14).
    const now = new Date("2026-10-15T03:00:00.000Z");
    createUser("u3", "carol", { streak: 5, lastCheckin: "2026-10-12" });

    expect(() => {
      performStreakRestore(db, "u3", { now, timezone: tz });
    }).toThrow("Chuỗi không đủ điều kiện khôi phục");
  });

  it("enforces monthly quota (1 restore per calendar month)", () => {
    const nowOct = new Date("2026-10-15T03:00:00.000Z");
    createUser("u4", "david", { streak: 5, lastCheckin: "2026-10-13" });

    // 1st restore in October succeeds
    const res1 = performStreakRestore(db, "u4", { now: nowOct, timezone: tz });
    expect(res1.ok).toBe(true);

    // Later in October, breaks streak again
    db.run("UPDATE users SET current_streak = 8, last_checkin_date = '2026-10-25' WHERE id = 'u4'");
    const nowOctLate = new Date("2026-10-27T03:00:00.000Z"); // missed 2026-10-26

    expect(() => {
      performStreakRestore(db, "u4", { now: nowOctLate, timezone: tz });
    }).toThrow("Bạn đã dùng lượt khôi phục chuỗi của tháng này");

    // In November (next calendar month), quota resets!
    db.run("UPDATE users SET current_streak = 10, last_checkin_date = '2026-11-03' WHERE id = 'u4'");
    const nowNov = new Date("2026-11-05T03:00:00.000Z"); // missed 2026-11-04
    const res2 = performStreakRestore(db, "u4", { now: nowNov, timezone: tz });
    expect(res2.ok).toBe(true);
    expect(res2.streak).toBe(11);
  });

  it("creates notification and returns status with Case B correctly", () => {
    const now = new Date("2026-10-15T03:00:00.000Z");
    createUser("u5", "eve", { streak: 7, lastCheckin: "2026-10-13" });

    // Checked in today with reset streak to 1
    performCheckin(db, "u5", { timezone: tz, now });

    const status = getStreakRestoreStatus(db, "u5", { now, timezone: tz });
    expect(status.restoreAvailable).toBe(true);
    expect(status.restoreEligible).toBe(true);
    expect(status.brokenStreak).toBe(7);
    expect(status.restoresLeftThisMonth).toBe(1);

    const mockNotificationRepo = {
      notifications: [],
      createNotification(item) {
        this.notifications.push(item);
      },
    };

    const res = performStreakRestore(db, "u5", { now, timezone: tz, notificationRepo: mockNotificationRepo });
    expect(res.ok).toBe(true);
    expect(mockNotificationRepo.notifications.length).toBe(1);
    expect(mockNotificationRepo.notifications[0].message).toContain("9 ngày");

    const statusAfter = getStreakRestoreStatus(db, "u5", { now, timezone: tz });
    expect(statusAfter.restoreAvailable).toBe(false);
    expect(statusAfter.restoresLeftThisMonth).toBe(0);
  });
});

