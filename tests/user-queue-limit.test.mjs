import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { closeDb, initDb } from "../src/db.js";
import { QueueRepository } from "../src/repositories/queueRepository.js";
import { UserRepository } from "../src/repositories/userRepository.js";
import { JukeboxState } from "../src/state.js";
import { isPrivateIp, isDedicatedMachineIp } from "../src/clientIp.js";
import { countUserQueuedSongs } from "../src/queueLimit.js";
import { ensureDeviceId, DEVICE_COOKIE_NAME } from "../src/auth.js";

afterEach(() => {
  try { closeDb(); } catch {}
});

function createIsolatedDb() {
  return initDb({ dbPath: ":memory:" });
}

test("isPrivateIp correctly distinguishes private LAN and public IPs", () => {
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("::1"), true);
  assert.equal(isPrivateIp("localhost"), true);
  assert.equal(isPrivateIp("192.168.1.50"), true);
  assert.equal(isPrivateIp("10.0.0.1"), true);
  assert.equal(isPrivateIp("172.16.5.10"), true);
  assert.equal(isPrivateIp("172.31.255.254"), true);
  assert.equal(isPrivateIp("169.254.1.1"), true);

  // Public IPs
  assert.equal(isPrivateIp("8.8.8.8"), false);
  assert.equal(isPrivateIp("1.1.1.1"), false);
  assert.equal(isPrivateIp("172.32.0.1"), false);
  assert.equal(isPrivateIp("104.21.5.10"), false);
});

test("isDedicatedMachineIp distinguishes individual LAN workstation IPs from shared office Wi-Fi and proxies", () => {
  // Public IPs (Wi-Fi router WAN IP, NAT) are shared by the whole company — NEVER dedicated
  assert.equal(isDedicatedMachineIp("118.69.1.5"), false);
  assert.equal(isDedicatedMachineIp("203.0.113.1"), false);
  assert.equal(isDedicatedMachineIp("8.8.8.8"), false);

  // Loopback / reverse proxy is shared by all proxy traffic — NEVER dedicated
  assert.equal(isDedicatedMachineIp("127.0.0.1"), false);
  assert.equal(isDedicatedMachineIp("::1"), false);
  assert.equal(isDedicatedMachineIp("localhost"), false);

  // Wi-Fi AP gateway interfaces (.1 and .254) are shared routers — NEVER dedicated
  assert.equal(isDedicatedMachineIp("192.168.1.1"), false);
  assert.equal(isDedicatedMachineIp("10.0.0.1"), false);
  assert.equal(isDedicatedMachineIp("192.168.1.254"), false);

  // Individual workstation LAN IPs
  assert.equal(isDedicatedMachineIp("192.168.1.10"), true);
  assert.equal(isDedicatedMachineIp("192.168.1.20"), true);
  assert.equal(isDedicatedMachineIp("10.0.0.15"), true);
  assert.equal(isDedicatedMachineIp("172.16.5.42"), true);
});


test("ensureDeviceId assigns and persists deviceId across cookies", () => {
  const req1 = { headers: {} };
  const headersSet1 = [];
  const res1 = {
    getHeader: () => undefined,
    setHeader: (name, val) => headersSet1.push({ name, val }),
  };

  const id1 = ensureDeviceId(req1, res1);
  assert.ok(id1 && id1.length >= 10);
  assert.equal(req1.deviceId, id1);
  assert.ok(headersSet1[0].val.includes(DEVICE_COOKIE_NAME));

  // Request 2 with cookie preserves existing deviceId
  const req2 = { headers: { cookie: `${DEVICE_COOKIE_NAME}=${id1}` } };
  const res2 = { getHeader: () => undefined, setHeader: () => {} };
  const id2 = ensureDeviceId(req2, res2);
  assert.equal(id2, id1);
  assert.equal(req2.deviceId, id1);
});

