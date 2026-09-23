import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb, initDb } from "../src/db.js";
import { FavoriteRepository } from "../src/repositories/favoriteRepository.js";
import { UserRepository } from "../src/repositories/userRepository.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

afterEach(() => closeDb());

test("favorite songs stay private to each user and repeated likes update one record", () => {
  const db = initDb({ dbPath: ":memory:" });
  const users = new UserRepository(db);
  const favorites = new FavoriteRepository(db);
  const alice = users.create({ username: "favorite-alice", passwordHash: "p" });
  const bob = users.create({ username: "favorite-bob", passwordHash: "p" });

  favorites.save(alice.id, {
    videoId: "dQw4w9WgXcQ",
    title: "First title",
    channel: "First artist",
    duration: "3:33",
    thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
  });
  favorites.save(alice.id, {
    videoId: "dQw4w9WgXcQ",
    title: "Canonical title",
    channel: "Canonical artist",
    duration: "3:32",
    thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
  });

  assert.deepEqual(favorites.list(bob.id), []);
  assert.deepEqual(favorites.list(alice.id), [
    {
      videoId: "dQw4w9WgXcQ",
      title: "Canonical title",
      channel: "Canonical artist",
      duration: "3:32",
      thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
    },
  ]);
});

test("favorite songs validate metadata and unlike is idempotent", () => {
  const db = initDb({ dbPath: ":memory:" });
  const users = new UserRepository(db);
  const favorites = new FavoriteRepository(db);
  const user = users.create({ username: "favorite-validation", passwordHash: "p" });

  assert.throws(
    () => favorites.save(user.id, { videoId: "invalid", title: "Broken" }),
    /Mã video YouTube không hợp lệ/
  );
  assert.throws(
    () => favorites.save(user.id, { videoId: "dQw4w9WgXcQ", title: "" }),
    /Tên bài hát không hợp lệ/
  );

  favorites.save(user.id, {
    videoId: "dQw4w9WgXcQ",
    title: "Safe favorite",
    channel: "Artist",
    thumbnail: "https://attacker.example/image.jpg",
  });
  assert.equal(favorites.list(user.id)[0].thumbnail, null);
  assert.equal(favorites.remove(user.id, "dQw4w9WgXcQ"), true);
  assert.equal(favorites.remove(user.id, "dQw4w9WgXcQ"), false);
  assert.deepEqual(favorites.list(user.id), []);
});

test("favorite songs support TikTok tracks and retain their thumbnails", () => {
  const db = initDb({ dbPath: ":memory:" });
  const users = new UserRepository(db);
  const favorites = new FavoriteRepository(db);
  const user = users.create({ username: "favorite-tiktok", passwordHash: "p" });

  const ttUrl = "https://vt.tiktok.com/ZSqEydUb4";
  const ttCover = "https://p19-common-sign.tiktokcdn-us.com/tos-alisg-p-0037/cover.jpeg?x-expires=1790161200&x-signature=abc";

  const saved = favorites.save(user.id, {
    videoId: ttUrl,
    title: "LAVIEM Drill Mix - Prod. | Editby. Ca",
    channel: "Music For Life",
    duration: "0:41",
    thumbnail: ttCover,
    provider: "tiktok",
  });

  assert.equal(saved.provider, "tiktok");
  assert.equal(saved.thumbnail, ttCover);
  assert.deepEqual(favorites.list(user.id), [
    {
      videoId: ttUrl,
      title: "LAVIEM Drill Mix - Prod. | Editby. Ca",
      channel: "Music For Life",
      duration: "0:41",
      thumbnail: ttCover,
      provider: "tiktok",
    },
  ]);

  assert.equal(favorites.remove(user.id, ttUrl), true);
  assert.deepEqual(favorites.list(user.id), []);
});

async function startServer(dataDir) {
  const port = 48000 + Math.floor(Math.random() * 1000);
  const child = spawn("bun", ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      JUKEBOX_DB_PATH: path.join(dataDir, "jukebox.db"),
      JUKEBOX_DATA_DIR: dataDir,
      ADMIN_USERNAME: "favorite-admin",
      ADMIN_PASSWORD: "favorite-password-123",
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
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      if ((await fetch(`${baseUrl}/api/info`)).ok) return { child, baseUrl };
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

async function register(baseUrl, username) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "favorite-member-123", displayName: username }),
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";", 1)[0];
}

test("favorite song API requires authentication and isolates each member's list", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "office-jukebox-favorites-"));
  const { child, baseUrl } = await startServer(dataDir);
  try {
    const guestHtml = await (await fetch(`${baseUrl}/guest`)).text();
    assert.match(guestHtml, /id="favorites-toggle"/);
    assert.match(guestHtml, /favorites-controller\.js\?v=/);

    assert.equal((await fetch(`${baseUrl}/api/me/favorites`)).status, 401);
    const aliceCookie = await register(baseUrl, "favorite_api_alice");
    const bobCookie = await register(baseUrl, "favorite_api_bob");
    const song = {
      videoId: "dQw4w9WgXcQ",
      title: "Favorite API song",
      channel: "Favorite API artist",
      duration: "3:32",
      thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    };

    const saved = await fetch(`${baseUrl}/api/me/favorites`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: aliceCookie },
      body: JSON.stringify(song),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).favorite, song);

    const invalid = await fetch(`${baseUrl}/api/me/favorites`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: aliceCookie },
      body: JSON.stringify({ videoId: "invalid", title: "Broken" }),
    });
    assert.equal(invalid.status, 400);

    const aliceList = await (await fetch(`${baseUrl}/api/me/favorites`, {
      headers: { Cookie: aliceCookie },
    })).json();
    assert.deepEqual(aliceList.items, [song]);
    assert.equal(Object.hasOwn(aliceList.items[0], "userId"), false);

    const bobList = await (await fetch(`${baseUrl}/api/me/favorites`, {
      headers: { Cookie: bobCookie },
    })).json();
    assert.deepEqual(bobList.items, []);

    const bobDelete = await fetch(`${baseUrl}/api/me/favorites/${song.videoId}`, {
      method: "DELETE",
      headers: { Cookie: bobCookie },
    });
    assert.equal((await bobDelete.json()).removed, false);

    const aliceDelete = await fetch(`${baseUrl}/api/me/favorites/${song.videoId}`, {
      method: "DELETE",
      headers: { Cookie: aliceCookie },
    });
    assert.equal((await aliceDelete.json()).removed, true);
    const repeatedDelete = await fetch(`${baseUrl}/api/me/favorites/${song.videoId}`, {
      method: "DELETE",
      headers: { Cookie: aliceCookie },
    });
    assert.equal((await repeatedDelete.json()).removed, false);
  } finally {
    await stopServer(child);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
