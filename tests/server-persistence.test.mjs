import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, unlinkSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { closeDb, initDb } from "../src/db.js";
import { hashPassword } from "../src/password.js";
import { QueueRepository } from "../src/repositories/queueRepository.js";
import { UserRepository } from "../src/repositories/userRepository.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function startServer(dataDir, options = {}) {
  const port = 46000 + Math.floor(Math.random() * 1000);
  const dbPath = path.join(dataDir, "jukebox.db");
  const child = spawn("bun", ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      JUKEBOX_DB_PATH: dbPath,
      JUKEBOX_DATA_DIR: dataDir,
      ADMIN_USERNAME: "review-admin",
      ADMIN_PASSWORD: "review-password-123",
      HOST_PASSWORD: "",
      TRUST_PROXY: options.trustProxy || "false",
      LLM_API_KEY: "",
      CHAT_AI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`${baseUrl}/api/info`);
      if (response.ok) return { child, baseUrl, output };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill("SIGTERM");
  throw new Error(`server did not start: ${output.join("")}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function loginAs(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie").split(";", 1)[0];
  return cookie;
}

async function login(baseUrl) {
  return loginAs(baseUrl, "review-admin", "review-password-123");
}

async function register(baseUrl, username) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "member-password-123", displayName: username }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  return cookie;
}

function openSocket(baseUrl, cookie, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(baseUrl.replace(/^http/, "ws"), { headers: { Cookie: cookie, ...headers } });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitForMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for WebSocket message")), 1500);
    const onMessage = (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

test("settings and feedback handlers report atomic persistence failures and rollback memory", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "office-jukebox-persist-"));
  mkdirSync(path.join(dataDir, "settings.json"));
  const { child, baseUrl } = await startServer(dataDir);
  try {
    const cookie = await login(baseUrl);
    const malformedDuration = await fetch(`${baseUrl}/api/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId: "W7rindfYUHk", duration: "00000000000000010:00x" }),
    });
    assert.equal(malformedDuration.status, 400);
    const oversizedReason = await fetch(`${baseUrl}/api/admin/users/admin_root/points`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ delta: 1, reason: "r".repeat(201) }),
    });
    assert.equal(oversizedReason.status, 400);
    const oversizedTitle = await fetch(`${baseUrl}/api/admin/point-drops`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ type: "claimable", points: 1, title: "t".repeat(201) }),
    });
    assert.equal(oversizedTitle.status, 400);
    const settingsFailure = await fetch(`${baseUrl}/api/feedback/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ on: false }),
    });
    assert.equal(settingsFailure.status, 500);
    const settingsPayload = await settingsFailure.json();
    assert.equal(settingsPayload.ok, false);

    const feedbackAfterRollback = await fetch(`${baseUrl}/api/feedback`, { headers: { Cookie: cookie } });
    assert.equal((await feedbackAfterRollback.json()).feedbackOn, true);

    const submit = await fetch(`${baseUrl}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Reviewer", content: "Keep this item" }),
    });
    assert.equal(submit.status, 200);
    const listed = await (await fetch(`${baseUrl}/api/feedback`, { headers: { Cookie: cookie } })).json();
    const item = listed.items.at(-1);
    unlinkSync(path.join(dataDir, "feedback.json"));
    mkdirSync(path.join(dataDir, "feedback.json"));
    const deletion = await fetch(`${baseUrl}/api/feedback/${item.id}`, { method: "DELETE", headers: { Cookie: cookie } });
    assert.equal(deletion.status, 500);
    const afterFailedDelete = await (await fetch(`${baseUrl}/api/feedback`, { headers: { Cookie: cookie } })).json();
    assert.ok(afterFailedDelete.items.some((entry) => entry.id === item.id));
  } finally {
    await stopServer(child);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("feedback submission reports a rename failure instead of claiming success", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "office-jukebox-feedback-"));
  mkdirSync(path.join(dataDir, "feedback.json"));
  const { child, baseUrl } = await startServer(dataDir);
  try {
    const response = await fetch(`${baseUrl}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Reviewer", content: "Persistence failure" }),
    });
    assert.equal(response.status, 500);
    assert.equal((await response.json()).ok, false);
    assert.equal(existsSync(path.join(dataDir, "feedback.json")), true);
  } finally {
    await stopServer(child);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("authenticated members can replace an avatar stored in the server data directory", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "office-jukebox-avatar-"));
  const { child, baseUrl } = await startServer(dataDir);
  try {
    const cookie = await register(baseUrl, "avatar_member");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const uploaded = await fetch(`${baseUrl}/api/me/avatar`, {
      method: "PUT",
      headers: { "Content-Type": "image/png", Cookie: cookie },
      body: png,
    });
    assert.equal(uploaded.status, 200);
    const first = await uploaded.json();
    assert.match(first.user.avatarUrl, /^\/avatars\/[0-9a-f-]+\.png$/);
    assert.deepEqual(Buffer.from(await (await fetch(`${baseUrl}${first.user.avatarUrl}`)).arrayBuffer()), png);

    const me = await (await fetch(`${baseUrl}/api/me`, { headers: { Cookie: cookie } })).json();
    assert.equal(me.user.avatarUrl, first.user.avatarUrl);

    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const replaced = await fetch(`${baseUrl}/api/me/avatar`, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg", Cookie: cookie },
      body: jpeg,
    });
    assert.equal(replaced.status, 200);
    const second = await replaced.json();
    assert.notEqual(second.user.avatarUrl, first.user.avatarUrl);
    assert.equal((await fetch(`${baseUrl}${first.user.avatarUrl}`)).status, 404);

    const avatarFiles = readFileSync(path.join(dataDir, "avatars", path.basename(second.user.avatarUrl)));
    assert.deepEqual(avatarFiles, jpeg);

    const rejected = await fetch(`${baseUrl}/api/me/avatar`, {
      method: "PUT",
      headers: { "Content-Type": "image/svg+xml", Cookie: cookie },
      body: "<svg></svg>",
    });
    assert.equal(rejected.status, 400);
  } finally {
    await stopServer(child);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("member chat exposes avatar URLs without leaking internal user IDs", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "office-jukebox-chat-avatar-"));
  const { child, baseUrl } = await startServer(dataDir);
  let socket;
  try {
    const cookie = await register(baseUrl, "chat_avatar_member");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const uploaded = await fetch(`${baseUrl}/api/me/avatar`, {
      method: "PUT",
      headers: { "Content-Type": "image/png", Cookie: cookie },
      body: png,
    });
    const avatarUrl = (await uploaded.json()).user.avatarUrl;

    socket = await openSocket(baseUrl, cookie);
    const liveMessage = waitForMessage(socket, (message) => message.type === "chatMessage");
    socket.send(JSON.stringify({
      type: "chatSend",
      name: "Chat Avatar Member",
      text: "Avatar payload check",
      clientId: "chat-avatar-client",
    }));
    const livePayload = (await liveMessage).message;
    assert.equal(livePayload.avatarUrl, avatarUrl);
    assert.equal("userId" in livePayload, false);
    assert.equal("avatar_file" in livePayload, false);

    const historyMessage = waitForMessage(socket, (message) => message.type === "chatHistory");
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const replaced = await fetch(`${baseUrl}/api/me/avatar`, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg", Cookie: cookie },
      body: jpeg,
    });
    const replacementUrl = (await replaced.json()).user.avatarUrl;
    const historyPayload = (await historyMessage).messages.find((message) => message.text === "Avatar payload check");
    assert.equal(historyPayload.avatarUrl, replacementUrl);
    assert.equal("userId" in historyPayload, false);
    assert.equal("avatar_file" in historyPayload, false);
  } finally {
    socket?.close();
    await stopServer(child);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("admin search mode is validated and persists across server restarts", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "office-jukebox-search-mode-"));
  let running = await startServer(dataDir);
  try {
    const cookie = await login(running.baseUrl);
    const initial = await (await fetch(`${running.baseUrl}/api/admin/search-settings`, { headers: { Cookie: cookie } })).json();
    assert.equal(initial.searchMode, "youtube-web");

    const invalid = await fetch(`${running.baseUrl}/api/admin/search-settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ searchMode: "unknown" }),
    });
    assert.equal(invalid.status, 400);

    const updated = await fetch(`${running.baseUrl}/api/admin/search-settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ searchMode: "youtube-music" }),
    });
    assert.equal(updated.status, 200);
  } finally {
    await stopServer(running.child);
  }

  running = await startServer(dataDir);
  try {
    const cookie = await login(running.baseUrl);
    const persisted = await (await fetch(`${running.baseUrl}/api/admin/search-settings`, { headers: { Cookie: cookie } })).json();
    assert.equal(persisted.searchMode, "youtube-music");
  } finally {
    await stopServer(running.child);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("admin can lock orders to the network registered by the authenticated host", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "office-jukebox-order-network-lock-"));
  const hostIp = "203.0.113.10";
  let running = await startServer(dataDir, { trustProxy: "1" });
  let hostSocket;
  let anonymousSocket;
  try {
    const headers = { "X-Forwarded-For": hostIp };
    anonymousSocket = await openSocket(running.baseUrl, "", headers);
    const denied = waitForMessage(anonymousSocket, (message) => message.type === "orderNetworkHostError");
    anonymousSocket.send(JSON.stringify({ type: "registerOrderNetworkHost" }));
    assert.match((await denied).reason, /xác thực trang Host/);

    const cookie = await login(running.baseUrl);
    hostSocket = await openSocket(running.baseUrl, cookie, headers);
    const hostUpdated = waitForMessage(hostSocket, (message) => message.type === "orderNetworkHostUpdated");
    hostSocket.send(JSON.stringify({ type: "registerOrderNetworkHost" }));
    await hostUpdated;

    const initial = await (await fetch(`${running.baseUrl}/api/admin/order-network-lock`, { headers: { Cookie: cookie, ...headers } })).json();
    assert.equal(initial.enabled, false);
    assert.equal(initial.hostIp, hostIp);

    const enabled = await fetch(`${running.baseUrl}/api/admin/order-network-lock`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie, ...headers },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(enabled.status, 200);

    const blocked = await fetch(`${running.baseUrl}/api/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.20" },
      body: JSON.stringify({ videoId: "not-video" }),
    });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).code, "ORDER_NETWORK_LOCKED");

    const allowedNetwork = await fetch(`${running.baseUrl}/api/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ videoId: "not-video" }),
    });
    assert.equal(allowedNetwork.status, 400);
  } finally {
    anonymousSocket?.close();
    hostSocket?.close();
    await stopServer(running.child);
  }

  running = await startServer(dataDir, { trustProxy: "1" });
  try {
    const cookie = await login(running.baseUrl);
    const persisted = await (await fetch(`${running.baseUrl}/api/admin/order-network-lock`, {
      headers: { Cookie: cookie, "X-Forwarded-For": hostIp },
    })).json();
    assert.equal(persisted.enabled, true);
    assert.equal(persisted.hostIp, hostIp);

    const disabled = await fetch(`${running.baseUrl}/api/admin/order-network-lock`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie, "X-Forwarded-For": hostIp },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disabled.status, 200);

    const reopened = await fetch(`${running.baseUrl}/api/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.20" },
      body: JSON.stringify({ videoId: "not-video" }),
    });
    assert.equal(reopened.status, 400);
  } finally {
    await stopServer(running.child);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("WebSocket settings failures do not broadcast unpersisted state", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "office-jukebox-ws-settings-"));
  mkdirSync(path.join(dataDir, "settings.json"));
  const { child, baseUrl } = await startServer(dataDir);
  let socket;
  try {
    const cookie = await login(baseUrl);
    socket = await openSocket(baseUrl, cookie);
    await waitForMessage(socket, (message) => message.type === "state");
    socket.send(JSON.stringify({ type: "setCooldown", seconds: 5 }));
    const error = await waitForMessage(socket, (message) => message.type === "error");
    assert.match(error.reason, /Không thể lưu cài đặt/);
    const messages = [];
    const onMessage = (raw) => { try { messages.push(JSON.parse(raw.toString())); } catch {} };
    socket.on("message", onMessage);
    await new Promise((resolve) => setTimeout(resolve, 200));
    socket.off("message", onMessage);
    assert.equal(messages.some((message) => message.type === "state" && message.cooldownSeconds === 5), false);
  } finally {
    socket?.close();
    await stopServer(child);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("successfully acknowledged feedback survives a server restart", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "office-jukebox-restart-"));
  let running = await startServer(dataDir);
  try {
    const response = await fetch(`${running.baseUrl}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Reviewer", content: "Survive restart" }),
    });
    assert.equal(response.status, 200);
    const cookie = await login(running.baseUrl);
    const listed = await (await fetch(`${running.baseUrl}/api/feedback`, { headers: { Cookie: cookie } })).json();
    const item = listed.items.at(-1);
    chmodSync(dataDir, 0o500);
    const failedDelete = await fetch(`${running.baseUrl}/api/feedback/${item.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    assert.equal(failedDelete.status, 500);
    chmodSync(dataDir, 0o700);
  } finally {
    try { chmodSync(dataDir, 0o700); } catch {}
    await stopServer(running.child);
  }
  running = await startServer(dataDir);
  try {
    const cookie = await login(running.baseUrl);
    const listed = await (await fetch(`${running.baseUrl}/api/feedback`, { headers: { Cookie: cookie } })).json();
    assert.ok(listed.items.some((entry) => entry.content === "Survive restart"));
  } finally {
    await stopServer(running.child);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("public rank benefits expose every check-in reward", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "office-jukebox-rank-benefits-"));
  const { child, baseUrl } = await startServer(dataDir);
  try {
    const response = await fetch(`${baseUrl}/api/rank/benefits`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.benefits.map((benefit) => benefit.checkinPoints), [1, 2, 3, 4, 5, 6]);
    assert.equal(Object.hasOwn(payload.benefits[0], "minXp"), true);
    assert.equal(Object.hasOwn(payload.benefits[0], "passwordHash"), false);
  } finally {
    await stopServer(child);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("public leaderboard is available without authentication and stays bounded", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "office-jukebox-leaderboard-"));
  const { child, baseUrl } = await startServer(dataDir);
  try {
    const response = await fetch(`${baseUrl}/api/rank/leaderboard?limit=200`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.ok(Array.isArray(payload.leaderboard));
    assert.ok(payload.leaderboard.length <= 10);
    assert.equal(Object.hasOwn(payload.leaderboard[0] || {}, "userId"), false);
  } finally {
    await stopServer(child);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("weekly music leaderboard is public while personal weekly standing requires authentication", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "office-jukebox-weekly-leaderboard-"));
  const { child, baseUrl } = await startServer(dataDir);
  try {
    const publicResponse = await fetch(`${baseUrl}/api/rank/weekly-leaderboard`);
    assert.equal(publicResponse.status, 200);
    const publicPayload = await publicResponse.json();
    assert.equal(publicPayload.ok, true);
    assert.equal(publicPayload.period.timezone, "Asia/Ho_Chi_Minh");
    assert.match(publicPayload.period.startDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(publicPayload.leaderboard, []);

    const cookie = await register(baseUrl, "weeklymember");
    const personalResponse = await fetch(`${baseUrl}/api/me/rank/weekly`, {
      headers: { Cookie: cookie },
    });
    assert.equal(personalResponse.status, 200);
    const personalPayload = await personalResponse.json();
    assert.equal(personalPayload.weeklyRank.position, null);
    assert.equal(personalPayload.weeklyRank.weeklyMusicXp, 0);
  } finally {
    await stopServer(child);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("public leaderboard page is available without authentication", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "office-jukebox-leaderboard-page-"));
  const { child, baseUrl } = await startServer(dataDir);
  try {
    const response = await fetch(`${baseUrl}/leaderboard`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<title>Bảng xếp hạng · Office Jukebox<\/title>/);
    assert.match(html, /leaderboard\.css\?v=/);
    assert.match(html, /leaderboard\.js\?v=/);
    assert.match(html, /id="leaderboard-podium"/);
  } finally {
    await stopServer(child);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("WebSocket owner skip responds without granting host control", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "office-jukebox-owner-skip-"));
  const { child, baseUrl } = await startServer(dataDir);
  let socket;
  try {
    socket = await openSocket(baseUrl);
    await waitForMessage(socket, (message) => message.type === "state");
    socket.send(JSON.stringify({ type: "skipOwn", id: "missing-item", clientId: "owner-client" }));
    const result = await waitForMessage(socket, (message) => message.type === "skipOwnResult");
    assert.equal(result.ok, false);
    assert.equal(result.id, "missing-item");
  } finally {
    socket?.close();
    await stopServer(child);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("authenticated owner can skip the exact current song without refund or XP", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "office-jukebox-owner-skip-auth-"));
  const dbPath = path.join(dataDir, "jukebox.db");
  let socket;
  let child;
  let baseUrl;
  let seedDb;
  let verifyDb;
  try {
    seedDb = initDb({ dbPath, adminUser: "review-admin", adminPass: "review-password-123" });
    const userRepo = new UserRepository(seedDb);
    const owner = userRepo.create({
      username: "skip_owner",
      passwordHash: hashPassword("owner-password-123"),
      displayName: "Skip Owner",
    });
    const voter = userRepo.create({ username: "skip_voter", passwordHash: hashPassword("voter-password-123") });
    userRepo.updatePoints(voter.id, 1, { type: "admin_adjustment", reason: "owner skip test" });
    const queueRepo = new QueueRepository(seedDb);
    const ownerSong = queueRepo.createItem({
      videoId: "owner-song-auth",
      title: "Owner song",
      duration: "3:30",
      addedBy: owner.display_name,
      requesterId: "owner-client",
      addedByUserId: owner.id,
    });
    const nextSong = queueRepo.createItem({
      videoId: "next-song-auth",
      title: "Next song",
      duration: "3:30",
      addedBy: "Another member",
      requesterId: "other-client",
    });
    queueRepo.addVote(ownerSong.id, voter.id);
    queueRepo.updateStatus(ownerSong.id, "playing", { startedAt: Date.now() - 1000 });
    closeDb(seedDb);
    seedDb = null;

    ({ child, baseUrl } = await startServer(dataDir));
    const ownerCookie = await loginAs(baseUrl, "skip_owner", "owner-password-123");
    socket = await openSocket(baseUrl, ownerCookie);
    const initial = await waitForMessage(socket, (message) => message.type === "state");
    assert.equal(initial.state.nowPlaying.id, ownerSong.id);

    socket.send(JSON.stringify({ type: "skipOwn", id: nextSong.id, clientId: "owner-client" }));
    const wrongItem = await waitForMessage(socket, (message) => message.type === "skipOwnResult");
    assert.equal(wrongItem.ok, false);

    const nextStatePromise = waitForMessage(
      socket,
      (message) => message.type === "state" && message.state?.nowPlaying?.id === nextSong.id
    );
    socket.send(JSON.stringify({ type: "skipOwn", id: ownerSong.id, clientId: "spoofed-client" }));
    const result = await waitForMessage(socket, (message) => message.type === "skipOwnResult");
    assert.equal(result.ok, true);
    assert.equal(result.id, ownerSong.id);
    const nextState = await nextStatePromise;
    assert.equal(nextState.state.nowPlaying.id, nextSong.id);

    socket.close();
    socket = null;
    await stopServer(child);
    child = null;

    verifyDb = initDb({ dbPath });
    const finished = verifyDb.query("SELECT status, finish_reason FROM queue_items WHERE id = ?").get(ownerSong.id);
    assert.equal(finished.status, "played");
    assert.equal(finished.finish_reason, "owner_skipped");
    assert.equal(verifyDb.query("SELECT points_balance FROM users WHERE id = ?").get(voter.id).points_balance, 0);
    assert.equal(verifyDb.query("SELECT COUNT(*) AS count FROM point_ledger WHERE type = 'vote_refund'").get().count, 0);
    assert.equal(verifyDb.query("SELECT COALESCE(SUM(delta_xp), 0) AS total FROM rank_activity_ledger WHERE user_id = ?").get(owner.id).total, 0);
    closeDb(verifyDb);
    verifyDb = null;
  } finally {
    socket?.close();
    if (child) await stopServer(child);
    try { closeDb(seedDb); } catch {}
    try { closeDb(verifyDb); } catch {}
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("admin notifications fan out to active users with unread/read controls", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "office-jukebox-notifications-"));
  const { child, baseUrl } = await startServer(dataDir);
  let memberSocket;
  try {
    const memberCookie = await register(baseUrl, "notification_member");
    const adminCookie = await login(baseUrl);
    memberSocket = await openSocket(baseUrl, memberCookie);
    await waitForMessage(memberSocket, (message) => message.type === "state");

    const unauthenticated = await fetch(`${baseUrl}/api/me/notifications`);
    assert.equal(unauthenticated.status, 401);

    const forbidden = await fetch(`${baseUrl}/api/admin/notifications`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: memberCookie },
      body: JSON.stringify({ title: "Không được gửi", body: "Không được gửi" }),
    });
    assert.equal(forbidden.status, 403);

    const invalid = await fetch(`${baseUrl}/api/admin/notifications`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ title: "", body: "Nội dung" }),
    });
    assert.equal(invalid.status, 400);

    const pushPromise = waitForMessage(memberSocket, (message) => message.type === "notificationCreated");
    const send = await fetch(`${baseUrl}/api/admin/notifications`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({
        title: "Bảo trì hệ thống",
        body: "Jukebox sẽ được cập nhật lúc 22:00.",
        kind: "maintenance",
      }),
    });
    assert.equal(send.status, 200);
    const sent = await send.json();
    assert.equal(sent.ok, true);
    assert.equal(sent.recipientCount, 2);
    const pushed = await pushPromise;
    assert.equal(pushed.notification.id, sent.notification.id);
    assert.equal(pushed.unreadCount, 1);

    const memberMe = await (await fetch(`${baseUrl}/api/me`, { headers: { Cookie: memberCookie } })).json();
    assert.equal(memberMe.user.unreadNotificationCount, 1);
    const list = await (await fetch(`${baseUrl}/api/me/notifications?limit=200`, { headers: { Cookie: memberCookie } })).json();
    assert.equal(list.total, 1);
    assert.equal(list.limit, 20);
    assert.equal(list.unreadCount, 1);
    assert.equal(list.items[0].read, false);

    const read = await fetch(`${baseUrl}/api/me/notifications/${encodeURIComponent(sent.notification.id)}/read`, {
      method: "POST",
      headers: { Cookie: memberCookie },
    });
    assert.equal(read.status, 200);
    assert.equal((await read.json()).unreadCount, 0);

    const second = await fetch(`${baseUrl}/api/admin/notifications`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ title: "Tính năng mới", body: "Đã cập nhật bảng xếp hạng.", kind: "feature" }),
    });
    assert.equal(second.status, 200);

    const readAll = await fetch(`${baseUrl}/api/me/notifications/read-all`, {
      method: "POST",
      headers: { Cookie: memberCookie },
    });
    assert.equal(readAll.status, 200);
    assert.equal((await readAll.json()).markedCount, 1);

    const adminHistory = await (await fetch(`${baseUrl}/api/admin/notifications?limit=100`, {
      headers: { Cookie: adminCookie },
    })).json();
    assert.equal(adminHistory.ok, true);
    assert.equal(adminHistory.limit, 20);
    assert.equal(adminHistory.total, 2);
    assert.equal(adminHistory.items.length, 2);
    assert.equal(adminHistory.items[1].recipientCount, 2);
    assert.equal(adminHistory.items[1].readCount, 1);
  } finally {
    memberSocket?.close();
    await stopServer(child);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("admin password reset replaces member credentials and revokes existing sessions", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "office-jukebox-password-reset-"));
  const { child, baseUrl } = await startServer(dataDir);
  try {
    const memberCookie = await register(baseUrl, "reset_member");
    const adminCookie = await login(baseUrl);
    const usersResponse = await fetch(`${baseUrl}/api/admin/users?search=reset_member`, {
      headers: { Cookie: adminCookie },
    });
    const usersPayload = await usersResponse.json();
    const member = usersPayload.users.find((user) => user.username === "reset_member");
    assert.ok(member);

    const forbidden = await fetch(`${baseUrl}/api/admin/users/${member.id}/reset-password`, {
      method: "POST",
      headers: { Cookie: memberCookie },
    });
    assert.equal(forbidden.status, 403);

    const reset = await fetch(`${baseUrl}/api/admin/users/${member.id}/reset-password`, {
      method: "POST",
      headers: { Cookie: adminCookie },
    });
    assert.equal(reset.status, 200);
    assert.match(reset.headers.get("cache-control") || "", /\bno-store\b/);
    const resetPayload = await reset.json();
    assert.equal(resetPayload.ok, true);
    assert.equal(resetPayload.user.id, member.id);
    assert.equal(resetPayload.user.username, "reset_member");
    assert.match(resetPayload.password, /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z\d]{12}$/);
    assert.equal(Object.hasOwn(resetPayload.user, "password_hash"), false);

    const oldSession = await (await fetch(`${baseUrl}/api/me`, {
      headers: { Cookie: memberCookie },
    })).json();
    assert.equal(oldSession.authenticated, false);

    const oldPassword = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "reset_member", password: "member-password-123" }),
    });
    assert.equal(oldPassword.status, 401);

    const newPassword = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "reset_member", password: resetPayload.password }),
    });
    assert.equal(newPassword.status, 200);
  } finally {
    await stopServer(child);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
