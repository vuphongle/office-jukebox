import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { closeDb, initDb } from "../src/db.js";
import { RankRepository } from "../src/repositories/rankRepository.js";
import { UserRepository } from "../src/repositories/userRepository.js";
import { getWeeklyPeriod } from "../src/weeklyRank.js";

afterEach(() => closeDb());

test("weekly period starts on Monday in the configured business timezone", () => {
  const sunday = getWeeklyPeriod({
    now: new Date("2026-09-20T16:59:59.000Z"),
    timezone: "Asia/Ho_Chi_Minh",
  });
  const monday = getWeeklyPeriod({
    now: new Date("2026-09-20T17:00:00.000Z"),
    timezone: "Asia/Ho_Chi_Minh",
  });

  assert.deepEqual(
    { startDate: sunday.startDate, endDate: sunday.endDate, startAt: sunday.startAt, endAt: sunday.endAt },
    {
      startDate: "2026-09-14",
      endDate: "2026-09-21",
      startAt: "2026-09-13T17:00:00.000Z",
      endAt: "2026-09-20T17:00:00.000Z",
    }
  );
  assert.equal(monday.startDate, "2026-09-21");
  assert.equal(monday.endDate, "2026-09-28");
});

test("weekly music leaderboard excludes chat XP and never uses lifetime XP as a tie-breaker", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const rankRepo = new RankRepository(db);
  const period = getWeeklyPeriod({
    now: new Date("2026-09-16T12:00:00.000Z"),
    timezone: "Asia/Ho_Chi_Minh",
  });
  const alice = userRepo.create({ username: "weekly-alice", passwordHash: "p", displayName: "Alice" });
  const bob = userRepo.create({ username: "weekly-bob", passwordHash: "p", displayName: "Bob" });
  const chatter = userRepo.create({ username: "weekly-chatter", passwordHash: "p", displayName: "Chatter" });
  const blocked = userRepo.create({ username: "weekly-blocked", passwordHash: "p", displayName: "Blocked" });
  const createdAt = "2026-09-15T03:00:00.000Z";

  for (const [user, xp] of [[alice, 12], [bob, 900], [chatter, 2_000], [blocked, 999]]) {
    db.run(
      `INSERT INTO user_rank_profiles (user_id, xp_total, rank_level, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)`,
      [user.id, xp, createdAt, createdAt]
    );
  }
  userRepo.updateStatus(blocked.id, "blocked");

  const addActivity = (userId, activityType, deltaXp, sourceId) => {
    db.run(
      `INSERT INTO rank_activity_ledger
       (id, user_id, event_id, activity_type, delta_xp, source_id, metadata_json, created_at)
       VALUES (?, ?, 'default_event', ?, ?, ?, '{}', ?)`,
      [`${userId}-${sourceId}`, userId, activityType, deltaXp, sourceId, createdAt]
    );
  };
  addActivity(alice.id, "qualified_play", 10, "play-1");
  addActivity(alice.id, "vote_participation", 2, "vote-1");
  for (let index = 0; index < 6; index += 1) addActivity(bob.id, "vote_participation", 2, `vote-${index}`);
  addActivity(chatter.id, "chat_window", 8, "chat-1");
  addActivity(blocked.id, "qualified_play", 10, "play-1");

  const leaderboard = rankRepo.listWeeklyMusicLeaderboard({ period, limit: 10 });

  assert.equal(leaderboard.length, 2);
  assert.deepEqual(leaderboard.map((row) => [row.displayName, row.weeklyMusicXp]), [
    ["Alice", 12],
    ["Bob", 12],
  ]);
  assert.equal(leaderboard[0].qualifiedPlayCount, 1);
  assert.equal(leaderboard[1].qualifiedPlayCount, 0);
  assert.equal(leaderboard[1].rank.level, 4);

  const aliceSummary = rankRepo.getWeeklyMusicSummary(alice.id, { period });
  assert.equal(aliceSummary.position, 1);
  assert.equal(aliceSummary.participantCount, 2);
  assert.equal(rankRepo.getWeeklyMusicSummary(chatter.id, { period }).position, null);
});
