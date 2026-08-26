import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, parseCookies } from "../src/auth.js";
import { initDb } from "../src/db.js";
import { performCheckin, calculateMilestoneBonus, getLocalDate } from "../src/checkin.js";
import { UserRepository } from "../src/repositories/userRepository.js";

test("Password hashing and constant-time verification", () => {
  const hash = hashPassword("secret123");
  assert.ok(hash.includes(":"));
  assert.equal(verifyPassword("secret123", hash), true);
  assert.equal(verifyPassword("wrongpass", hash), false);
  assert.equal(verifyPassword("", hash), false);
});

test("Cookie parsing helper", () => {
  const cookieHeader = "jukebox_session=abc123token; name=Test%20User; other=";
  const parsed = parseCookies(cookieHeader);
  assert.equal(parsed.jukebox_session, "abc123token");
  assert.equal(parsed.name, "Test User");
  assert.equal(parsed.other, "");
});

test("Milestone bonus calculation according to modulo 30 cycle", () => {
  assert.deepEqual(calculateMilestoneBonus(1), { bonus: 0, isMilestone: false, milestoneDay: 1 });
  assert.deepEqual(calculateMilestoneBonus(2), { bonus: 0, isMilestone: false, milestoneDay: 2 });
  assert.deepEqual(calculateMilestoneBonus(3), { bonus: 2, isMilestone: true, milestoneDay: 3 });
  assert.deepEqual(calculateMilestoneBonus(7), { bonus: 5, isMilestone: true, milestoneDay: 7 });
  assert.deepEqual(calculateMilestoneBonus(14), { bonus: 10, isMilestone: true, milestoneDay: 14 });
  assert.deepEqual(calculateMilestoneBonus(30), { bonus: 20, isMilestone: true, milestoneDay: 30 });
  // Day 33 -> cycleDay 3 -> +2 bonus
  assert.deepEqual(calculateMilestoneBonus(33), { bonus: 2, isMilestone: true, milestoneDay: 3 });
  // Day 60 -> cycleDay 30 -> +20 bonus
  assert.deepEqual(calculateMilestoneBonus(60), { bonus: 20, isMilestone: true, milestoneDay: 30 });
});

test("Daily check-in streak and idempotency", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const user = userRepo.create({ username: "miner", passwordHash: "pass" });

  // Day 1
  const day1 = new Date("2026-08-01T10:00:00Z");
  const res1 = performCheckin(db, user.id, { now: day1 });
  assert.equal(res1.ok, true);
  assert.equal(res1.alreadyCheckedIn, false);
  assert.equal(res1.streak, 1);
  assert.equal(res1.pointsAwarded, 1);
  assert.equal(res1.newBalance, 1);

  // Day 1 repeated (Idempotent)
  const res1Repeat = performCheckin(db, user.id, { now: day1 });
  assert.equal(res1Repeat.ok, true);
  assert.equal(res1Repeat.alreadyCheckedIn, true);
  assert.equal(res1Repeat.pointsAwarded, 0);
  assert.equal(res1Repeat.newBalance, 1);

  // Day 2 (Consecutive)
  const day2 = new Date("2026-08-02T10:00:00Z");
  const res2 = performCheckin(db, user.id, { now: day2 });
  assert.equal(res2.streak, 2);
  assert.equal(res2.pointsAwarded, 1);
  assert.equal(res2.newBalance, 2);

  // Day 3 (Consecutive with Milestone Bonus +2) -> total 3 points
  const day3 = new Date("2026-08-03T10:00:00Z");
  const res3 = performCheckin(db, user.id, { now: day3 });
  assert.equal(res3.streak, 3);
  assert.equal(res3.bonusPoints, 2);
  assert.equal(res3.pointsAwarded, 3);
  assert.equal(res3.newBalance, 5);
  assert.equal(res3.isMilestone, true);

  // Missed day -> Day 5 (Reset streak to 1)
  const day5 = new Date("2026-08-05T10:00:00Z");
  const res5 = performCheckin(db, user.id, { now: day5 });
  assert.equal(res5.streak, 1);
  assert.equal(res5.bonusPoints, 0);
  assert.equal(res5.pointsAwarded, 1);
  assert.equal(res5.newBalance, 6);
});