test("QueueRepository persists and retrieves requester_ip and device_id", () => {
  const db = createIsolatedDb();
  const queueRepo = new QueueRepository(db);

  const item = queueRepo.createItem({
    videoId: "song-1",
    title: "Bài hát 1",
    channel: "Ca sĩ A",
    duration: "3:30",
    addedBy: "Khách 1",
    requesterId: "client-abc",
    provider: "youtube",
    requesterIp: "192.168.1.50",
    deviceId: "device-uuid-123",
  });

  assert.equal(item.requester_ip, "192.168.1.50");
  assert.equal(item.device_id, "device-uuid-123");

  const fetched = queueRepo.findById(item.id);
  assert.equal(fetched.requester_ip, "192.168.1.50");
  assert.equal(fetched.device_id, "device-uuid-123");
});

test("QueueRepository.getAllPlaybackHistory returns all played songs with pagination", () => {
  const db = createIsolatedDb();
  const queueRepo = new QueueRepository(db);

  const item1 = queueRepo.createItem({ videoId: "v1", title: "Song 1", addedBy: "User A", provider: "spotify" });
  const item2 = queueRepo.createItem({ videoId: "v2", title: "Song 2", addedBy: "User B", provider: "tiktok" });

  queueRepo.updateStatus(item1.id, "played", { finishedAt: 1000, playedSeconds: 200, finishReason: "ended" });
  queueRepo.updateStatus(item2.id, "played", { finishedAt: 2000, playedSeconds: 180, finishReason: "ended" });

  const history = queueRepo.getAllPlaybackHistory("default_event", { limit: 10, offset: 0 });
  assert.equal(history.total, 2);
  assert.equal(history.items.length, 2);
  assert.equal(history.items[0].id, item2.id);
  assert.equal(history.items[0].provider, "tiktok");
  assert.equal(history.items[1].id, item1.id);
  assert.equal(history.items[1].provider, "spotify");
});

test("QueueRepository.getAllPlaybackHistory returns avatar_file of requester via JOIN", () => {
  const db = createIsolatedDb();
  const queueRepo = new QueueRepository(db);
  const userRepo = new UserRepository(db);

  const user = userRepo.create({ username: "avatar-user", passwordHash: "p" });
  userRepo.updateAvatarFile(user.id, "avatar_user_123.jpg");

  const item = queueRepo.createItem({
    videoId: "song-avatar",
    title: "Avatar Song",
    addedBy: "AvatarUser",
    addedByUserId: user.id,
    provider: "youtube",
  });
  queueRepo.updateStatus(item.id, "played", { finishedAt: 3000, playedSeconds: 210, finishReason: "ended" });

  const history = queueRepo.getAllPlaybackHistory("default_event", { limit: 10, offset: 0 });
  assert.equal(history.total, 1);
  assert.equal(history.items[0].avatar_file, "avatar_user_123.jpg");
  assert.equal(history.items[0].added_by, "AvatarUser");
});

test("JukeboxState stores and hides requesterIp and deviceId in public snapshot", () => {
  const db = createIsolatedDb();
  const state = new JukeboxState(db);

  const { item } = state.add({
    videoId: "song-secret",
    title: "Secret Song",
    addedBy: "Alice",
    requesterId: "client-999",
    requesterIp: "10.0.0.15",
    deviceId: "device-xyz",
  });

  assert.equal(item.requesterIp, "10.0.0.15");
  assert.equal(item.deviceId, "device-xyz");

  const snap = state.snapshot();
  assert.ok(snap.nowPlaying);
  assert.equal(snap.nowPlaying.requesterIp, undefined);
  assert.equal(snap.nowPlaying.deviceId, undefined);
  assert.equal(snap.nowPlaying.requesterId, undefined);
  assert.equal(snap.nowPlaying.addedBy, "Alice");

  state.add({
    videoId: "song-queued",
    title: "Queued Song",
    addedBy: "Bob",
    requesterIp: "10.0.0.16",
    deviceId: "device-xyz2",
  });
  const snap2 = state.snapshot();
  const queuedItem = snap2.queue[0];
  assert.ok(queuedItem);
  assert.equal(queuedItem.requesterIp, undefined);
  assert.equal(queuedItem.deviceId, undefined);
  assert.equal(queuedItem.requesterId, undefined);
  assert.equal(queuedItem.addedBy, "Bob");
});

