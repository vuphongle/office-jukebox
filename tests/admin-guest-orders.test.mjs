import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initDb, closeDb } from "../src/db.js";
import { QueueRepository } from "../src/repositories/queueRepository.js";
import { UserRepository } from "../src/repositories/userRepository.js";
import { SessionRepository } from "../src/repositories/sessionRepository.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

afterEach(() => closeDb());

test("QueueRepository.listGuestOrders returns only guest orders with requester_ip and filters properly", () => {
  const db = initDb({ dbPath: ":memory:" });
  const queueRepo = new QueueRepository(db);
  const userRepo = new UserRepository(db);

  const member = userRepo.create({ username: "member1", passwordHash: "p" });

  // 1. Create a member order (should NOT be returned in listGuestOrders)
  queueRepo.createItem({
    videoId: "member_vid_1",
    title: "Member Song",
    channel: "Member Artist",
    duration: "3:30",
    addedBy: "Member One",
    requesterId: "req-member",
    addedByUserId: member.id,
    requesterIp: "192.168.1.200",
  });

  // 2. Create multiple guest orders
  const guest1 = queueRepo.createItem({
    videoId: "guest_vid_1",
    title: "Guest Song Alpha",
    channel: "Artist A",
    duration: "4:00",
    addedBy: "Khách Bàn 1",
    requesterId: "req-guest-1",
    addedByUserId: null,
    provider: "youtube",
    requesterIp: "192.168.1.50",
  });

  const guest2 = queueRepo.createItem({
    videoId: "guest_vid_2",
    title: "Guest Song Beta",
    channel: "Artist B",
    duration: "3:15",
    addedBy: "Khách Bàn 2",
    requesterId: "req-guest-2",
    addedByUserId: null,
    provider: "spotify",
    requesterIp: "192.168.1.55",
  });

  const guest3 = queueRepo.createItem({
    videoId: "guest_vid_3",
    title: "Guest Song Gamma",
    channel: "Artist C",
    duration: "2:50",
    addedBy: "Khách VIP",
    requesterId: "req-guest-3",
    addedByUserId: null,
    provider: "youtube",
    requesterIp: "192.168.1.60",
  });

  // Change statuses
  queueRepo.updateStatus(guest1.id, "playing", { startedAt: 1000 });
  queueRepo.updateStatus(guest1.id, "played", { finishedAt: 1200, finishReason: "ended", playedSeconds: 240 });
  queueRepo.updateStatus(guest2.id, "playing", { startedAt: 1300 });

  // Test 1: Fetch all guest orders
  const allGuestOrders = queueRepo.listGuestOrders({ limit: 10, offset: 0 });
  assert.equal(allGuestOrders.total, 3, "Total guest orders should be 3 (excluding member)");
  assert.equal(allGuestOrders.items.length, 3);
  assert.ok(allGuestOrders.items.every((it) => !it.added_by_user_id), "All items must be from guests");

  // Verify fields
  const first = allGuestOrders.items.find((it) => it.id === guest1.id);
  assert.ok(first);
  assert.equal(first.requester_ip, "192.168.1.50");
  assert.equal(first.added_by, "Khách Bàn 1");
  assert.equal(first.title, "Guest Song Alpha");
  assert.equal(first.status, "played");
  assert.equal(first.provider, "youtube");

  // Test 2: Filter by status
  const playedOrders = queueRepo.listGuestOrders({ status: "played" });
  assert.equal(playedOrders.total, 1);
  assert.equal(playedOrders.items[0].id, guest1.id);

  const playingOrders = queueRepo.listGuestOrders({ status: "playing" });
  assert.equal(playingOrders.total, 1);
  assert.equal(playingOrders.items[0].id, guest2.id);

  const queuedOrders = queueRepo.listGuestOrders({ status: "queued" });
  assert.equal(queuedOrders.total, 1);
  assert.equal(queuedOrders.items[0].id, guest3.id);

  // Test 3: Search by IP
  const searchIp = queueRepo.listGuestOrders({ search: "192.168.1.55" });
  assert.equal(searchIp.total, 1);
  assert.equal(searchIp.items[0].id, guest2.id);
  assert.equal(searchIp.items[0].requester_ip, "192.168.1.55");

  // Test 4: Search by guest name
  const searchName = queueRepo.listGuestOrders({ search: "VIP" });
  assert.equal(searchName.total, 1);
  assert.equal(searchName.items[0].id, guest3.id);

  // Test 5: Search by song title
  const searchTitle = queueRepo.listGuestOrders({ search: "Beta" });
  assert.equal(searchTitle.total, 1);
  assert.equal(searchTitle.items[0].id, guest2.id);

  // Test 6: Pagination
  const page1 = queueRepo.listGuestOrders({ limit: 2, offset: 0 });
  assert.equal(page1.total, 3);
  assert.equal(page1.items.length, 2);

  const page2 = queueRepo.listGuestOrders({ limit: 2, offset: 2 });
  assert.equal(page2.total, 3);
  assert.equal(page2.items.length, 1);
});

