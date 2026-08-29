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
