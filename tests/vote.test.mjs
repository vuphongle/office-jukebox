import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { initDb, closeDb } from "../src/db.js";
import { JukeboxState } from "../src/state.js";
import { UserRepository } from "../src/repositories/userRepository.js";

afterEach(() => closeDb());

test("Multi-tier queue sorting: pinned > vote_score > sequence", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const state = new JukeboxState(db);

  const u1 = userRepo.create({ username: "u1", passwordHash: "p" });
  userRepo.updatePoints(u1.id, 10, { type: "admin_adjustment" });

  // Add now playing + 3 upcoming songs
  state.add({ videoId: "playing", title: "Playing" });
  const s1 = state.add({ videoId: "song1", title: "Song 1" }).item;
  const s2 = state.add({ videoId: "song2", title: "Song 2" }).item;
  const s3 = state.add({ videoId: "song3", title: "Song 3" }).item;

  // Initial order: song1 (seq 2), song2 (seq 3), song3 (seq 4)
  assert.deepEqual(state.queue.map(q => q.id), [s1.id, s2.id, s3.id]);

  // Vote for song3 -> becomes top
  state.vote(s3.id, u1.id);
  assert.deepEqual(state.queue.map(q => q.id), [s3.id, s1.id, s2.id]);

  // Song2 reaches the same score later, so it stays behind song3 even though
  // it was added earlier.
  state.vote(s2.id, u1.id);
  assert.deepEqual(state.queue.map(q => q.id), [s3.id, s2.id, s1.id]);

  // The same user can spend another point. Song2 only moves ahead after its
  // score becomes strictly higher.
  state.vote(s2.id, u1.id);
  assert.deepEqual(state.queue.map(q => q.id), [s2.id, s3.id, s1.id]);

  // Host pins song1 by reordering it to top
  state.reorder(s1.id, s2.id);
  assert.deepEqual(state.queue.map(q => q.id), [s1.id, s2.id, s3.id]);
  assert.equal(state.queue[0].pinned, true);

  // Host unpins song1 -> returns to natural rank based on vote
  state.unpin(s1.id);
  assert.deepEqual(state.queue.map(q => q.id), [s2.id, s3.id, s1.id]);
  assert.equal(state.queue.find(q => q.id === s1.id).pinned, false);
});

test("Vote refund when host removes song", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const state = new JukeboxState(db);

  const u = userRepo.create({ username: "voter", passwordHash: "p" });
  userRepo.updatePoints(u.id, 5, { type: "admin_adjustment" });

  state.add({ videoId: "playing", title: "Playing" });
  const s1 = state.add({ videoId: "song1", title: "Song 1" }).item;

  state.vote(s1.id, u.id);
  state.vote(s1.id, u.id);
  assert.equal(userRepo.findById(u.id).points_balance, 3);
  assert.deepEqual(state.queueRepo.listActiveVoteItemIds(u.id), [s1.id]);

  // Host removes s1
  let balanceChange = null;
  state.onBalanceChange = (change) => { balanceChange = change; };
  state.remove(s1.id);
  // Points refunded 100%
  assert.equal(userRepo.findById(u.id).points_balance, 5);
  assert.deepEqual(state.queueRepo.listActiveVoteItemIds(u.id), []);
  assert.equal(balanceChange.userId, u.id);
  assert.equal(balanceChange.pointsRefunded, 2);
  assert.equal(balanceChange.newBalance, 5);
});

test("Vote refund when YouTube error occurs on playing song", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const state = new JukeboxState(db);

  const u = userRepo.create({ username: "voter2", passwordHash: "p" });
  userRepo.updatePoints(u.id, 5, { type: "admin_adjustment" });

  // Song 1 starts playing immediately
  const s1 = state.add({ videoId: "song1", title: "Song 1" }).item;
  const s2 = state.add({ videoId: "song2", title: "Song 2" }).item;

  // Vote for song 2
  state.vote(s2.id, u.id);
  assert.equal(userRepo.findById(u.id).points_balance, 4);

  // Advance to s2
  state.advance("song1");
  assert.equal(state.nowPlaying.id, s2.id);

  // s2 encounters error 101/150
  state.advance("song2", { isError: true });
  // Points refunded because playback failed
  assert.equal(userRepo.findById(u.id).points_balance, 5);
});
