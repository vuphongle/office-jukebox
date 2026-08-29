import test from "node:test";
import assert from "node:assert/strict";
import { initDb, closeDb } from "../src/db.js";
import { JukeboxState } from "../src/state.js";
import { UserRepository } from "../src/repositories/userRepository.js";
import { unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB_PATH = path.join(__dirname, "test-persistence.db");

test("State persistence across server reboots", () => {
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);

  // First boot
  const db1 = initDb({ dbPath: TEST_DB_PATH });
  const userRepo1 = new UserRepository(db1);
  const state1 = new JukeboxState(db1);

  const u = userRepo1.create({ username: "saver", passwordHash: "p" });
  userRepo1.updatePoints(u.id, 10, { type: "admin_adjustment" });

  state1.add({ videoId: "playing", title: "Playing Track" });
  const s1 = state1.add({ videoId: "upcoming1", title: "Upcoming 1" }).item;
  const s2 = state1.add({ videoId: "upcoming2", title: "Upcoming 2" }).item;

  // upcoming2 reaches score 1 first and moves to the top.
  state1.vote(s2.id, u.id);
  // upcoming1 reaches the same score later. It must stay behind upcoming2
  // despite having an earlier queue_sequence.
  state1.vote(s1.id, u.id);

  assert.equal(state1.nowPlaying.videoId, "playing");
  assert.equal(state1.queue[0].videoId, "upcoming2");
  assert.equal(state1.queue[0].voteScore, 1);
  assert.equal(state1.queue[1].videoId, "upcoming1");
  assert.equal(state1.queue[1].voteScore, 1);

  closeDb();

  // Second boot (simulate restart)
  const db2 = initDb({ dbPath: TEST_DB_PATH });
  const state2 = new JukeboxState(db2);

  assert.ok(state2.nowPlaying);
  assert.equal(state2.nowPlaying.videoId, "playing");
  assert.equal(state2.queue.length, 2);
  assert.equal(state2.queue[0].videoId, "upcoming2");
  assert.equal(state2.queue[0].voteScore, 1);
  assert.equal(state2.queue[1].videoId, "upcoming1");
  assert.equal(state2.queue[1].voteScore, 1);

  closeDb();
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
});

test("Host drag order remains identical after SQLite reload", () => {
  const dragDbPath = path.join(__dirname, "test-drag-persistence.db");
  if (existsSync(dragDbPath)) unlinkSync(dragDbPath);

  const db1 = initDb({ dbPath: dragDbPath });
  const state1 = new JukeboxState(db1);
  const userRepo = new UserRepository(db1);
  const voter = userRepo.create({ username: "drag-voter", passwordHash: "p" });
  userRepo.updatePoints(voter.id, 2, { type: "admin_adjustment" });
  state1.add({ videoId: "playing-drag", title: "Playing" });
  const first = state1.add({ videoId: "first", title: "First" }).item;
  state1.add({ videoId: "second", title: "Second" });
  state1.add({ videoId: "third", title: "Third" });

  state1.move(first.id, "down");
  const beforeRestart = state1.queue.map((item) => item.videoId);
  assert.deepEqual(beforeRestart, ["second", "first", "third"]);
  assert.deepEqual(state1.queue.map((item) => item.pinned), [true, true, false]);
  state1.vote(state1.queue[2].id, voter.id);
  assert.deepEqual(state1.queue.map((item) => item.videoId), beforeRestart);
  closeDb();

  const db2 = initDb({ dbPath: dragDbPath });
  const state2 = new JukeboxState(db2);
  assert.deepEqual(state2.queue.map((item) => item.videoId), beforeRestart);
  assert.deepEqual(state2.queue.map((item) => item.pinned), [true, true, false]);

  closeDb();
  if (existsSync(dragDbPath)) unlinkSync(dragDbPath);
});

test("Move and reorder leave memory unchanged when SQLite persistence fails", () => {
  const failureDbPath = path.join(__dirname, "test-order-failure.db");
  if (existsSync(failureDbPath)) unlinkSync(failureDbPath);

  const db = initDb({ dbPath: failureDbPath });
  const state = new JukeboxState(db);
  state.add({ videoId: "playing-failure", title: "Playing" });
  const first = state.add({ videoId: "first-failure", title: "First" }).item;
  const second = state.add({ videoId: "second-failure", title: "Second" }).item;
  const third = state.add({ videoId: "third-failure", title: "Third" }).item;
  const before = state.queue.map((item) => ({ id: item.id, pinned: item.pinned, pinnedOrder: item.pinnedOrder }));
  db.run(`CREATE TRIGGER fail_queue_order BEFORE UPDATE OF pinned ON queue_items
          BEGIN SELECT RAISE(ABORT, 'injected queue persistence failure'); END`);

  assert.throws(() => state.move(first.id, "down"), /injected queue persistence failure/);
  assert.deepEqual(state.queue.map((item) => ({ id: item.id, pinned: item.pinned, pinnedOrder: item.pinnedOrder })), before);
  assert.throws(() => state.reorder(third.id, second.id), /injected queue persistence failure/);
  assert.deepEqual(state.queue.map((item) => ({ id: item.id, pinned: item.pinned, pinnedOrder: item.pinnedOrder })), before);

  const persisted = db.query("SELECT id, pinned, pinned_order FROM queue_items WHERE status = 'queued' ORDER BY queue_sequence").all();
  assert.deepEqual(persisted.map((row) => ({ id: row.id, pinned: row.pinned === 1, pinnedOrder: row.pinned_order })), before);
  db.run("DROP TRIGGER fail_queue_order");
  closeDb();
  if (existsSync(failureDbPath)) unlinkSync(failureDbPath);
});
