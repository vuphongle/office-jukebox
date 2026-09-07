import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { initDb, closeDb } from "../src/db.js";
import { performCheckin } from "../src/checkin.js";
import { getEngagementRules, streakTierBonusFor } from "../src/engagement.js";
import { EngagementRepository } from "../src/repositories/engagementRepository.js";
import { ChatRepository } from "../src/repositories/chatRepository.js";
import { NotificationRepository } from "../src/repositories/notificationRepository.js";
import { RankRepository } from "../src/repositories/rankRepository.js";
import { UserRepository } from "../src/repositories/userRepository.js";

afterEach(() => closeDb());

function checkinDay(db, userId, day, options = {}) {
  return performCheckin(db, userId, {
    now: new Date(`2026-08-${String(day).padStart(2, "0")}T10:00:00.000Z`),
    ...options,
  });
}

test("engagement rules expose highest-tier streak bonuses and conservative rewards", () => {
  assert.equal(streakTierBonusFor(9), 0);
  assert.equal(streakTierBonusFor(10), 1);
  assert.equal(streakTierBonusFor(25), 2);
  assert.equal(streakTierBonusFor(30), 3);
  const rules = getEngagementRules();
  assert.equal(rules.policy.retroactive, false);
  assert.deepEqual(rules.claimableDrop.durationPresetsHours, [1, 4, 8, 24]);
  assert.equal(rules.streak.personalRewards.find((item) => item.day === 10).points, 3);
});

test("streak awards are transactional, idempotent, and podium rewards stop at second place", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const notificationRepo = new NotificationRepository(db);
  const engagementRepo = new EngagementRepository(db, {
    notificationRepo,
    getNotificationsEnabled: () => true,
  });
  const first = userRepo.create({ username: "streak-first", passwordHash: "p" });
  const second = userRepo.create({ username: "streak-second", passwordHash: "p" });
  const third = userRepo.create({ username: "streak-third", passwordHash: "p" });

  const checkinOptions = { notificationRepo, engagementRepo };
  for (let day = 1; day <= 10; day += 1) checkinDay(db, first.id, day, checkinOptions);
  for (let day = 1; day <= 10; day += 1) checkinDay(db, second.id, day, checkinOptions);
  for (let day = 1; day <= 10; day += 1) checkinDay(db, third.id, day, checkinOptions);

  assert.equal(db.query("SELECT COUNT(*) AS total FROM engagement_awards WHERE category = 'streak' AND award_kind = 'podium'").get().total, 2);
  assert.equal(db.query("SELECT points FROM engagement_awards WHERE user_id = ? AND category = 'streak' AND award_kind = 'podium'").get(first.id).points, 5);
  assert.equal(db.query("SELECT points FROM engagement_awards WHERE user_id = ? AND category = 'streak' AND award_kind = 'podium'").get(second.id).points, 3);
  assert.equal(db.query("SELECT COUNT(*) AS total FROM engagement_awards WHERE user_id = ? AND category = 'streak' AND award_kind = 'personal'").get(first.id).total, 1);
  assert.equal(notificationRepo.listForUser(first.id).items.some((item) => item.sourceType === "engagement_reward"), true);

  const beforeAwards = db.query("SELECT COUNT(*) AS total FROM engagement_awards").get().total;
  const repeat = checkinDay(db, first.id, 10, checkinOptions);
  assert.equal(repeat.alreadyCheckedIn, true);
  assert.equal(db.query("SELECT COUNT(*) AS total FROM engagement_awards").get().total, beforeAwards);
  assert.equal(engagementRepo.db.query("SELECT COUNT(*) AS total FROM point_ledger WHERE type = 'engagement_reward'").get().total, 5);
});

test("rank promotion grants the personal and event podium rewards once", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const notificationRepo = new NotificationRepository(db);
  const engagementRepo = new EngagementRepository(db, { notificationRepo });
  const rankRepo = new RankRepository(db, { notificationRepo, engagementRepo });
  const user = userRepo.create({ username: "rank-reward", passwordHash: "p" });
  rankRepo.ensureProfile(user.id);
  db.run("UPDATE user_rank_profiles SET xp_total = 99, rank_level = 1 WHERE user_id = ?", [user.id]);

  const result = rankRepo.awardXp({
    userId: user.id,
    activityType: "test_promotion",
    sourceId: "promotion-1",
    deltaXp: 1,
  });

  assert.equal(result.awarded, true);
  assert.equal(result.profile.rankLevel, 2);
  assert.equal(result.pointsAwarded, 8);
  assert.equal(userRepo.findById(user.id).points_balance, 8);
  assert.equal(result.notifications.length, 2);
  assert.equal(db.query("SELECT COUNT(*) AS total FROM point_ledger WHERE type = 'engagement_reward'").get().total, 2);
});

test("streak milestone inbox uses the final balance after achievement rewards", () => {
  const db = initDb({ dbPath: ":memory:", adminUser: "admin", adminPass: "p" });
  const userRepo = new UserRepository(db);
  const notificationRepo = new NotificationRepository(db);
  const engagementRepo = new EngagementRepository(db, { notificationRepo });
  const user = userRepo.create({ username: "streak-thirty", passwordHash: "p" });
  db.run(
    "UPDATE users SET current_streak = 29, last_checkin_date = '2026-08-29' WHERE id = ?",
    [user.id]
  );

  const result = performCheckin(db, user.id, {
    now: new Date("2026-08-30T10:00:00.000Z"),
    notificationRepo,
    engagementRepo,
  });
  const finalBalance = userRepo.findById(user.id).points_balance;
  const milestoneNotification = notificationRepo
    .listForUser(user.id, { limit: 20 })
    .items.find((item) => item.sourceType === "streak_milestone");

  assert.equal(result.newBalance, finalBalance);
  assert.match(milestoneNotification.body, new RegExp(`Số dư mới: ${finalBalance} điểm`));
});

test("engagement announcements can be persisted inside the reward transaction", () => {
  const db = initDb({ dbPath: ":memory:", adminUser: "admin", adminPass: "p" });
  const userRepo = new UserRepository(db);
  const engagementRepo = new EngagementRepository(db);
  const chatRepo = new ChatRepository(db);
  const user = userRepo.create({ username: "announcement-user", passwordHash: "p" });
  db.run(
    "UPDATE users SET current_streak = 2, last_checkin_date = '2026-08-02' WHERE id = ?",
    [user.id]
  );

  const result = performCheckin(db, user.id, {
    now: new Date("2026-08-03T10:00:00.000Z"),
    engagementRepo,
    createAnnouncementInTransaction: (announcements) => announcements.map((announcement) => chatRepo.create({
      id: `announcement-${announcement.awardId}`,
      name: "Thành tích",
      text: announcement.body,
      senderId: "system:engagement",
      userId: announcement.userId,
      isSystem: true,
      createdAt: announcement.createdAt,
    })),
  });

  assert.equal(result.chatMessages.length, 1);
  assert.equal(chatRepo.listRecent().length, 1);
  assert.equal(chatRepo.listRecent()[0].isSystem, true);
});
