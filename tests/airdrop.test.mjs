import test from "node:test";
import assert from "node:assert/strict";
import { initDb } from "../src/db.js";
import { UserRepository } from "../src/repositories/userRepository.js";
import { DropRepository } from "../src/repositories/dropRepository.js";

test("Direct Airdrop to all active users", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const dropRepo = new DropRepository(db);

  const admin = userRepo.findByUsername("admin");
  const u1 = userRepo.create({ username: "u1", passwordHash: "p" });
  const u2 = userRepo.create({ username: "u2", passwordHash: "p" });
  const blocked = userRepo.create({ username: "blocked", passwordHash: "p" });
  userRepo.updateStatus(blocked.id, "blocked");

  const res = dropRepo.createDirectAirdrop({ points: 5, reason: "Opening gift", createdByUserId: admin.id });
  // admin, u1, u2 are active -> 3 users
  assert.equal(res.userCount, 3);

  assert.equal(userRepo.findById(u1.id).points_balance, 5);
  assert.equal(userRepo.findById(u2.id).points_balance, 5);
  assert.equal(userRepo.findById(blocked.id).points_balance, 0);
});

test("Claimable point drops (Non-stackable supersede and single-claim)", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const dropRepo = new DropRepository(db);

  const admin = userRepo.findByUsername("admin");
  const u1 = userRepo.create({ username: "u1", passwordHash: "p" });

  // Drop 1: 5 points
  const drop1 = dropRepo.createClaimableDrop({ title: "Drop 1", points: 5, createdByUserId: admin.id });
  assert.equal(drop1.status, "active");

  // User u1 claims drop 1
  const claimRes = dropRepo.claimDrop(drop1.id, u1.id);
  assert.equal(claimRes.pointsReceived, 5);
  assert.equal(claimRes.newBalance, 5);

  // User cannot claim drop 1 again
  assert.throws(() => {
    dropRepo.claimDrop(drop1.id, u1.id);
  });

  // Admin creates Drop 2: 10 points -> Drop 1 becomes superseded
  const drop2 = dropRepo.createClaimableDrop({ title: "Drop 2", points: 10, createdByUserId: admin.id });
  assert.equal(dropRepo.findDropById(drop1.id).status, "superseded");
  assert.equal(drop2.status, "active");

  // User u2 attempts to claim old Drop 1 -> should fail
  const u2 = userRepo.create({ username: "u2", passwordHash: "p" });
  assert.throws(() => {
    dropRepo.claimDrop(drop1.id, u2.id);
  });

  // User u2 claims new Drop 2 -> succeeds
  const claim2Res = dropRepo.claimDrop(drop2.id, u2.id);
  assert.equal(claim2Res.pointsReceived, 10);
  assert.equal(userRepo.findById(u2.id).points_balance, 10);
});
