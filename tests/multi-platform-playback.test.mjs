import test, { describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { initDb, closeDb } from "../src/db.js";
import { QueueRepository } from "../src/repositories/queueRepository.js";
import { JukeboxState } from "../src/state.js";

describe("Multi-platform playback and queue state", () => {
  afterEach(() => {
    closeDb();
  });

  test("JukeboxState correctly handles multi-platform items and preserves provider", () => {
    const db = initDb({ dbPath: ":memory:" });
    const state = new JukeboxState(db);
    state.onChange = () => {};

    // 1. Add YouTube song
    const ytSong = {
      videoId: "dQw4w9WgXcQ",
      title: "Rick Astley - Never Gonna Give You Up",
      channel: "RickAstleyVEVO",
      duration: "3:33",
      thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      provider: "youtube",
    };
    const ytRes = state.add(ytSong);
    assert.equal(ytRes.position, 0); // plays immediately
    assert.equal(state.nowPlaying.provider, "youtube");
    assert.equal(state.nowPlaying.videoId, "dQw4w9WgXcQ");

    // 2. Add Spotify song
    const spSong = {
      videoId: "4cOdK2wGLETKBW3PvgPWqT",
      title: "Never Gonna Give You Up",
      channel: "Rick Astley",
      duration: "3:33",
      thumbnail: "https://i.scdn.co/image/ab67616d0000b2735755e164993798e0c9ef7d7a",
      provider: "spotify",
    };
    const spRes = state.add(spSong);
    assert.equal(spRes.position, 1); // queued at pos 1
    assert.equal(state.queue[0].provider, "spotify");
    assert.equal(state.queue[0].videoId, "4cOdK2wGLETKBW3PvgPWqT");

    // 3. Add SoundCloud song
    const scSong = {
      videoId: "https://soundcloud.com/rick-astley/never-gonna-give-you-up",
      title: "Never Gonna Give You Up",
      channel: "Rick Astley",
      duration: "3:33",
      thumbnail: "https://i1.sndcdn.com/artworks-000123456-large.jpg",
      provider: "soundcloud",
    };
    const scRes = state.add(scSong);
    assert.equal(scRes.position, 2); // queued at pos 2
    assert.equal(state.queue[1].provider, "soundcloud");
    assert.equal(state.queue[1].videoId, "https://soundcloud.com/rick-astley/never-gonna-give-you-up");

    // 4. Verify snapshot includes provider
    const snapshot = state.snapshot();
    assert.equal(snapshot.nowPlaying.provider, "youtube");
    assert.equal(snapshot.queue[0].provider, "spotify");
    assert.equal(snapshot.queue[1].provider, "soundcloud");

    // 5. Advance from YouTube to Spotify
    const ytToken = state.nowPlaying.playbackToken;
    state.advance(ytSong.videoId, { finishReason: "ended", playbackToken: ytToken, playedSeconds: 213 });
    assert.equal(state.nowPlaying.provider, "spotify");
    assert.equal(state.nowPlaying.videoId, "4cOdK2wGLETKBW3PvgPWqT");
    assert.equal(state.queue.length, 1);
    assert.equal(state.queue[0].provider, "soundcloud");

    // 6. Advance from Spotify to SoundCloud
    const spToken = state.nowPlaying.playbackToken;
    state.advance(spSong.videoId, { finishReason: "ended", playbackToken: spToken, playedSeconds: 213 });
    assert.equal(state.nowPlaying.provider, "soundcloud");
    assert.equal(state.nowPlaying.videoId, "https://soundcloud.com/rick-astley/never-gonna-give-you-up");
    assert.equal(state.queue.length, 0);

    // 7. Advance from SoundCloud to idle
    const scToken = state.nowPlaying.playbackToken;
    state.advance(scSong.videoId, { finishReason: "ended", playbackToken: scToken });
    assert.equal(state.nowPlaying, null);
    assert.equal(state.queue.length, 0);
  });

  test("QueueRepository stores and retrieves provider correctly", () => {
    const db = initDb({ dbPath: ":memory:" });
    const repo = new QueueRepository(db);

    const inserted = repo.createItem({
      eventId: "default_event",
      videoId: "4cOdK2wGLETKBW3PvgPWqT",
      title: "Spotify Test Track",
      channel: "Test Artist",
      duration: "3:30",
      thumbnail: "https://example.com/thumb.jpg",
      addedBy: "Alice",
      requesterId: "client-1",
      provider: "spotify",
    });

    assert.equal(inserted.provider, "spotify");

    const row = db.query("SELECT provider FROM queue_items WHERE id = ?").get(inserted.id);
    assert.equal(row.provider, "spotify");
  });
});