test("GET /api/admin/guest-orders enforces admin auth and returns guest orders", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "jukebox-admin-guest-test-"));
  const dbPath = path.join(dataDir, "jukebox.db");

  const db = initDb({ dbPath, adminUser: "admin", adminPass: "admin12345" });
  const queueRepo = new QueueRepository(db);
  const userRepo = new UserRepository(db);
  const sessionRepo = new SessionRepository(db);

  const admin = userRepo.findByUsername("admin");
  const adminSession = sessionRepo.create(admin.id, "admin-guest-session");

  const member = userRepo.create({ username: "regular_user", passwordHash: "p" });
  const memberSession = sessionRepo.create(member.id, "member-guest-session");

  // Create 1 member order and 2 guest orders
  queueRepo.createItem({
    videoId: "m_song",
    title: "Member Track",
    addedBy: "regular_user",
    addedByUserId: member.id,
    requesterIp: "10.0.0.1",
  });

  queueRepo.createItem({
    videoId: "g_song_1",
    title: "Guest Track 1",
    addedBy: "Khách Hải",
    addedByUserId: null,
    provider: "youtube",
    requesterIp: "192.168.1.101",
  });

  queueRepo.createItem({
    videoId: "g_song_2",
    title: "Guest Track 2",
    addedBy: "Khách Nam",
    addedByUserId: null,
    provider: "spotify",
    requesterIp: "192.168.1.102",
  });

  closeDb();

  const port = 48000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ["server.js"], {
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

  let stderrOutput = "";
  child.stderr.on("data", (chunk) => {
    stderrOutput += chunk.toString();
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
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) {
    console.error("Server stderr output:", stderrOutput);
  }
  assert.ok(ready, `Server failed to start. Stderr: ${stderrOutput}`);

  try {
    // 1. Unauthenticated request should be 401
    const unauthRes = await fetch(`${baseUrl}/api/admin/guest-orders`);
    assert.equal(unauthRes.status, 401);

    // 2. Regular user request should be 403
    const memberRes = await fetch(`${baseUrl}/api/admin/guest-orders`, {
      headers: { Cookie: `jukebox_session=${memberSession.token}` },
    });
    assert.equal(memberRes.status, 403);

    // 3. Admin request should return 200 with guest orders
    const adminRes = await fetch(`${baseUrl}/api/admin/guest-orders`, {
      headers: { Cookie: `jukebox_session=${adminSession.token}` },
    });
    assert.equal(adminRes.status, 200);
    const data = await adminRes.json();
    assert.equal(data.ok, true);
    assert.equal(data.total, 2);
    assert.equal(data.items.length, 2);

    const ips = data.items.map((it) => it.requester_ip);
    assert.ok(ips.includes("192.168.1.101"));
    assert.ok(ips.includes("192.168.1.102"));
    assert.ok(!ips.includes("10.0.0.1"), "Member order must not be included");

    // 4. Test search filter on API
    const searchRes = await fetch(`${baseUrl}/api/admin/guest-orders?search=101`, {
      headers: { Cookie: `jukebox_session=${adminSession.token}` },
    });
    assert.equal(searchRes.status, 200);
    const searchData = await searchRes.json();
    assert.equal(searchData.total, 1);
    assert.equal(searchData.items[0].requester_ip, "192.168.1.101");
  } finally {
    child.kill(process.platform === "win32" ? "SIGKILL" : "SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    if (process.platform === "win32") {
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
});
