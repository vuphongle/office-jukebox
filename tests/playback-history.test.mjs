import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { initDb, closeDb } from "../src/db.js";
import { QueueRepository } from "../src/repositories/queueRepository.js";
import { SessionRepository } from "../src/repositories/sessionRepository.js";
import { UserRepository } from "../src/repositories/userRepository.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

afterEach(() => closeDb());

test("Queue repository playback history returns paginated played songs in descending order", () => {
  const db = initDb({ dbPath: ":memory:" });
  const queueRepo = new QueueRepository(db);
  const user = new UserRepository(db).create({ username: "history-pages", passwordHash: "p" });

  // Insert 25 items and transition them to played status
  for (let i = 1; i <= 25; i++) {
    const item = queueRepo.createItem({
      videoId: `video_${i}`,
      title: `Bài hát số ${i}`,
      channel: `Ca sĩ ${i}`,
      duration: "3:45",
      thumbnail: `https://i.ytimg.com/vi/video_${i}/hqdefault.jpg`,
      addedBy: `Người chọn ${i}`,
      addedByUserId: user.id,
    });

    // Mark as played with spaced finished_at timestamps
    queueRepo.updateStatus(item.id, "playing", { startedAt: 1000 + i * 100 });
    queueRepo.updateStatus(item.id, "played", {
      finishedAt: 1000 + i * 100 + 50,
      finishReason: i % 5 === 0 ? "skipped" : "ended",
      playedSeconds: 200,
    });
  }

  // Page 1: limit 10, offset 0
  const page1 = queueRepo.getPlaybackHistory("default_event", user.id, { limit: 10, offset: 0 });
  assert.equal(page1.total, 25);
  assert.equal(page1.items.length, 10);
  assert.equal(page1.items[0].video_id, "video_25"); // Most recent first
  assert.equal(page1.items[9].video_id, "video_16");

  // Page 2: limit 10, offset 10
  const page2 = queueRepo.getPlaybackHistory("default_event", user.id, { limit: 10, offset: 10 });
  assert.equal(page2.total, 25);
  assert.equal(page2.items.length, 10);
  assert.equal(page2.items[0].video_id, "video_15");
  assert.equal(page2.items[9].video_id, "video_6");

  // Page 3: limit 10, offset 20 (only 5 items remaining)
  const page3 = queueRepo.getPlaybackHistory("default_event", user.id, { limit: 10, offset: 20 });
  assert.equal(page3.total, 25);
  assert.equal(page3.items.length, 5);
  assert.equal(page3.items[0].video_id, "video_5");
  assert.equal(page3.items[4].video_id, "video_1");

  // Verify item properties
  const sample = page1.items[0];
  assert.equal(sample.title, "Bài hát số 25");
  assert.equal(sample.channel, "Ca sĩ 25");
  assert.equal(sample.thumbnail, "https://i.ytimg.com/vi/video_25/hqdefault.jpg");
  assert.equal(sample.finish_reason, "skipped");
});

test("Queue repository playback history uses insertion order for identical finish times", () => {
  const db = initDb({ dbPath: ":memory:" });
  const queueRepo = new QueueRepository(db);
  const user = new UserRepository(db).create({ username: "history-order", passwordHash: "p" });

  for (let i = 1; i <= 3; i++) {
    const item = queueRepo.createItem({
      videoId: `same_time_${i}`,
      title: `Cùng thời điểm ${i}`,
      channel: "Ca sĩ",
      duration: "3:00",
      thumbnail: null,
      addedBy: "Người chọn",
      addedByUserId: user.id,
    });
    queueRepo.updateStatus(item.id, "playing", { startedAt: 3000 });
    queueRepo.updateStatus(item.id, "played", {
      finishedAt: 3060,
      finishReason: "ended",
      playedSeconds: 180,
    });
  }

  const history = queueRepo.getPlaybackHistory("default_event", user.id, { limit: 3 });
  assert.deepEqual(
    history.items.map((item) => item.video_id),
    ["same_time_3", "same_time_2", "same_time_1"]
  );
});

test("Queue repository playback history only returns songs added by the requested user", () => {
  const db = initDb({ dbPath: ":memory:" });
  const queueRepo = new QueueRepository(db);
  const userRepo = new UserRepository(db);
  const currentUser = userRepo.create({ username: "history-owner", passwordHash: "p" });
  const otherUser = userRepo.create({ username: "history-other", passwordHash: "p" });

  const addPlayedItem = ({ videoId, addedByUserId, finishedAt }) => {
    const item = queueRepo.createItem({
      videoId,
      title: videoId,
      channel: "Ca si",
      duration: "3:00",
      thumbnail: null,
      addedBy: "Nguoi chon",
      addedByUserId,
    });
    queueRepo.updateStatus(item.id, "playing", { startedAt: finishedAt - 180 });
    queueRepo.updateStatus(item.id, "played", { finishedAt, finishReason: "ended", playedSeconds: 180 });
  };

  addPlayedItem({ videoId: "mine_old", addedByUserId: currentUser.id, finishedAt: 1000 });
  addPlayedItem({ videoId: "other", addedByUserId: otherUser.id, finishedAt: 2000 });
  addPlayedItem({ videoId: "anonymous", addedByUserId: null, finishedAt: 3000 });
  addPlayedItem({ videoId: "mine_new", addedByUserId: currentUser.id, finishedAt: 4000 });

  const history = queueRepo.getPlaybackHistory("default_event", currentUser.id, { limit: 10 });

  assert.equal(history.total, 2);
  assert.deepEqual(history.items.map((item) => item.video_id), ["mine_new", "mine_old"]);
});

