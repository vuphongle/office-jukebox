import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { initDb, closeDb } from "../src/db.js";
import { JukeboxState } from "../src/state.js";
import { UserRepository } from "../src/repositories/userRepository.js";

afterEach(() => closeDb());

test("isNowPlayingStale detects expired playback beyond grace period", () => {
  const db = initDb({ dbPath: ":memory:" });
  const state = new JukeboxState(db);

  assert.equal(state.isNowPlayingStale(), false);

  const now = 1713000000000;
  state.add({ videoId: "song1", title: "Song 1", duration: "3:00" }); // 180s
  state.nowPlaying.startedAt = now;

  // 100 seconds in -> not stale
  assert.equal(state.isNowPlayingStale({ now: now + 100 * 1000, graceSeconds: 60 }), false);

  // 180 seconds in (exact duration) -> within grace period -> not stale
  assert.equal(state.isNowPlayingStale({ now: now + 180 * 1000, graceSeconds: 60 }), false);

  // 239 seconds in (duration + 59s) -> within grace period -> not stale
  assert.equal(state.isNowPlayingStale({ now: now + 239 * 1000, graceSeconds: 60 }), false);

  // 241 seconds in (duration + 61s) -> exceeds grace period -> stale!
  assert.equal(state.isNowPlayingStale({ now: now + 241 * 1000, graceSeconds: 60 }), true);

  // 14 hours later (overnight) -> definitely stale!
  assert.equal(state.isNowPlayingStale({ now: now + 14 * 3600 * 1000, graceSeconds: 60 }), true);
});

test("retireStaleNowPlaying retires abandoned song as 'played' without vote refund and promotes next song", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const state = new JukeboxState(db);

  const voter = userRepo.create({ username: "voter1", passwordHash: "p" });
  userRepo.updatePoints(voter.id, 10, { type: "admin_adjustment" });

  const yesterday = Date.now() - 14 * 3600 * 1000; // 14 hours ago

  // Add song1 (playing) and song2 (queued with votes)
  state.add({ videoId: "song_yesterday", title: "Yesterday's Track", duration: "3:30" }); // 210s
  const s2 = state.add({ videoId: "song_today", title: "Today's Track", duration: "4:00" }).item;
  state.vote(s2.id, voter.id);

  // Simulate song1 started yesterday at host shutdown
  state.nowPlaying.startedAt = yesterday;
  db.run("UPDATE queue_items SET started_at = ? WHERE id = ?", [yesterday, state.nowPlaying.id]);

  const beforeBalance = userRepo.findById(voter.id).points_balance;
  assert.equal(beforeBalance, 9); // spent 1 point on vote

  // Next morning: host turns on and checks state
  const result = state.retireStaleNowPlaying({ graceSeconds: 60 });
  assert.ok(result);
  assert.equal(result.retiredItem.videoId, "song_yesterday");
  assert.equal(result.transition.finalStatus, "played");
  assert.equal(result.transition.finishReason, "ended");
  assert.equal(result.transition.playedSeconds, 210);

  // No vote refunds should have been issued
  const afterBalance = userRepo.findById(voter.id).points_balance;
  assert.equal(afterBalance, 9); // balance unchanged, no refund!

  // Database verification
  const dbSongYesterday = db.query("SELECT * FROM queue_items WHERE video_id = ?").get("song_yesterday");
  assert.equal(dbSongYesterday.status, "played");
  assert.equal(dbSongYesterday.finish_reason, "ended");
  assert.equal(dbSongYesterday.played_seconds, 210);

  // Next song should be promoted with fresh startedAt
  assert.ok(state.nowPlaying);
  assert.equal(state.nowPlaying.videoId, "song_today");
  assert.ok(Date.now() - state.nowPlaying.startedAt < 2000); // started just now!
});

test("retireStaleNowPlaying with empty queue leaves player idle", () => {
  const db = initDb({ dbPath: ":memory:" });
  const state = new JukeboxState(db);

  const yesterday = Date.now() - 14 * 3600 * 1000;
  state.add({ videoId: "alone", title: "Alone From Yesterday", duration: "2:00" });
  state.nowPlaying.startedAt = yesterday;

  const result = state.retireStaleNowPlaying({ graceSeconds: 60 });
  assert.ok(result);
  assert.equal(state.nowPlaying, null);
  assert.equal(state.queue.length, 0);

  const dbItem = db.query("SELECT * FROM queue_items WHERE video_id = ?").get("alone");
  assert.equal(dbItem.status, "played");
  assert.equal(dbItem.finish_reason, "ended");
});

