import test from "node:test";
import assert from "node:assert/strict";
import { initDb, closeDb } from "../src/db.js";
import { hashPasswordAsync, verifyPasswordAsync } from "../src/auth.js";
import { UserRepository } from "../src/repositories/userRepository.js";
import { SessionRepository } from "../src/repositories/sessionRepository.js";
import { LedgerRepository } from "../src/repositories/ledgerRepository.js";
import { QueueRepository } from "../src/repositories/queueRepository.js";
import { JukeboxState } from "../src/state.js";

await import("../public/auth-utils.js");

test("Account profile repository updates display name without changing identity", () => {
  const db = initDb({ dbPath: ":memory:" });
  const users = new UserRepository(db);
  const user = users.create({ username: "profile_user", passwordHash: "hash", displayName: "Tên cũ" });

  const updated = users.updateDisplayName(user.id, "Tên mới");

  assert.equal(updated.display_name, "Tên mới");
  assert.equal(updated.username, "profile_user");
  assert.equal(updated.points_balance, 0);
  closeDb();
});

test("Password update supports rotating every previous session", async () => {
  const db = initDb({ dbPath: ":memory:" });
  const users = new UserRepository(db);
  const sessions = new SessionRepository(db);
  const oldHash = await hashPasswordAsync("old-password");
  const user = users.create({ username: "secure_user", passwordHash: oldHash });
  const firstSession = sessions.create(user.id);
  const secondSession = sessions.create(user.id);
  const nextHash = await hashPasswordAsync("new-password");

  const rotate = db.transaction(() => {
    users.updatePasswordHash(user.id, nextHash);
    sessions.deleteByUserId(user.id);
    sessions.create(user.id, "replacement-token");
  });
  rotate.immediate();

  assert.equal(sessions.findValid(firstSession.token), null);
  assert.equal(sessions.findValid(secondSession.token), null);
  assert.ok(sessions.findValid("replacement-token"));
  assert.equal(await verifyPasswordAsync("old-password", users.findById(user.id).password_hash), false);
  assert.equal(await verifyPasswordAsync("new-password", users.findById(user.id).password_hash), true);
  closeDb();
});

test("Point history filters and totals apply across the complete ledger", () => {
  const db = initDb({ dbPath: ":memory:" });
  const users = new UserRepository(db);
  const ledger = new LedgerRepository(db);
  const user = users.create({ username: "ledger_user", passwordHash: "hash" });

  users.updatePoints(user.id, 10, { type: "admin_adjustment", reason: "Tặng điểm" });
  users.updatePoints(user.id, -1, { type: "vote_spend", reason: "Vote bài A" });
  users.updatePoints(user.id, 3, { type: "vote_refund", reason: "Hoàn điểm" });

  assert.equal(ledger.listByUser(user.id, { direction: "all" }).total, 3);
  assert.deepEqual(ledger.listByUser(user.id, { direction: "earned" }).ledger.map((item) => item.delta).sort((a, b) => a - b), [3, 10]);
  assert.deepEqual(ledger.listByUser(user.id, { direction: "spent" }).ledger.map((item) => item.delta), [-1]);
  closeDb();
});

test("Active vote lookup returns only the signed-in user's queued votes", () => {
  const db = initDb({ dbPath: ":memory:" });
  const users = new UserRepository(db);
  const queue = new QueueRepository(db);
  const state = new JukeboxState(db);
  const firstUser = users.create({ username: "vote_owner", passwordHash: "hash" });
  const secondUser = users.create({ username: "other_voter", passwordHash: "hash" });
  users.updatePoints(firstUser.id, 3, { type: "admin_adjustment" });
  users.updatePoints(secondUser.id, 2, { type: "admin_adjustment" });

  state.add({ videoId: "playing", title: "Đang phát" });
  const firstSong = state.add({ videoId: "song-a", title: "Bài A" }).item;
  const secondSong = state.add({ videoId: "song-b", title: "Bài B" }).item;
  state.vote(firstSong.id, firstUser.id);
  state.vote(firstSong.id, firstUser.id);
  state.vote(secondSong.id, secondUser.id);

  assert.deepEqual(queue.listActiveVotesByUser(firstUser.id), [{ queue_item_id: firstSong.id, points_spent: 2 }]);
  assert.deepEqual(queue.listActiveVotesByUser(secondUser.id), [{ queue_item_id: secondSong.id, points_spent: 1 }]);
  closeDb();
});

test("Shared account form validation covers registration and password changes", () => {
  const auth = globalThis.JukeboxAuth;
  assert.equal(auth.validateRegistrationPassword("123456", ""), "Vui lòng nhập lại mật khẩu.");
  assert.equal(auth.validateRegistrationPassword("123456", "123457"), "Mật khẩu xác nhận chưa khớp.");
  assert.equal(auth.validateRegistrationPassword("123456", "123456"), "");
  assert.equal(auth.validateDisplayName("   "), "Vui lòng nhập tên hiển thị.");
  assert.deepEqual(auth.validatePasswordChange("old123", "old123", "old123"), {
    newPassword: "Mật khẩu mới phải khác mật khẩu hiện tại.",
  });
  assert.deepEqual(auth.validatePasswordChange("old123", "new123", "new123"), {});
});