test("History controller defers a reset requested during an in-flight page load", () => {
  const source = readFileSync(path.join(ROOT, "public/history-controller.js"), "utf8");
  const context = { window: {} };
  vm.runInNewContext(source, context);

  const controller = context.window.JukeboxHistoryController.create();
  assert.equal(controller.begin(), true);
  assert.equal(controller.begin(true), false);
  assert.equal(controller.refreshPending, true);
  assert.equal(controller.finish(), true);
  assert.equal(controller.refreshPending, true);
  assert.equal(controller.begin(true), true);
  assert.equal(controller.refreshPending, false);
  assert.equal(controller.finish(), false);
  controller.requestReset();
  assert.equal(controller.refreshPending, true);
});

test("History controller invalidates loaded data when the signed-in user changes", () => {
  const source = readFileSync(path.join(ROOT, "public/history-controller.js"), "utf8");
  const context = { window: {} };
  vm.runInNewContext(source, context);

  const controller = context.window.JukeboxHistoryController.create();
  assert.equal(controller.emptyReason, "authentication-required");
  assert.equal(controller.setIdentity("user-a"), true);
  assert.equal(controller.refreshPending, true);
  assert.equal(controller.emptyReason, "no-history");
  assert.equal(controller.isIdentityCurrent("user-a"), true);

  assert.equal(controller.begin(true), true);
  assert.equal(controller.finish(), false);
  assert.equal(controller.setIdentity("user-a"), false);
  assert.equal(controller.setIdentity("user-b"), true);
  assert.equal(controller.isIdentityCurrent("user-a"), false);
  assert.equal(controller.isIdentityCurrent("user-b"), true);

  assert.equal(controller.setIdentity(null), true);
  assert.equal(controller.emptyReason, "authentication-required");
});

test("GET /api/history requires authentication and returns only the current user's songs", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "jukebox-history-test-"));
  const dbPath = path.join(dataDir, "jukebox.db");

  // Pre-populate db with history items
  const db = initDb({ dbPath });
  const queueRepo = new QueueRepository(db);
  const userRepo = new UserRepository(db);
  const sessionRepo = new SessionRepository(db);
  const currentUser = userRepo.create({ username: "history-http", passwordHash: "p" });
  const otherUser = userRepo.create({ username: "history-http-other", passwordHash: "p" });
  const session = sessionRepo.create(currentUser.id, "history-http-session");
  for (let i = 1; i <= 15; i++) {
    const item = queueRepo.createItem({
      videoId: `yt_${i}`,
      title: `Song ${i}`,
      channel: `Artist ${i}`,
      duration: "4:00",
      thumbnail: `https://i.ytimg.com/vi/yt_${i}/hqdefault.jpg`,
      addedBy: `User ${i}`,
      addedByUserId: currentUser.id,
    });
    queueRepo.updateStatus(item.id, "playing", { startedAt: 2000 + i * 100 });
    queueRepo.updateStatus(item.id, "played", {
      finishedAt: 2000 + i * 100 + 60,
      finishReason: "ended",
      playedSeconds: 240,
    });
  }
  const otherItem = queueRepo.createItem({
    videoId: "yt_other",
    title: "Other user's song",
    channel: "Other artist",
    duration: "4:00",
    thumbnail: null,
    addedBy: "Other user",
    addedByUserId: otherUser.id,
  });
  queueRepo.updateStatus(otherItem.id, "playing", { startedAt: 5000 });
  queueRepo.updateStatus(otherItem.id, "played", { finishedAt: 6000, finishReason: "ended", playedSeconds: 240 });
  closeDb();

  const port = 47000 + Math.floor(Math.random() * 1000);
  const child = spawn("bun", ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      JUKEBOX_DB_PATH: dbPath,
      JUKEBOX_DATA_DIR: dataDir,
      HOST_PASSWORD: "",
      TRUST_PROXY: "false",
      LLM_API_KEY: "",
      CHAT_AI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${baseUrl}/api/info`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(ready, "Server failed to start");

  try {
    for (const route of ["/api/points", "/api/points/add"]) {
      const pointsRes = await fetch(`${baseUrl}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "attacker", points: 100 }),
      });
      assert.equal(pointsRes.status, 404);
    }

    const anonymousHistory = await fetch(`${baseUrl}/api/history?page=1&limit=10`);
    assert.equal(anonymousHistory.status, 401);

    const historyHeaders = { cookie: `jukebox_session=${session.token}` };

    // Fetch page 1
    const res1 = await fetch(`${baseUrl}/api/history?page=1&limit=10`, { headers: historyHeaders });
    assert.equal(res1.status, 200);
    const data1 = await res1.json();
    assert.equal(data1.ok, true);
    assert.equal(data1.total, 15);
    assert.equal(data1.page, 1);
    assert.equal(data1.limit, 10);
    assert.equal(data1.hasMore, true);
    assert.equal(data1.items.length, 10);
    assert.equal(data1.items[0].videoId, "yt_15");
    assert.equal(data1.items[0].thumbnail, "https://i.ytimg.com/vi/yt_15/hqdefault.jpg");

    // Fetch page 2
    const res2 = await fetch(`${baseUrl}/api/history?page=2&limit=10`, { headers: historyHeaders });
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.equal(data2.ok, true);
    assert.equal(data2.total, 15);
    assert.equal(data2.page, 2);
    assert.equal(data2.hasMore, false);
    assert.equal(data2.items.length, 5);
    assert.equal(data2.items[0].videoId, "yt_5");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
