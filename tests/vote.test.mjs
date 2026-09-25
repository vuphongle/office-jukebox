import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { initDb, closeDb } from "../src/db.js";
import { JukeboxState } from "../src/state.js";
import { UserRepository } from "../src/repositories/userRepository.js";

afterEach(() => closeDb());

test("Multi-tier queue sorting: pinned > vote_score > sequence", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const state = new JukeboxState(db);

  const u1 = userRepo.create({ username: "u1", passwordHash: "p" });
  userRepo.updatePoints(u1.id, 10, { type: "admin_adjustment" });

  // Add now playing + 3 upcoming songs
  state.add({ videoId: "playing", title: "Playing" });
  const s1 = state.add({ videoId: "song1", title: "Song 1" }).item;
  const s2 = state.add({ videoId: "song2", title: "Song 2" }).item;
  const s3 = state.add({ videoId: "song3", title: "Song 3" }).item;

  // Initial order: song1 (seq 2), song2 (seq 3), song3 (seq 4)
  assert.deepEqual(state.queue.map(q => q.id), [s1.id, s2.id, s3.id]);

  // Vote for song3 -> becomes top
  state.vote(s3.id, u1.id);
  assert.deepEqual(state.queue.map(q => q.id), [s3.id, s1.id, s2.id]);

  // Song2 reaches the same score later, so it stays behind song3 even though
  // it was added earlier.
  state.vote(s2.id, u1.id);
  assert.deepEqual(state.queue.map(q => q.id), [s3.id, s2.id, s1.id]);

  // The same user can spend another point. Song2 only moves ahead after its
  // score becomes strictly higher.
  state.vote(s2.id, u1.id);
  assert.deepEqual(state.queue.map(q => q.id), [s2.id, s3.id, s1.id]);

  // Host pins song1 by reordering it to top
  state.reorder(s1.id, s2.id);
  assert.deepEqual(state.queue.map(q => q.id), [s1.id, s2.id, s3.id]);
  assert.equal(state.queue[0].pinned, true);

  // Host unpins song1 -> returns to natural rank based on vote
  state.unpin(s1.id);
  assert.deepEqual(state.queue.map(q => q.id), [s2.id, s3.id, s1.id]);
  assert.equal(state.queue.find(q => q.id === s1.id).pinned, false);
});

test("Vote refund when host removes song", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const state = new JukeboxState(db);

  const u = userRepo.create({ username: "voter", passwordHash: "p" });
  userRepo.updatePoints(u.id, 5, { type: "admin_adjustment" });

  state.add({ videoId: "playing", title: "Playing" });
  const s1 = state.add({ videoId: "song1", title: "Song 1" }).item;

  state.vote(s1.id, u.id);
  state.vote(s1.id, u.id);
  assert.equal(userRepo.findById(u.id).points_balance, 3);
  assert.deepEqual(state.queueRepo.listActiveVoteItemIds(u.id), [s1.id]);

  // Host removes s1
  let balanceChange = null;
  state.onBalanceChange = (change) => { balanceChange = change; };
  state.remove(s1.id);
  // Points refunded 100%
  assert.equal(userRepo.findById(u.id).points_balance, 5);
  assert.deepEqual(state.queueRepo.listActiveVoteItemIds(u.id), []);
  assert.equal(balanceChange.userId, u.id);
  assert.equal(balanceChange.pointsRefunded, 2);
  assert.equal(balanceChange.newBalance, 5);
});

test("Vote refund when YouTube error occurs on playing song", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const state = new JukeboxState(db);

  const u = userRepo.create({ username: "voter2", passwordHash: "p" });
  userRepo.updatePoints(u.id, 5, { type: "admin_adjustment" });

  // Song 1 starts playing immediately
  const s1 = state.add({ videoId: "song1", title: "Song 1", provider: "youtube" }).item;
  const s2 = state.add({ videoId: "song2", title: "Song 2", provider: "youtube" }).item;

  // Vote for song 2
  state.vote(s2.id, u.id);
  assert.equal(userRepo.findById(u.id).points_balance, 4);

  // Advance to s2
  state.advance("song1");
  assert.equal(state.nowPlaying.id, s2.id);

  let balanceChange = null;
  state.onBalanceChange = (change) => { balanceChange = change; };

  // s2 encounters error 101/150
  state.advance("song2", { isError: true });
  // Points refunded because playback failed
  assert.equal(userRepo.findById(u.id).points_balance, 5);
  assert.equal(balanceChange.reason, "Hoàn điểm do lỗi phát bài hát (YouTube)");
});

