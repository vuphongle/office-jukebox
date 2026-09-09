import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initDb, closeDb } from "../src/db.js";
import { QueueRepository } from "../src/repositories/queueRepository.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

afterEach(() => closeDb());

test("Queue repository playback history returns paginated played songs in descending order", () => {
  const db = initDb({ dbPath: ":memory:" });
  const queueRepo = new QueueRepository(db);

  // Insert 25 items and transition them to played status
  for (let i = 1; i <= 25; i++) {
    const item = queueRepo.createItem({
      videoId: `video_${i}`,
      title: `Bài hát số ${i}`,
      channel: `Ca sĩ ${i}`,
      duration: "3:45",
      thumbnail: `https://i.ytimg.com/vi/video_${i}/hqdefault.jpg`,
      addedBy: `Người chọn ${i}`,
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
  const page1 = queueRepo.getPlaybackHistory("default_event", { limit: 10, offset: 0 });
  assert.equal(page1.total, 25);
  assert.equal(page1.items.length, 10);
  assert.equal(page1.items[0].video_id, "video_25"); // Most recent first
  assert.equal(page1.items[9].video_id, "video_16");

  // Page 2: limit 10, offset 10
  const page2 = queueRepo.getPlaybackHistory("default_event", { limit: 10, offset: 10 });
  assert.equal(page2.total, 25);
  assert.equal(page2.items.length, 10);
  assert.equal(page2.items[0].video_id, "video_15");
  assert.equal(page2.items[9].video_id, "video_6");

  // Page 3: limit 10, offset 20 (only 5 items remaining)
  const page3 = queueRepo.getPlaybackHistory("default_event", { limit: 10, offset: 20 });
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

test("GET /api/history returns sanitized paginated history over HTTP", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "jukebox-history-test-"));
  const dbPath = path.join(dataDir, "jukebox.db");

  // Pre-populate db with history items
  const db = initDb({ dbPath });
  const queueRepo = new QueueRepository(db);
  for (let i = 1; i <= 15; i++) {
    const item = queueRepo.createItem({
      videoId: `yt_${i}`,
      title: `Song ${i}`,
      channel: `Artist ${i}`,
      duration: "4:00",
      thumbnail: `https://i.ytimg.com/vi/yt_${i}/hqdefault.jpg`,
      addedBy: `User ${i}`,
    });
    queueRepo.updateStatus(item.id, "playing", { startedAt: 2000 + i * 100 });
    queueRepo.updateStatus(item.id, "played", {
      finishedAt: 2000 + i * 100 + 60,
      finishReason: "ended",
      playedSeconds: 240,
    });
  }
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
    // Fetch page 1
    const res1 = await fetch(`${baseUrl}/api/history?page=1&limit=10`);
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
    const res2 = await fetch(`${baseUrl}/api/history?page=2&limit=10`);
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
