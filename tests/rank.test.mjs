import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { initDb, closeDb } from "../src/db.js";
import { RANK_LEVELS, rankForXp, qualifiedPlayThreshold, isQualifiedPlay } from "../src/rank.js";
import { RankRepository } from "../src/repositories/rankRepository.js";
import { UserRepository } from "../src/repositories/userRepository.js";
import { JukeboxState } from "../src/state.js";

afterEach(() => closeDb());

test("rank helpers map cumulative XP and bounded skip threshold", () => {
  assert.equal(rankForXp(0).level, 1);
  assert.equal(rankForXp(300).name, "Tạo vibe");
  assert.equal(rankForXp(5_000).level, 7);
  assert.equal(qualifiedPlayThreshold("3:20"), 60);
  assert.equal(qualifiedPlayThreshold("10:00"), 90);
  assert.equal(qualifiedPlayThreshold("0:30"), 30);
  assert.equal(isQualifiedPlay({ finishReason: "ended", playedSeconds: 0, duration: "3:30" }), true);
  assert.equal(isQualifiedPlay({ finishReason: "skipped", playedSeconds: 29, duration: "3:30" }), false);
  assert.equal(isQualifiedPlay({ finishReason: "skipped", playedSeconds: 63, duration: "3:30" }), true);
  assert.equal(isQualifiedPlay({ finishReason: "owner_skipped", playedSeconds: 63, duration: "3:30" }), false);
});

test("rank descriptors expose the approved check-in reward", () => {
  const expected = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  assert.deepEqual(RANK_LEVELS.map((rank) => rank.checkinPoints), expected);
  assert.equal(rankForXp(300).checkinPoints, 3);
  assert.equal(rankForXp(3_000).checkinPoints, 6);
});

test("11-rank ladder has the approved names and XP thresholds", () => {
  assert.deepEqual(
    RANK_LEVELS.slice(5).map((rank) => [rank.level, rank.minXp, rank.name]),
    [
      [6, 3_000, "Biểu tượng âm nhạc"],
      [7, 5_000, "Phù thủy âm nhạc"],
      [8, 10_000, "Tượng đài âm nhạc"],
      [9, 15_000, "Chúa tể Jukebox"],
      [10, 20_000, "Huyền thoại Jukebox"],
      [11, 30_000, "Vị thần âm nhạc"],
    ]
  );
  // Levels 1-5 are untouched.
  assert.deepEqual(RANK_LEVELS.slice(0, 5).map((rank) => rank.minXp), [0, 100, 300, 700, 1_500]);
  assert.equal(new Set(RANK_LEVELS.map((rank) => rank.badge)).size, RANK_LEVELS.length);

  assert.equal(rankForXp(2_999).level, 5);
  assert.equal(rankForXp(4_999).level, 6);
  assert.equal(rankForXp(9_999).level, 7);
  assert.equal(rankForXp(14_999).level, 8);
  assert.equal(rankForXp(19_999).level, 9);
  assert.equal(rankForXp(29_999).level, 10);
  const top = rankForXp(30_000);
  assert.equal(top.level, 11);
  assert.equal(top.nextLevel, null);
  assert.equal(top.xpToNext, 0);
  assert.equal(rankForXp(1_000_000).level, 11);
});

test("former top-rank users keep level 6 and are only renamed, with no DB writes", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const rankRepo = new RankRepository(db);
  const legend = userRepo.create({ username: "former-legend", passwordHash: "p" });
  const overflow = userRepo.create({ username: "former-legend-overflow", passwordHash: "p" });
  rankRepo.ensureProfile(legend.id);
  rankRepo.ensureProfile(overflow.id);
  db.run("UPDATE user_rank_profiles SET xp_total = 3200, rank_level = 6 WHERE user_id = ?", [legend.id]);
  db.run("UPDATE user_rank_profiles SET xp_total = 6000, rank_level = 6 WHERE user_id = ?", [overflow.id]);
  const balanceBefore = userRepo.findById(legend.id).points_balance;
  const rowsBefore = db.query("SELECT * FROM user_rank_profiles ORDER BY user_id").all();

  const kept = rankRepo.getRank(legend.id);
  assert.equal(kept.rankLevel, 6);
  assert.equal(kept.rankName, "Biểu tượng âm nhạc");
  assert.equal(kept.checkinPoints, 6);
  // A user already past 5,000 XP is shown at the level their XP earns.
  assert.equal(rankRepo.getRank(overflow.id).rankLevel, 7);

  assert.equal(userRepo.findById(legend.id).points_balance, balanceBefore);
  assert.deepEqual(db.query("SELECT * FROM user_rank_profiles ORDER BY user_id").all(), rowsBefore);
});