test("Vote refund when Spotify error occurs on playing song", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const state = new JukeboxState(db);

  const u = userRepo.create({ username: "spotify_voter", passwordHash: "p" });
  userRepo.updatePoints(u.id, 10, { type: "admin_adjustment" });

  // Initial song playing
  state.add({ videoId: "init_song", title: "Init Song", provider: "youtube" });

  // Add Spotify song
  const spSong = state.add({
    videoId: "4cOdK2wGLETKBW3PvgPWqT",
    title: "Never Gonna Give You Up",
    channel: "Rick Astley",
    provider: "spotify",
  }).item;

  // Vote 3 times for Spotify song
  state.vote(spSong.id, u.id);
  state.vote(spSong.id, u.id);
  state.vote(spSong.id, u.id);
  assert.equal(userRepo.findById(u.id).points_balance, 7);

  // Advance to Spotify song
  state.advance("init_song");
  assert.equal(state.nowPlaying.id, spSong.id);
  assert.equal(state.nowPlaying.provider, "spotify");

  let balanceChange = null;
  state.onBalanceChange = (change) => { balanceChange = change; };

  // Spotify playback error occurs
  state.advance(spSong.videoId, { isError: true });

  // Points refunded 100%
  assert.equal(userRepo.findById(u.id).points_balance, 10);
  assert.equal(balanceChange.pointsRefunded, 3);
  assert.equal(balanceChange.newBalance, 10);
  assert.equal(balanceChange.reason, "Hoàn điểm do lỗi phát bài hát (Spotify)");

  // Check ledger description
  const ledger = db.prepare("SELECT * FROM point_ledger WHERE user_id = ? AND type = 'vote_refund'").all(u.id);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].delta, 3);
  assert.equal(ledger[0].reason, "Lỗi phát bài hát (Spotify)");
});

test("Vote refund when SoundCloud error occurs on playing song", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const state = new JukeboxState(db);

  const u = userRepo.create({ username: "sc_voter", passwordHash: "p" });
  userRepo.updatePoints(u.id, 5, { type: "admin_adjustment" });

  state.add({ videoId: "init_song", title: "Init Song", provider: "youtube" });

  const scSong = state.add({
    videoId: "https://soundcloud.com/artist/track",
    title: "SoundCloud Track",
    channel: "Artist",
    provider: "soundcloud",
  }).item;

  state.vote(scSong.id, u.id);
  state.vote(scSong.id, u.id);
  assert.equal(userRepo.findById(u.id).points_balance, 3);

  state.advance("init_song");
  assert.equal(state.nowPlaying.id, scSong.id);

  let balanceChange = null;
  state.onBalanceChange = (change) => { balanceChange = change; };

  // SoundCloud error occurs
  state.advance(scSong.videoId, { isError: true });

  assert.equal(userRepo.findById(u.id).points_balance, 5);
  assert.equal(balanceChange.pointsRefunded, 2);
  assert.equal(balanceChange.reason, "Hoàn điểm do lỗi phát bài hát (SoundCloud)");

  const ledger = db.prepare("SELECT * FROM point_ledger WHERE user_id = ? AND type = 'vote_refund'").all(u.id);
  assert.equal(ledger[0].reason, "Lỗi phát bài hát (SoundCloud)");
});

test("Vote refund when TikTok error occurs on playing song", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const state = new JukeboxState(db);

  const u = userRepo.create({ username: "tt_voter", passwordHash: "p" });
  userRepo.updatePoints(u.id, 8, { type: "admin_adjustment" });

  state.add({ videoId: "init_song", title: "Init Song", provider: "youtube" });

  const ttSong = state.add({
    videoId: "https://www.tiktok.com/@user/video/123",
    title: "TikTok Sound",
    channel: "User",
    provider: "tiktok",
  }).item;

  state.vote(ttSong.id, u.id);
  assert.equal(userRepo.findById(u.id).points_balance, 7);

  state.advance("init_song");
  assert.equal(state.nowPlaying.id, ttSong.id);

  let balanceChange = null;
  state.onBalanceChange = (change) => { balanceChange = change; };

  // TikTok error occurs
  state.advance(ttSong.videoId, { isError: true });

  assert.equal(userRepo.findById(u.id).points_balance, 8);
  assert.equal(balanceChange.pointsRefunded, 1);
  assert.equal(balanceChange.reason, "Hoàn điểm do lỗi phát bài hát (TikTok)");

  const ledger = db.prepare("SELECT * FROM point_ledger WHERE user_id = ? AND type = 'vote_refund'").all(u.id);
  assert.equal(ledger[0].reason, "Lỗi phát bài hát (TikTok)");
});

test("Multiple voters get full refunds on multi-platform song playback error", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const state = new JukeboxState(db);

  const u1 = userRepo.create({ username: "user_a", passwordHash: "p" });
  const u2 = userRepo.create({ username: "user_b", passwordHash: "p" });
  userRepo.updatePoints(u1.id, 10, { type: "admin_adjustment" });
  userRepo.updatePoints(u2.id, 10, { type: "admin_adjustment" });

  state.add({ videoId: "init_song", title: "Init Song", provider: "youtube" });

  const spSong = state.add({
    videoId: "spotify_track_multi",
    title: "Shared Favorite",
    provider: "spotify",
  }).item;

  state.vote(spSong.id, u1.id);
  state.vote(spSong.id, u1.id); // u1 spent 2
  state.vote(spSong.id, u2.id); // u2 spent 1

  assert.equal(userRepo.findById(u1.id).points_balance, 8);
  assert.equal(userRepo.findById(u2.id).points_balance, 9);

  state.advance("init_song");

  const balanceChanges = [];
  state.onBalanceChange = (change) => { balanceChanges.push(change); };

  state.advance(spSong.videoId, { isError: true });

  assert.equal(userRepo.findById(u1.id).points_balance, 10);
  assert.equal(userRepo.findById(u2.id).points_balance, 10);
  assert.equal(balanceChanges.length, 2);
  assert.deepEqual(
    balanceChanges.map(c => ({ userId: c.userId, pointsRefunded: c.pointsRefunded })),
    [
      { userId: u1.id, pointsRefunded: 2 },
      { userId: u2.id, pointsRefunded: 1 },
    ]
  );
});

