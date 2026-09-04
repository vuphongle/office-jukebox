import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { closeDb, initDb } from "../src/db.js";
import { RankRepository } from "../src/repositories/rankRepository.js";
import { UserRepository } from "../src/repositories/userRepository.js";

afterEach(() => closeDb());

test("public leaderboard returns the top ten active regular users without private fields", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const rankRepo = new RankRepository(db);
  const users = [
    ["Top User", 900],
    ["Alpha Tie", 500],
    ["Beta Tie", 500],
    ["Rank Three", 300],
    ["Rank Two", 100],
    ["User Six", 80],
    ["User Seven", 70],
    ["User Eight", 60],
    ["User Nine", 50],
    ["User Ten", 40],
    ["User Eleven", 30],
  ];
  const now = new Date().toISOString();

  for (const [displayName, xp] of users) {
    const user = userRepo.create({
      username: displayName.toLowerCase().replaceAll(" ", "-"),
      passwordHash: "p",
      displayName,
    });
    db.run(
      `INSERT INTO user_rank_profiles (user_id, xp_total, rank_level, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)`,
      [user.id, xp, now, now]
    );
  }

  const blocked = userRepo.create({ username: "blocked-user", passwordHash: "p", displayName: "Blocked User" });
  db.run(
    `INSERT INTO user_rank_profiles (user_id, xp_total, rank_level, created_at, updated_at)
     VALUES (?, 5000, 6, ?, ?)`,
    [blocked.id, now, now]
  );
  userRepo.updateStatus(blocked.id, "blocked");
  userRepo.create({ username: "admin-user", passwordHash: "p", displayName: "Admin User", role: "admin" });

  const rows = rankRepo.listPublicLeaderboard({ limit: 200 });

  assert.equal(rows.length, 10);
  assert.deepEqual(rows[0], {
    position: 1,
    displayName: "Top User",
    xpTotal: 900,
    rank: { level: 4, name: "DJ cộng đồng", badge: "turntable" },
  });
  assert.equal(rows[1].displayName, "Alpha Tie");
  assert.equal(rows[2].displayName, "Beta Tie");
  assert.equal(rows.some((row) => row.displayName === "Blocked User"), false);
  assert.equal(rows.some((row) => row.displayName === "Admin User"), false);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["displayName", "position", "rank", "xpTotal"]);
});
