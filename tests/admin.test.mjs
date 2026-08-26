import test from "node:test";
import assert from "node:assert/strict";
import { initDb, closeDb } from "../src/db.js";
import { UserRepository } from "../src/repositories/userRepository.js";
import { LedgerRepository } from "../src/repositories/ledgerRepository.js";
import { DropRepository } from "../src/repositories/dropRepository.js";
import { unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB_PATH = path.join(__dirname, "test-admin.db");

test("Admin User Management & Direct Points Adjustment", () => {
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);

  const db = initDb({ dbPath: TEST_DB_PATH, adminUser: "admin", adminPass: "test-admin-password" });
  const userRepo = new UserRepository(db);
  const ledgerRepo = new LedgerRepository(db);

  const u1 = userRepo.create({ username: "member1", passwordHash: "h1", displayName: "Member One" });
  const u2 = userRepo.create({ username: "member2", passwordHash: "h2", displayName: "Member Two" });

  // Add points
  const updated1 = userRepo.updatePoints(u1.id, 50, {
    type: "admin_adjustment",
    reason: "Thưởng đóng góp",
  });
  assert.equal(updated1.points_balance, 50);

  // Subtract points
  const updated2 = userRepo.updatePoints(u1.id, -20, {
    type: "admin_adjustment",
    reason: "Khấu trừ",
  });
  assert.equal(updated2.points_balance, 30);

  // Insufficient points subtraction should throw
  assert.throws(() => {
    userRepo.updatePoints(u1.id, -100, { type: "admin_adjustment" });
  });

  // Verify Ledger Audit
  const userLedger = ledgerRepo.findByUserId(u1.id);
  assert.equal(userLedger.length, 2);
  assert.equal(userLedger[0].delta, -20);
  assert.equal(userLedger[1].delta, 50);

  // Toggle user status
  userRepo.updateStatus(u2.id, "blocked");
  const fetchedU2 = userRepo.findById(u2.id);
  assert.equal(fetchedU2.status, "blocked");

  closeDb();
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
  if (existsSync(`${TEST_DB_PATH}-wal`)) unlinkSync(`${TEST_DB_PATH}-wal`);
  if (existsSync(`${TEST_DB_PATH}-shm`)) unlinkSync(`${TEST_DB_PATH}-shm`);
});

test("Admin Direct Airdrop & Claimable Point Drops", () => {
  const TEST_DB_PATH_2 = path.join(__dirname, "test-admin-drop.db");
  if (existsSync(TEST_DB_PATH_2)) unlinkSync(TEST_DB_PATH_2);

  const db = initDb({ dbPath: TEST_DB_PATH_2, adminUser: "admin", adminPass: "test-admin-password" });
  const userRepo = new UserRepository(db);
  const dropRepo = new DropRepository(db);

  const admin = userRepo.findByUsername("admin");
  const u1 = userRepo.create({ username: "user_a", passwordHash: "h" });
  const u2 = userRepo.create({ username: "user_b", passwordHash: "h" });

  // 1. Direct Airdrop: 15 points to all active users
  const directResult = dropRepo.createDirectAirdrop({
    points: 15,
    title: "Khai mạc event",
    createdBy: admin.id,
  });

  assert.equal(directResult.userCount, 3); // admin, user_a, user_b

  const u1After = userRepo.findById(u1.id);
  const u2After = userRepo.findById(u2.id);
  assert.equal(u1After.points_balance, 15);
  assert.equal(u2After.points_balance, 15);

  // 2. Claimable Point Drop
  const drop1 = dropRepo.createClaimableDrop({
    points: 10,
    title: "Quà tặng 1",
    createdBy: admin.id,
  });

  assert.equal(drop1.status, "active");
  assert.equal(drop1.points, 10);

  // User A claims drop 1
  const claim1 = dropRepo.claimDrop({
    dropId: drop1.id,
    userId: u1.id,
  });
  assert.equal(claim1.pointsClaimed, 10);
  assert.equal(claim1.newBalance, 25);

  // User A claiming again should throw / fail
  assert.throws(() => {
    dropRepo.claimDrop({ dropId: drop1.id, userId: u1.id });
  });

  // Create Drop 2 -> Drop 1 should be superseded
  const drop2 = dropRepo.createClaimableDrop({
    points: 20,
    title: "Quà tặng 2",
    createdBy: admin.id,
  });

  const activeDrop = dropRepo.findActiveClaimable();
  assert.equal(activeDrop.id, drop2.id);

  const oldDrop1 = dropRepo.findById(drop1.id);
  assert.equal(oldDrop1.status, "superseded");

  // User B cannot claim old superseded drop
  assert.throws(() => {
    dropRepo.claimDrop({ dropId: drop1.id, userId: u2.id });
  });

  // User B claims drop 2
  const claim2 = dropRepo.claimDrop({ dropId: drop2.id, userId: u2.id });
  assert.equal(claim2.pointsClaimed, 20);
  assert.equal(claim2.newBalance, 35);

  closeDb();
  if (existsSync(TEST_DB_PATH_2)) unlinkSync(TEST_DB_PATH_2);
  if (existsSync(`${TEST_DB_PATH_2}-wal`)) unlinkSync(`${TEST_DB_PATH_2}-wal`);
  if (existsSync(`${TEST_DB_PATH_2}-shm`)) unlinkSync(`${TEST_DB_PATH_2}-shm`);
});
