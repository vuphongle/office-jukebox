import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, rmSync, unlinkSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function startServer(dataDir) {
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
      TRUST_PROXY: "false",
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

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "review-admin", password: "review-password-123" }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie").split(";", 1)[0];
  return cookie;
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

function openSocket(baseUrl, cookie) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(baseUrl.replace(/^http/, "ws"), { headers: { Cookie: cookie } });
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
