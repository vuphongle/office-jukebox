import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { initDb, closeDb } from "../src/db.js";
import { rankForXp, qualifiedPlayThreshold, isQualifiedPlay } from "../src/rank.js";
import { RankRepository } from "../src/repositories/rankRepository.js";
import { UserRepository } from "../src/repositories/userRepository.js";
import { JukeboxState } from "../src/state.js";

afterEach(() => closeDb());

test("rank helpers map cumulative XP and bounded skip threshold", () => {
  assert.equal(rankForXp(0).level, 1);
  assert.equal(rankForXp(300).name, "Tạo vibe");
  assert.equal(rankForXp(5_000).level, 6);
  assert.equal(qualifiedPlayThreshold("3:20"), 60);
  assert.equal(qualifiedPlayThreshold("10:00"), 90);
  assert.equal(qualifiedPlayThreshold("0:30"), 30);
  assert.equal(isQualifiedPlay({ finishReason: "ended", playedSeconds: 0, duration: "3:30" }), true);
  assert.equal(isQualifiedPlay({ finishReason: "skipped", playedSeconds: 29, duration: "3:30" }), false);
  assert.equal(isQualifiedPlay({ finishReason: "skipped", playedSeconds: 63, duration: "3:30" }), true);
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