test("Multi-account anti-cheat and guest IP limit simulation", () => {
  const queue = [
    // Account 1 on Device 1 (LAN IP 192.168.1.10)
    { id: "1", addedByUserId: "user-acc-1", deviceId: "device-1", requesterId: "client-1", requesterIp: "192.168.1.10" },
    { id: "2", addedByUserId: "user-acc-1", deviceId: "device-1", requesterId: "client-1", requesterIp: "192.168.1.10" },
    { id: "3", addedByUserId: "user-acc-1", deviceId: "device-1", requesterId: "client-1", requesterIp: "192.168.1.10" },
    { id: "4", addedByUserId: "user-acc-1", deviceId: "device-1", requesterId: "client-1", requesterIp: "192.168.1.10" },
    { id: "5", addedByUserId: "user-acc-1", deviceId: "device-1", requesterId: "client-1", requesterIp: "192.168.1.10" },

    // Guest on Machine 2 (LAN IP 192.168.1.20)
    { id: "6", addedByUserId: null, deviceId: "device-2", requesterId: "client-guest", requesterIp: "192.168.1.20" },
    { id: "7", addedByUserId: null, deviceId: "device-2", requesterId: "client-guest", requesterIp: "192.168.1.20" },
  ];

  // 1. Account 1 checks their count -> 5 songs
  const countAcc1 = countUserQueuedSongs(queue, {
    userId: "user-acc-1",
    deviceId: "device-1",
    clientId: "client-1",
    requesterIp: "192.168.1.10",
  });
  assert.equal(countAcc1, 5);

  // 2. User switches to Account 2 on same device (device-1) -> detected by deviceId / clientId!
  const countAcc2SameDevice = countUserQueuedSongs(queue, {
    userId: "user-acc-2",
    deviceId: "device-1",
    clientId: "client-1",
    requesterIp: "192.168.1.10",
  });
  assert.equal(countAcc2SameDevice, 5);

  // 3. User opens Incognito on same LAN workstation (192.168.1.10) with Account 2 -> detected by workstation LAN IP!
  const countAcc2Incognito = countUserQueuedSongs(queue, {
    userId: "user-acc-2",
    deviceId: "device-new-incognito",
    clientId: "client-new",
    requesterIp: "192.168.1.10",
  });
  assert.equal(countAcc2Incognito, 5);

  // 4. Guest on Machine 2 clears cookies / opens Incognito -> detected by workstation LAN IP!
  const countGuestIncognito = countUserQueuedSongs(queue, {
    userId: null,
    deviceId: "device-guest-cleared",
    clientId: "client-guest-new",
    requesterIp: "192.168.1.20",
  });
  assert.equal(countGuestIncognito, 2);

  // 5. Coworker on Machine 3 (LAN IP 192.168.1.30) -> 0 songs, unaffected!
  const countCoworker = countUserQueuedSongs(queue, {
    userId: "user-coworker",
    deviceId: "device-3",
    clientId: "client-3",
    requesterIp: "192.168.1.30",
  });
  assert.equal(countCoworker, 0);

  // 6. Public NAT simulation (different logged-in users sharing public IP 203.0.113.1 on different laptops)
  const publicQueue = [
    { id: "p1", addedByUserId: "user-alice", deviceId: "laptop-alice", requesterId: "c-alice", requesterIp: "203.0.113.1" },
    { id: "p2", addedByUserId: "user-alice", deviceId: "laptop-alice", requesterId: "c-alice", requesterIp: "203.0.113.1" },
  ];
  // Bob on laptop-bob sharing same public NAT IP 203.0.113.1 is NOT blocked by Alice!
  const countBobPublic = countUserQueuedSongs(publicQueue, {
    userId: "user-bob",
    deviceId: "laptop-bob",
    clientId: "c-bob",
    requesterIp: "203.0.113.1",
  });
  assert.equal(countBobPublic, 0);

  // 7. CRITICAL: Office Wi-Fi with multiple unauthenticated guests sharing the same public WAN IP (118.69.1.5)
  // Alice adds 5 songs as a guest.
  const officeWifiQueue = [
    { id: "w1", addedByUserId: null, deviceId: "laptop-alice", requesterId: "c-alice", requesterIp: "118.69.1.5" },
    { id: "w2", addedByUserId: null, deviceId: "laptop-alice", requesterId: "c-alice", requesterIp: "118.69.1.5" },
    { id: "w3", addedByUserId: null, deviceId: "laptop-alice", requesterId: "c-alice", requesterIp: "118.69.1.5" },
    { id: "w4", addedByUserId: null, deviceId: "laptop-alice", requesterId: "c-alice", requesterIp: "118.69.1.5" },
    { id: "w5", addedByUserId: null, deviceId: "laptop-alice", requesterId: "c-alice", requesterIp: "118.69.1.5" },
  ];
  // Alice on laptop-alice reaches her limit (5 songs)
  const countAlice = countUserQueuedSongs(officeWifiQueue, {
    userId: null,
    deviceId: "laptop-alice",
    clientId: "c-alice",
    requesterIp: "118.69.1.5",
  });
  assert.equal(countAlice, 5);

  // Bob on laptop-bob (guest on the SAME office Wi-Fi 118.69.1.5) has 0 songs and is NOT blocked by Alice!
  const countBobGuest = countUserQueuedSongs(officeWifiQueue, {
    userId: null,
    deviceId: "laptop-bob",
    clientId: "c-bob",
    requesterIp: "118.69.1.5",
  });
  assert.equal(countBobGuest, 0);

  // Carol on phone-carol (guest on the SAME office Wi-Fi 118.69.1.5) has 0 songs and is NOT blocked!
  const countCarolGuest = countUserQueuedSongs(officeWifiQueue, {
    userId: null,
    deviceId: "phone-carol",
    clientId: "c-carol",
    requesterIp: "118.69.1.5",
  });
  assert.equal(countCarolGuest, 0);

  // 8. Reverse proxy loopback (127.0.0.1) isolation:
  // Different devices connecting through a reverse proxy (127.0.0.1) must not block each other
  const proxyQueue = [
    { id: "px1", addedByUserId: null, deviceId: "machine-1", requesterId: "c-1", requesterIp: "127.0.0.1" },
    { id: "px2", addedByUserId: null, deviceId: "machine-1", requesterId: "c-1", requesterIp: "127.0.0.1" },
  ];
  const countMachine2 = countUserQueuedSongs(proxyQueue, {
    userId: null,
    deviceId: "machine-2",
    clientId: "c-2",
    requesterIp: "127.0.0.1",
  });
  assert.equal(countMachine2, 0);
});

test("User queue limit steps cycle correctly across 5, 10, 15 and OFF", () => {
  const steps = [5, 10, 15];
  function nextLimit(on, currentLimit) {
    if (!on) return { on: true, limit: steps[0] };
    const i = steps.indexOf(currentLimit);
    if (i === -1 || i === steps.length - 1) return { on: false, limit: currentLimit };
    return { on: true, limit: steps[i + 1] };
  }

  // Initial: OFF -> 5
  let state = nextLimit(false, 5);
  assert.deepEqual(state, { on: true, limit: 5 });

  // 5 -> 10
  state = nextLimit(state.on, state.limit);
  assert.deepEqual(state, { on: true, limit: 10 });

  // 10 -> 15
  state = nextLimit(state.on, state.limit);
  assert.deepEqual(state, { on: true, limit: 15 });

  // 15 -> OFF
  state = nextLimit(state.on, state.limit);
  assert.deepEqual(state, { on: false, limit: 15 });

  // OFF -> 5
  state = nextLimit(state.on, state.limit);
  assert.deepEqual(state, { on: true, limit: 5 });
});

