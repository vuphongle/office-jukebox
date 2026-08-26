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

  // Vote for upcoming2 -> should become first in queue
  state1.vote(s2.id, u.id);

  assert.equal(state1.nowPlaying.videoId, "playing");
  assert.equal(state1.queue[0].videoId, "upcoming2");
  assert.equal(state1.queue[0].voteScore, 1);

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

  closeDb();
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
});