test("new ranks reward crossing users once and never retroactively reward users already past them", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const rankRepo = new RankRepository(db);
  const crossing = userRepo.create({ username: "crossing-5000", passwordHash: "p" });
  const alreadyPast = userRepo.create({ username: "already-past-5000", passwordHash: "p" });
  rankRepo.ensureProfile(crossing.id);
  rankRepo.ensureProfile(alreadyPast.id);
  db.run("UPDATE user_rank_profiles SET xp_total = 4995, rank_level = 6 WHERE user_id = ?", [crossing.id]);
  db.run("UPDATE user_rank_profiles SET xp_total = 6000, rank_level = 6 WHERE user_id = ?", [alreadyPast.id]);

  const promoted = rankRepo.awardXp({ userId: crossing.id, activityType: "test", sourceId: "a", deltaXp: 10 });
  assert.equal(promoted.profile.rankLevel, 7);
  assert.equal(promoted.profile.rankName, "Phù thủy âm nhạc");
  // Level 7: +35 personal and +50 for the first member to reach it.
  assert.equal(promoted.pointsAwarded, 85);
  assert.equal(userRepo.findById(crossing.id).points_balance, 85);

  const quiet = rankRepo.awardXp({ userId: alreadyPast.id, activityType: "test", sourceId: "b", deltaXp: 10 });
  assert.equal(quiet.profile.rankLevel, 7);
  assert.equal(quiet.pointsAwarded, 0);
  assert.equal(userRepo.findById(alreadyPast.id).points_balance, 0);
  // The cached column simply catches up through the normal write path.
  assert.equal(db.query("SELECT rank_level FROM user_rank_profiles WHERE user_id = ?").get(alreadyPast.id).rank_level, 7);

  // Existing level-6 users earning XP below 5,000 get nothing extra.
  const steady = userRepo.create({ username: "steady-legend", passwordHash: "p" });
  rankRepo.ensureProfile(steady.id);
  db.run("UPDATE user_rank_profiles SET xp_total = 3500, rank_level = 6 WHERE user_id = ?", [steady.id]);
  const steadyResult = rankRepo.awardXp({ userId: steady.id, activityType: "test", sourceId: "c", deltaXp: 10 });
  assert.equal(steadyResult.pointsAwarded, 0);
  assert.equal(steadyResult.profile.rankLevel, 6);
});

test("rank XP awards are append-only and idempotent per activity source", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const rankRepo = new RankRepository(db);
  const user = userRepo.create({ username: "rank-user", passwordHash: "p" });

  const first = rankRepo.awardQualifiedPlay({
    userId: user.id,
    queueItemId: "queue-1",
    title: "A song",
  });
  assert.equal(first.awarded, true);
  assert.equal(first.deltaXp, 10);
  assert.equal(first.profile.xpTotal, 10);

  const retry = rankRepo.awardQualifiedPlay({
    userId: user.id,
    queueItemId: "queue-1",
    title: "A song",
  });
  assert.equal(retry.awarded, false);
  assert.equal(retry.profile.xpTotal, 10);
  assert.equal(rankRepo.listActivity(user.id).length, 1);

  rankRepo.awardVoteParticipation({ userId: user.id, queueItemId: "queue-1" });
  assert.equal(rankRepo.getRank(user.id).xpTotal, 12);
  assert.equal(rankRepo.listLeaderboard()[0].displayName, user.display_name);
});

test("rank profiles expose the current check-in reward", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const rankRepo = new RankRepository(db);
  const user = userRepo.create({ username: "rank-reward-user", passwordHash: "p" });

  rankRepo.ensureProfile(user.id);
  db.run("UPDATE user_rank_profiles SET xp_total = 300, rank_level = 3 WHERE user_id = ?", [user.id]);

  const profile = rankRepo.getRank(user.id);
  assert.equal(profile.rankLevel, 3);
  assert.equal(profile.checkinPoints, 3);
});

test("state transition persists finish reason, played seconds and voters", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const state = new JukeboxState(db);
  const voter = userRepo.create({ username: "rank-voter", passwordHash: "p" });
  userRepo.updatePoints(voter.id, 1, { type: "admin_adjustment" });

  const playing = state.add({ videoId: "playing-rank", title: "Playing", duration: "3:30" }).item;
  const queued = state.add({ videoId: "queued-rank", title: "Queued" }).item;
  state.vote(queued.id, voter.id);

  const firstTransition = state.advance(playing.videoId);
  assert.equal(firstTransition.voters.length, 0);

  const transition = state.advance(queued.videoId, {
    finishReason: "skipped",
    playedSeconds: 45,
  });

  assert.equal(transition.finishReason, "skipped");
  assert.equal(transition.playedSeconds, 45);
  assert.equal(transition.finishedItem.id, queued.id);
  assert.equal(transition.voters.length, 1);
  assert.equal(transition.voters[0].user_id, voter.id);

  const row = db.query("SELECT status, finish_reason, played_seconds FROM queue_items WHERE id = ?").get(queued.id);
  assert.equal(row.status, "played");
  assert.equal(row.finish_reason, "skipped");
  assert.equal(row.played_seconds, 45);
});

test("chat activity uses a damped per-window XP cap and ignores repeated spam", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const rankRepo = new RankRepository(db);
  const user = userRepo.create({ username: "chat-rank-user", passwordHash: "p" });
  const base = "2026-08-27T08:00:00.000Z";
  assert.equal(rankRepo.recordChatActivity({ userId: user.id, createdAt: base }).awardedXp, 0);
  assert.equal(rankRepo.recordChatActivity({ userId: user.id, createdAt: base, isSpam: true }).awardedXp, 0);
  const second = rankRepo.recordChatActivity({ userId: user.id, createdAt: base });
  assert.equal(second.awardedXp, 2);
  for (let i = 0; i < 40; i += 1) rankRepo.recordChatActivity({ userId: user.id, createdAt: base });
  assert.equal(rankRepo.db.query("SELECT xp_awarded FROM rank_chat_windows WHERE user_id = ?").get(user.id).xp_awarded, 8);
  const award = rankRepo.awardXp({ userId: user.id, activityType: "chat_window", sourceId: `${second.windowStart}:2`, deltaXp: second.awardedXp });
  assert.equal(award.awarded, true);
  assert.equal(rankRepo.getRank(user.id).xpTotal, 2);
});
