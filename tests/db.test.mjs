import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { initDb, closeDb } from "../src/db.js";
import { UserRepository } from "../src/repositories/userRepository.js";
import { SessionRepository } from "../src/repositories/sessionRepository.js";
import { LedgerRepository } from "../src/repositories/ledgerRepository.js";
import { QueueRepository } from "../src/repositories/queueRepository.js";
import { DropRepository } from "../src/repositories/dropRepository.js";

afterEach(() => closeDb());

test("Database does not create a predictable admin without explicit credentials", () => {
  const db = initDb({ dbPath: ":memory:", adminUser: "", adminPass: "" });
  const userRepo = new UserRepository(db);
  assert.equal(userRepo.findByUsername("admin"), null);
});

test("Database initialization and user repository CRUD", () => {
  const db = initDb({ dbPath: ":memory:", adminUser: "admin", adminPass: "test-admin-password" });
  const userRepo = new UserRepository(db);

  // Admin seeded
  const admin = userRepo.findByUsername("admin");
  assert.ok(admin);
  assert.equal(admin.role, "admin");

  // Create user
  const user1 = userRepo.create({ username: "alice", passwordHash: "salt:hash", displayName: "Alice Wonder" });
  assert.ok(user1.id);
  assert.equal(user1.username, "alice");
  assert.equal(user1.display_name, "Alice Wonder");
  assert.equal(user1.points_balance, 0);

  // Points update with ledger
  const res = userRepo.updatePoints(user1.id, 10, {
    type: "admin_adjustment",
    reason: "Thưởng khởi đầu",
  });
  assert.equal(res.points_balance, 10);
  assert.ok(res.ledgerId);

  // Cannot subtract more points than available (CHECK constraint & validation)
  assert.throws(() => {
    userRepo.updatePoints(user1.id, -20, { type: "admin_adjustment" });
  });

  // Block user
  const blocked = userRepo.updateStatus(user1.id, "blocked");
  assert.equal(blocked.status, "blocked");
});

test("Session repository operations", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const sessionRepo = new SessionRepository(db);

  const bob = userRepo.create({ username: "bob", passwordHash: "salt:hash" });
  const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

  sessionRepo.create(bob.id, "token-123", expiresAt);
  const session = sessionRepo.findValid("token-123");
  assert.ok(session);
  assert.equal(session.username, "bob");

  sessionRepo.delete("token-123");
  assert.equal(sessionRepo.findValid("token-123"), null);
});

test("Queue repository voting and refund transactions", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const queueRepo = new QueueRepository(db);

  const charlie = userRepo.create({ username: "charlie", passwordHash: "salt:hash" });
  userRepo.updatePoints(charlie.id, 5, { type: "admin_adjustment" });

  const song = queueRepo.createItem({ videoId: "v1", title: "Song 1", requesterId: "client-1" });
  assert.equal(song.vote_score, 0);

  // Vote
  const voteRes = queueRepo.addVote(song.id, charlie.id);
  assert.equal(voteRes.voteScore, 1);
  assert.equal(voteRes.newBalance, 4);

  // The same user can spend another point on the same song.
  const secondVoteRes = queueRepo.addVote(song.id, charlie.id);
  assert.equal(secondVoteRes.voteScore, 2);
  assert.equal(secondVoteRes.newBalance, 3);
  const storedVote = db
    .query("SELECT points_spent FROM queue_votes WHERE queue_item_id = ? AND user_id = ?")
    .get(song.id, charlie.id);
  assert.equal(storedVote.points_spent, 2);

  // Refund
  const refunded = queueRepo.refundVotes(song.id, "Test refund");
  assert.equal(refunded.length, 1);
  assert.equal(refunded[0].pointsRefunded, 2);
  assert.equal(refunded[0].newBalance, 5);

  const charlieAfter = userRepo.findById(charlie.id);
  assert.equal(charlieAfter.points_balance, 5);
});
