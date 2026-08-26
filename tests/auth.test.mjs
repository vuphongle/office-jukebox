import test from "node:test";
import assert from "node:assert/strict";
import { initDb, closeDb } from "../src/db.js";
import { UserRepository } from "../src/repositories/userRepository.js";
import { SessionRepository } from "../src/repositories/sessionRepository.js";
import {
  hashPassword,
  hashPasswordAsync,
  verifyPassword,
  verifyPasswordAsync,
  parseCookies,
  getSessionTokenFromCookieHeader,
  requireAdmin,
} from "../src/auth.js";
import { canUseHostControls, refreshSocketIdentity } from "../src/socketAuth.js";
import { unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB_PATH = path.join(__dirname, "test-auth.db");

test("Password hashing and verification with scrypt", () => {
  const plain = "SuperSecretPassword123!";
  const hash = hashPassword(plain);

  assert.ok(hash.includes(":"));
  assert.equal(verifyPassword(plain, hash), true);
  assert.equal(verifyPassword("WrongPassword", hash), false);
  assert.equal(verifyPassword("", hash), false);
});

test("Async password hashing keeps public auth work off the request thread", async () => {
  const hash = await hashPasswordAsync("AsyncSecret123!");
  assert.equal(await verifyPasswordAsync("AsyncSecret123!", hash), true);
  assert.equal(await verifyPasswordAsync("wrong", hash), false);
  assert.equal(await verifyPasswordAsync("anything", "invalid"), false);
});

test("Cookie parsing helper", () => {
  const header = "jukebox_session=abc12345; guestName=Phong; other=xyz";
  const cookies = parseCookies(header);
  assert.equal(cookies.jukebox_session, "abc12345");
  assert.equal(cookies.guestName, "Phong");
  assert.equal(cookies.other, "xyz");
  assert.equal(getSessionTokenFromCookieHeader(header), "abc12345");

  assert.deepEqual(parseCookies(""), {});
  assert.deepEqual(parseCookies(null), {});
});

test("Admin middleware requires an active admin session", () => {
  let statusCode = null;
  let payload = null;
  let nextCalled = false;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      payload = body;
      return this;
    },
  };

  requireAdmin({ user: null }, res, () => { nextCalled = true; });
  assert.equal(statusCode, 401);
  assert.equal(payload.ok, false);
  assert.equal(nextCalled, false);

  statusCode = null;
  payload = null;
  requireAdmin({ user: { role: "user", status: "active" } }, res, () => { nextCalled = true; });
  assert.equal(statusCode, 403);
  assert.equal(nextCalled, false);

  requireAdmin({ user: { role: "admin", status: "active" } }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("User registration, authentication and session lifecycle", () => {
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);

  const db = initDb({ dbPath: TEST_DB_PATH });
  const userRepo = new UserRepository(db);
  const sessionRepo = new SessionRepository(db);

  // 1. Create user
  const passwordHash = hashPassword("myPass123");
  const user = userRepo.create({
    username: "testuser",
    passwordHash,
    displayName: "Test User",
  });

  assert.ok(user.id);
  assert.equal(user.username, "testuser");
  assert.equal(user.display_name, "Test User");
  assert.equal(user.points_balance, 0);
  assert.equal(user.role, "user");
  assert.equal(user.status, "active");

  // Duplicate username should fail
  assert.throws(() => {
    userRepo.create({ username: "testuser", passwordHash });
  });

  // 2. Create session
  const session = sessionRepo.create(user.id);
  assert.ok(session.token);

  // 3. Find active session
  const activeUser = sessionRepo.findActiveUserByToken(session.token);
  assert.ok(activeUser);
  assert.equal(activeUser.id, user.id);
  assert.equal(activeUser.username, "testuser");

  // 4. Blocked user cannot authenticate
  userRepo.updateStatus(user.id, "blocked");
  const blockedAuth = sessionRepo.findActiveUserByToken(session.token);
  assert.equal(blockedAuth, null);

  // Unblock & create new session
  userRepo.updateStatus(user.id, "active");
  const newSession = sessionRepo.create(user.id);
  const unblockedAuth = sessionRepo.findActiveUserByToken(newSession.token);
  assert.ok(unblockedAuth);
  assert.equal(unblockedAuth.username, "testuser");

  // 5. Delete session (Logout)
  sessionRepo.deleteByToken(newSession.token);
  assert.equal(sessionRepo.findActiveUserByToken(newSession.token), null);

  closeDb();
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
});

test("WebSocket identity is revalidated after role and session changes", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const sessionRepo = new SessionRepository(db);
  const user = userRepo.create({ username: "socket-admin", passwordHash: "p", role: "admin" });
  const session = sessionRepo.create(user.id);
  const socket = { sessionToken: session.token, hostAuthenticated: false };

  let currentSession = refreshSocketIdentity(socket, sessionRepo);
  assert.equal(socket.isAdmin, true);
  assert.equal(canUseHostControls(socket, currentSession), true);

  userRepo.updateRole(user.id, "user");
  currentSession = refreshSocketIdentity(socket, sessionRepo);
  assert.equal(socket.isAdmin, false);
  assert.equal(canUseHostControls(socket, currentSession), false);

  userRepo.updateStatus(user.id, "blocked");
  assert.equal(refreshSocketIdentity(socket, sessionRepo), null);
  assert.equal(socket.userId, null);

  closeDb();
});
