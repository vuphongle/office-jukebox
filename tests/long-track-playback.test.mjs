import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { initDb, closeDb } from "../src/db.js";
import { JukeboxState } from "../src/state.js";
import { formatSecondsToDuration } from "../src/duration.js";

afterEach(() => closeDb());

test("state.updateDuration updates duration in memory and SQLite", () => {
  const db = initDb({ dbPath: ":memory:" });
  const state = new JukeboxState(db);

  const { item } = state.add({
    videoId: "long-video-1",
    title: "Long DJ Mix",
    duration: "3:30", // initial default
    provider: "youtube",
  });

  assert.equal(state.nowPlaying.duration, "3:30");

  // Host detects real duration from YouTube player: 15 minutes (900s)
  const updated = state.updateDuration(item.id, formatSecondsToDuration(900));
  assert.equal(updated, true);
  assert.equal(state.nowPlaying.duration, "15:00");

  // Verify SQLite row was updated
  const row = db.query("SELECT duration FROM queue_items WHERE id = ?").get(item.id);
  assert.equal(row.duration, "15:00");
});

test("isNowPlayingStale and retireStaleNowPlaying respect hasActiveTick", () => {
  const db = initDb({ dbPath: ":memory:" });
  const state = new JukeboxState(db);

  const now = 1713000000000;
  state.add({ videoId: "song1", title: "Song 1", duration: "3:30" }); // 210s
  state.nowPlaying.startedAt = now;

  // 300s elapsed (5 minutes, past 210s + 60s grace = 270s)
  // Without active tick -> stale
  assert.equal(state.isNowPlayingStale({ now: now + 300 * 1000, graceSeconds: 60 }), true);

  // With active host tick -> NOT stale!
  assert.equal(
    state.isNowPlayingStale({ now: now + 300 * 1000, graceSeconds: 60, hasActiveTick: true }),
    false
  );

  // retireStaleNowPlaying returns null when hasActiveTick is true
  const retired = state.retireStaleNowPlaying({
    now: now + 300 * 1000,
    graceSeconds: 60,
    hasActiveTick: true,
  });
  assert.equal(retired, null);
  assert.ok(state.nowPlaying);
  assert.equal(state.nowPlaying.videoId, "song1");
});

test("E2E: server accepts long tracks > 10m and dynamically syncs duration from host ticks", async () => {
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { WebSocket } = await import("ws");

  const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "jukebox-long-test-"));
  const dbPath = path.join(dataDir, "jukebox.db");

  const port = 49000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      JUKEBOX_DB_PATH: dbPath,
      JUKEBOX_DATA_DIR: dataDir,
      ADMIN_USERNAME: "review-admin",
      ADMIN_PASSWORD: "review-password-123",
      HOST_PASSWORD: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    let started = false;
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`${baseUrl}/api/info`);
        if (res.ok) { started = true; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(started, "Server should start successfully");

    // 1. Add track with 15:00 duration via /api/request -> should succeed
    const reqRes = await fetch(`${baseUrl}/api/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId: "dQw4w9WgXcQ",
        title: "Long 15-Minute Track",
        channel: "Test Channel",
        duration: "15:00",
        provider: "youtube",
        name: "TestUser",
        clientId: "client-user-1",
      }),
    });
    const reqData = await reqRes.json();
    assert.equal(reqRes.status, 200);
    assert.equal(reqData.ok, true, `Expected ok:true, got: ${JSON.stringify(reqData)}`);

    // 2. Connect WebSocket as host
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let receivedState = null;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout waiting for WS open")), 3000);
      ws.on("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on("error", reject);
    });

    // Wait for initial state
    receivedState = await new Promise((resolve) => {
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "state") resolve(msg.state);
        } catch {}
      });
    });

    assert.ok(receivedState?.nowPlaying);
    assert.equal(receivedState.nowPlaying.videoId, "dQw4w9WgXcQ");
    assert.equal(receivedState.nowPlaying.duration, "15:00");

    // 3. Host sends playbackTick with real duration 18:30 (1110s)
    const stateUpdatePromise = new Promise((resolve) => {
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "state" && msg.state?.nowPlaying?.duration === "18:30") {
            resolve(msg.state);
          }
        } catch {}
      });
    });

    ws.send(JSON.stringify({
      type: "playbackTick",
      position: 10000,
      duration: 1110,
      paused: false,
      videoId: "dQw4w9WgXcQ",
    }));

    const updatedState = await Promise.race([
      stateUpdatePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for duration sync")), 3000)),
    ]);
    assert.equal(updatedState.nowPlaying.duration, "18:30");

    // 4. Request a 1-hour+ track (e.g. "1:15:00") via /api/request -> should succeed without 10-minute limit
    const reqRes2 = await fetch(`${baseUrl}/api/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId: "jNQXAC9IVRw",
        title: "1-Hour DJ Set",
        channel: "Test Channel",
        duration: "1:15:00",
        provider: "youtube",
        name: "TestUser",
        clientId: "client-user-2",
      }),
    });
    const reqData2 = await reqRes2.json();
    assert.equal(reqRes2.status, 200);
    assert.equal(reqData2.ok, true, `Expected ok:true, got: ${JSON.stringify(reqData2)}`);

    ws.close();
  } finally {
    if (child.exitCode === null) {
      child.kill(process.platform === "win32" ? "SIGKILL" : "SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await new Promise((resolve) => setTimeout(resolve, process.platform === "win32" ? 150 : 50));
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  }
});