test("initFromDb cleanly retires stale 'playing' item left overnight in SQLite", () => {
  const db = initDb({ dbPath: ":memory:" });
  const yesterday = Date.now() - 14 * 3600 * 1000;

  // Insert a song left in status 'playing' from yesterday directly into SQLite
  db.run(`
    INSERT INTO queue_items (
      id, event_id, video_id, title, channel, duration, thumbnail,
      added_by, requester_id, queue_sequence, vote_score, pinned,
      pinned_order, status, added_at, started_at, provider
    ) VALUES (
      'old-id', 'default_event', 'vid-old', 'Old Song', 'Artist', '3:00', NULL,
      'Host', 'req1', 1, 0, 0, 0, 'playing', ?, ?, 'youtube'
    )
  `, [yesterday, yesterday]);

  // Insert an upcoming queued song
  db.run(`
    INSERT INTO queue_items (
      id, event_id, video_id, title, channel, duration, thumbnail,
      added_by, requester_id, queue_sequence, vote_score, pinned,
      pinned_order, status, added_at, provider
    ) VALUES (
      'new-id', 'default_event', 'vid-new', 'Morning Song', 'Artist', '3:30', NULL,
      'User', 'req2', 2, 0, 0, 0, 'queued', ?, 'youtube'
    )
  `, [Date.now()]);

  // Server starts up fresh (hydrates from DB)
  const state = new JukeboxState(db);

  // The old song should have been cleanly retired to 'played'
  const oldDbItem = db.query("SELECT * FROM queue_items WHERE id = 'old-id'").get();
  assert.equal(oldDbItem.status, "played");
  assert.equal(oldDbItem.finish_reason, "ended");
  assert.equal(oldDbItem.played_seconds, 180);

  // The morning song should now be nowPlaying with fresh startedAt
  assert.ok(state.nowPlaying);
  assert.equal(state.nowPlaying.id, "new-id");
  assert.equal(state.nowPlaying.videoId, "vid-new");
  assert.ok(Date.now() - state.nowPlaying.startedAt < 2000);
});

test("ensureFreshPlayback resets startedAt when song was waiting for host", () => {
  const db = initDb({ dbPath: ":memory:" });
  const state = new JukeboxState(db);

  state.add({ videoId: "song1", title: "Song 1", duration: "3:00" });
  const originalToken = state.nowPlaying.playbackToken;

  // Simulate 30 minutes elapsed while waiting for host
  state.nowPlaying.startedAt = Date.now() - 30 * 60 * 1000;

  const refreshed = state.ensureFreshPlayback();
  assert.equal(refreshed, true);
  assert.ok(Date.now() - state.nowPlaying.startedAt < 1000);
  assert.notEqual(state.nowPlaying.playbackToken, originalToken); // new token
});

test("WebSocket client receives fresh queue state when host arrives after overnight shutdown", async () => {
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { WebSocket } = await import("ws");

  const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "jukebox-stale-test-"));
  const dbPath = path.join(dataDir, "jukebox.db");

  // Pre-seed database with an abandoned song from yesterday and a queued morning song
  const seedDb = initDb({ dbPath });
  const yesterday = Date.now() - 14 * 3600 * 1000;
  seedDb.run(`
    INSERT INTO queue_items (
      id, event_id, video_id, title, channel, duration, thumbnail,
      added_by, requester_id, queue_sequence, vote_score, pinned,
      pinned_order, status, added_at, started_at, provider
    ) VALUES (
      'yesterday-id', 'default_event', 'vid-yesterday', 'Song From Yesterday', 'Artist', '3:00', NULL,
      'Host', 'req1', 1, 0, 0, 0, 'playing', ?, ?, 'youtube'
    )
  `, [yesterday, yesterday]);

  seedDb.run(`
    INSERT INTO queue_items (
      id, event_id, video_id, title, channel, duration, thumbnail,
      added_by, requester_id, queue_sequence, vote_score, pinned,
      pinned_order, status, added_at, provider
    ) VALUES (
      'morning-id', 'default_event', 'vid-morning', 'Fresh Morning Track', 'Artist', '3:45', NULL,
      'Guest', 'req2', 2, 0, 0, 0, 'queued', ?, 'youtube'
    )
  `, [Date.now()]);
  closeDb();

  // Start server on a free port in 48000 range (well away from 45416)
  const port = 48000 + Math.floor(Math.random() * 1000);
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
    // Wait for server ready
    let started = false;
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`${baseUrl}/api/info`);
        if (res.ok) { started = true; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(started, "Server should start successfully");

    // Connect WebSocket as a host opening the web next morning
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const stateMsg = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout waiting for WebSocket state")), 5000);
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "state") {
            clearTimeout(timer);
            resolve(msg);
          }
        } catch {}
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    ws.close();

    // Verify the state sent to the host:
    // It must NOT have the stale yesterday song as nowPlaying!
    // It must have promoted the fresh morning track!
    assert.ok(stateMsg.state);
    assert.ok(stateMsg.state.nowPlaying);
    assert.equal(stateMsg.state.nowPlaying.id, "morning-id");
    assert.equal(stateMsg.state.nowPlaying.videoId, "vid-morning");
    assert.equal(stateMsg.state.nowPlaying.title, "Fresh Morning Track");

    // Verify database record for yesterday's song was retired cleanly as 'played'
    const verifyDb = initDb({ dbPath });
    const yesterdayRow = verifyDb.query("SELECT * FROM queue_items WHERE id = 'yesterday-id'").get();
    assert.equal(yesterdayRow.status, "played");
    assert.equal(yesterdayRow.finish_reason, "ended");
    assert.equal(yesterdayRow.played_seconds, 180);
    closeDb();
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

