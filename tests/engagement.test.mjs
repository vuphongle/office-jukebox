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
  assert.deepEqual(rules.weeklyLeaderboard.includedActivityTypes, ["qualified_play", "vote_participation"]);
  assert.equal(rules.weeklyLeaderboard.lifetimeXpReset, false);
});

test("rules expose the approved long-term streak and rank rewards without a day-20 award", () => {
  const { streak, ranks } = getEngagementRules();
  const personal = Object.fromEntries(streak.personalRewards.map((item) => [item.day, item.points]));
  assert.deepEqual(personal, { 10: 3, 30: 10, 100: 20, 200: 50, 365: 100 });
  const podium = Object.fromEntries(streak.podiumRewards.map((item) => [
    item.day,
    item.places.map((place) => place.points),
  ]));
  assert.deepEqual(podium, { 10: [5, 3], 30: [20, 10], 100: [30, 15], 200: [50, 25], 365: [100, 50] });
  assert.equal(streak.personalRewards.some((item) => item.day === 20), false);
  assert.equal(streak.podiumRewards.some((item) => item.day === 20), false);
  // Recurring tiers are not part of this change.
  assert.deepEqual(streak.tiers.map((tier) => tier.minStreak), [0, 10, 20, 30]);
  assert.deepEqual(
    streak.legacyMilestones.map((item) => [item.day, item.points, item.repeats]),
    [[3, 2, true], [7, 5, true], [14, 10, true], [30, 20, true], [100, 50, false], [200, 100, false], [365, 150, false]]
  );

  assert.deepEqual(
    ranks.personalRewards.map((item) => [item.level, item.points]),
    [[2, 3], [3, 5], [4, 10], [5, 15], [6, 25], [7, 35], [8, 50], [9, 75], [10, 100], [11, 150]]
  );
  assert.deepEqual(
    ranks.podiumRewards.map((item) => [item.level, item.places.map((place) => place.points)]),
    [[2, [5, 3]], [3, [10, 5]], [4, [15, 8]], [5, [25, 12]], [6, [40, 20]], [7, [50, 25]], [8, [70, 35]], [9, [100, 50]], [10, [150, 75]], [11, [200, 100]]]
  );
  assert.equal(ranks.personalRewards.find((item) => item.level === 6).name, "Biểu tượng âm nhạc");
  assert.equal(ranks.levels.length, 11);
});

test("streak 100/200/365 grant personal and top-2 podium rewards once; day 20 grants nothing", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const engagementRepo = new EngagementRepository(db);
  const users = ["a", "b", "c"].map((name) => userRepo.create({ username: `long-streak-${name}`, passwordHash: "p" }));
  const expected = {
    100: { personal: 20, podium: [30, 15] },
    200: { personal: 50, podium: [50, 25] },
    365: { personal: 100, podium: [100, 50] },
  };

  for (const [day, reward] of Object.entries(expected)) {
    const results = users.map((user) => engagementRepo.awardStreakMilestones({ userId: user.id, streakAfter: Number(day) }));
    assert.deepEqual(results.map((result) => result.pointsAwarded), [
      reward.personal + reward.podium[0],
      reward.personal + reward.podium[1],
      reward.personal,
    ]);
    // Re-awarding is idempotent.
    assert.equal(engagementRepo.awardStreakMilestones({ userId: users[0].id, streakAfter: Number(day) }).pointsAwarded, 0);
  }

  assert.equal(engagementRepo.awardStreakMilestones({ userId: users[0].id, streakAfter: 20 }).pointsAwarded, 0);
});

test("rank 7-11 promotion rewards match the approved table", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const engagementRepo = new EngagementRepository(db);
  const first = userRepo.create({ username: "rank-table-first", passwordHash: "p" });
  const second = userRepo.create({ username: "rank-table-second", passwordHash: "p" });
  const third = userRepo.create({ username: "rank-table-third", passwordHash: "p" });
  const personal = { 7: 35, 8: 50, 9: 75, 10: 100, 11: 150 };
  const podium = { 7: [50, 25], 8: [70, 35], 9: [100, 50], 10: [150, 75], 11: [200, 100] };

  for (const level of [7, 8, 9, 10, 11]) {
    const totals = [first, second, third].map((user) => (
      engagementRepo.awardRankMilestones({ userId: user.id, crossedLevels: [level] }).pointsAwarded
    ));
    assert.deepEqual(totals, [
      personal[level] + podium[level][0],
      personal[level] + podium[level][1],
      personal[level],
    ]);
  }
});

test("day-100 check-in adds the +50 milestone, one-time reward and podium on top of the base reward", () => {
  const db = initDb({ dbPath: ":memory:", adminUser: "admin", adminPass: "p" });
  const userRepo = new UserRepository(db);
  const notificationRepo = new NotificationRepository(db);
  const engagementRepo = new EngagementRepository(db, { notificationRepo });
  const user = userRepo.create({ username: "streak-hundred", passwordHash: "p" });
  db.run(
    "UPDATE users SET current_streak = 99, last_checkin_date = '2026-08-29' WHERE id = ?",
    [user.id]
  );

  const result = performCheckin(db, user.id, {
    now: new Date("2026-08-30T10:00:00.000Z"),
    notificationRepo,
    engagementRepo,
  });

  assert.equal(result.streak, 100);
  assert.equal(result.isMilestone, true);
  assert.equal(result.basePoints, 1);
  assert.equal(result.bonusPoints, 50);
  assert.equal(result.tierBonusPoints, 3);
  // +20 one-time and +30 podium (first member to reach day 100).
  assert.equal(result.achievementPoints, 50);
  assert.equal(result.pointsAwarded, 104);
  assert.equal(userRepo.findById(user.id).points_balance, 104);
  assert.equal(result.newBalance, 104);
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
