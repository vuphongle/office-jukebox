// Event music system — a QR jukebox for the projector.
//
//   /        -> host page (projector view with QR code, player, and queue)
//   /guest   -> guest page (opened on a phone through the QR code)
//   /admin   -> admin dashboard (members, airdrops, points, feedback, and chat)
//
// Guest song-request flow:
//   1. guardrails          — cooldown, duplicates, and queue limits
//   2. checkPlayable()     — reject deleted, private, or missing videos
//   3. moderate()          — optional event-specific LLM decision (fail-open)
//   4. state.add()         — add to the queue (SQLite SSOT); broadcast over WebSocket

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import QRCode from "qrcode";

import {
  searchYouTube,
  fetchVietnamChartHits,
  checkPlayable,
  fetchVideoDetails,
  parseYouTubeVideoId,
  fetchYouTubeMetadata,
} from "./src/youtube.js";
import { moderate, moderationConfigured } from "./src/moderation.js";
import { JukeboxState } from "./src/state.js";
import { detectLanIp } from "./src/net.js";
import {
  CHAT_MIN_INTERVAL_MS,
  parseChatInput,
  pushRecentChat,
} from "./src/chat.js";
import { chatAiConfigured, normalizeChatAiSettings, summarizeFeedback } from "./src/chatAi.js";
import { ChatAiCoordinator } from "./src/chatAiCoordinator.js";

import { initDb } from "./src/db.js";
import { UserRepository } from "./src/repositories/userRepository.js";
import { SessionRepository } from "./src/repositories/sessionRepository.js";
import { LedgerRepository } from "./src/repositories/ledgerRepository.js";
import { QueueRepository } from "./src/repositories/queueRepository.js";
import { DropRepository } from "./src/repositories/dropRepository.js";
import { ChatRepository } from "./src/repositories/chatRepository.js";
import { ChatAiMemoryRepository } from "./src/repositories/chatAiMemoryRepository.js";
import { RankRepository } from "./src/repositories/rankRepository.js";
import { isQualifiedPlay } from "./src/rank.js";
import {
  createAuthMiddleware,
  hashPasswordAsync,
  verifyPasswordAsync,
  generateSessionToken,
  setSessionCookie,
  clearSessionCookie,
  getSessionTokenFromCookieHeader,
  requireAuth,
  requireAdmin,
} from "./src/auth.js";
import { createFixedWindowRateLimiter } from "./src/rateLimit.js";
import { canUseHostControls, refreshSocketIdentity } from "./src/socketAuth.js";
import { performCheckin, getLocalDate } from "./src/checkin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Minimal dependency-free .env loader ----------------------------------
const envPath = path.join(__dirname, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const PORT = parseInt(process.env.PORT || "45416", 10);
const LAN_IP = detectLanIp(process.env.HOST_IP);
const PUBLIC_BASE = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const GUEST_URL = PUBLIC_BASE ? `${PUBLIC_BASE}/guest` : `http://${LAN_IP}:${PORT}/guest`;

// --- Initialize SQLite database and repositories (SSOT) --------------------
const db = initDb();
const userRepo = new UserRepository(db);
const sessionRepo = new SessionRepository(db);
const ledgerRepo = new LedgerRepository(db);
const queueRepo = new QueueRepository(db);
const dropRepo = new DropRepository(db);
const chatRepo = new ChatRepository(db);
const chatAiMemoryRepo = new ChatAiMemoryRepository(db);
const rankRepo = new RankRepository(db);
chatRepo.prune();

if (!db.query("SELECT 1 FROM users WHERE role = 'admin' AND status = 'active' LIMIT 1").get()) {
  console.warn("[auth] No active admin account. Set ADMIN_USERNAME and ADMIN_PASSWORD before the first startup to create one.");
}

const state = new JukeboxState(db);

const RANK_BADGE_ICONS = Object.freeze({
  "headphones-blue": "🎧",
  pulse: "⚡",
  flame: "🔥",
  turntable: "🎛️",
  "stage-star": "🌟",
  "neon-crown": "👑",
});

function publicRank(userId) {
  const rank = rankRepo.getRank(userId);
  if (!rank) return null;
  return {
    level: rank.rankLevel,
    name: rank.rankName,
    badge: RANK_BADGE_ICONS[rank.badge] || "🎧",
    badgeId: rank.badge,
    xp: rank.xpTotal,
    nextLevel: rank.nextLevel,
    nextMinXp: rank.nextMinXp,
    xpToNext: rank.xpToNext,
  };
}

function publicStateSnapshot() {
  const snapshot = state.snapshot();
  const byId = new Map([state.nowPlaying, ...state.queue].filter(Boolean).map((item) => [item.id, item]));
  const decorate = (item) => {
    if (!item) return null;
    const source = byId.get(item.id);
    const rank = source?.addedByUserId ? publicRank(source.addedByUserId) : null;
    return rank ? { ...item, rank } : item;
  };
  return { ...snapshot, nowPlaying: decorate(snapshot.nowPlaying), queue: snapshot.queue.map(decorate) };
}

// --- Persisted host settings ------------------------------------------------
const DATA_DIR = path.join(__dirname, "data");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const FEEDBACK_PATH = path.join(DATA_DIR, "feedback.json");
let savedSettings = {};
try {
  savedSettings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
} catch {
  /* first run — use the values from .env below */
}

let filterOn =
  savedSettings.filterOn ?? String(process.env.ENABLE_MODERATION || "").toLowerCase() === "true";
let moderationMode =
  savedSettings.moderationMode ??
  ((process.env.MODERATION_MODE || "").toLowerCase() === "strict" ? "strict" : "default");
let eventContext = savedSettings.eventContext ?? (process.env.EVENT_CONTEXT || "");
let cooldownSeconds = savedSettings.cooldownSeconds ?? 15;
const QUEUE_LIMIT_STEPS = [5, 10, 15, 20];
let queueLimitOn = savedSettings.queueLimitOn ?? false;
let queueLimit = QUEUE_LIMIT_STEPS.includes(savedSettings.queueLimit) ? savedSettings.queueLimit : 10;
let requireName = savedSettings.requireName ?? false;
let feedbackOn = savedSettings.feedbackOn ?? true;
let chatOn = savedSettings.chatOn ?? true;
let voteSortOn = savedSettings.voteSortOn ?? true;
let chatAiSettings = normalizeChatAiSettings(savedSettings.chatAi || {});
state.setVoteSort(voteSortOn);

const chatMessages = chatRepo.listRecent("default_event", 40);
const chatLastSentAt = new WeakMap();
const rankChatLastText = new Map();

let feedbackItems = [];
try {
  const storedFeedback = JSON.parse(readFileSync(FEEDBACK_PATH, "utf8"));
  feedbackItems = Array.isArray(storedFeedback) ? storedFeedback : [];
} catch {
  /* first run — no feedback yet */
}
let feedbackDigest = savedSettings.feedbackDigest && typeof savedSettings.feedbackDigest === "object"
  ? savedSettings.feedbackDigest
  : null;

function saveSettings() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(
      SETTINGS_PATH,
      JSON.stringify(
        {
          filterOn,
          moderationMode,
          eventContext,
          cooldownSeconds,
          queueLimitOn,
          queueLimit,
          requireName,
          feedbackOn,
          chatOn,
          voteSortOn,
          chatAi: chatAiSettings,
          feedbackDigest,
        },
        null,
        2
      )
    );
  } catch (err) {
    console.warn(`[settings] unable to save: ${err.message}`);
  }
}

function saveFeedback() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FEEDBACK_PATH, JSON.stringify(feedbackItems, null, 2));
  } catch (err) {
    console.warn(`[feedback] unable to save: ${err.message}`);
  }
}

function feedbackStats() {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  return {
    total: feedbackItems.length,
    today: feedbackItems.filter((item) => now - Date.parse(item.createdAt) < day).length,
    last7Days: feedbackItems.filter((item) => now - Date.parse(item.createdAt) < 7 * day).length,
  };
}

const app = express();
app.set("trust proxy", true);
app.use(express.json());
app.use(createAuthMiddleware(db));

// --- Host authentication (Basic Auth or admin session) ---------------------
const HOST_PASSWORD = process.env.HOST_PASSWORD || "";
const hostToken = randomUUID();

function requireHostAuth(req, res, next) {
  if (req.user && req.user.role === "admin" && req.user.status === "active") {
    return next();
  }
  if (!HOST_PASSWORD) return next();
  const b64 = (req.headers.authorization || "").split(" ")[1] || "";
  const pass = Buffer.from(b64, "base64").toString().split(":").slice(1).join(":");
  if (pass === HOST_PASSWORD) return next();
  res.set("WWW-Authenticate", 'Basic realm="Event Music Host"').status(401).send("Yêu cầu mật khẩu.");
}

app.use("/host.html", requireHostAuth);
app.get("/feedback.html", (_req, res) => res.redirect(302, "/admin#feedback"));

app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
  })
);

// --- AUTHENTICATION AND MEMBER API -----------------------------------------

const loginIpLimit = createFixedWindowRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 60,
  key: (req) => req.ip,
  reason: "Có quá nhiều lần đăng nhập từ mạng này. Vui lòng thử lại sau.",
});
const loginUsernameLimit = createFixedWindowRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  key: (req) => (req.body?.username || "").toString().trim().toLowerCase(),
  reason: "Tên đăng nhập này đã được thử quá nhiều lần. Vui lòng thử lại sau.",
});
const registerIpLimit = createFixedWindowRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  key: (req) => req.ip,
  reason: "Mạng này đã tạo quá nhiều tài khoản. Vui lòng thử lại sau.",
});
const registerGlobalLimit = createFixedWindowRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 300,
  key: () => "global",
  reason: "Hệ thống đang tạm giới hạn đăng ký mới. Vui lòng thử lại sau.",
});
const passwordIpLimit = createFixedWindowRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  key: (req) => req.ip,
  reason: "Có quá nhiều lần thử đổi mật khẩu từ mạng này. Vui lòng thử lại sau.",
});
const passwordUserLimit = createFixedWindowRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  key: (req) => req.user?.id,
  reason: "Bạn đã thử đổi mật khẩu quá nhiều lần. Vui lòng thử lại sau.",
});

app.post("/api/auth/register", registerIpLimit, registerGlobalLimit, async (req, res) => {
  const { username, password, displayName } = req.body || {};
  if (!username || typeof username !== "string" || username.trim().length < 3 || username.trim().length > 30) {
    return res.status(400).json({ ok: false, reason: "Tên đăng nhập phải từ 3 đến 30 ký tự." });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username.trim())) {
    return res.status(400).json({ ok: false, reason: "Tên đăng nhập chỉ chứa chữ cái, số và dấu gạch dưới." });
  }
  if (!password || typeof password !== "string" || password.length < 6) {
    return res.status(400).json({ ok: false, reason: "Mật khẩu phải có tối thiểu 6 ký tự." });
  }
  if (displayName !== undefined && typeof displayName !== "string") {
    return res.status(400).json({ ok: false, reason: "Tên hiển thị không hợp lệ." });
  }

  const existing = userRepo.findByUsername(username.trim());
  if (existing) {
    return res.status(409).json({ ok: false, reason: "Tên đăng nhập đã tồn tại." });
  }

  try {
    const passwordHash = await hashPasswordAsync(password);
    const registration = db.transaction(() => {
      const user = userRepo.create({
        username: username.trim(),
        passwordHash,
        displayName: (displayName || username).trim().slice(0, 40),
        role: "user",
      });
      const token = generateSessionToken();
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      sessionRepo.create(user.id, token, expiresAt);
      return { user, token };
    });
    const { user, token } = registration.immediate();
    setSessionCookie(res, token, req);

    res.json({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        pointsBalance: user.points_balance,
        currentStreak: user.current_streak,
        rank: publicRank(user.id),
      },
    });
  } catch (err) {
    if (String(err.message).includes("UNIQUE constraint failed: users.username")) {
      return res.status(409).json({ ok: false, reason: "Tên đăng nhập đã tồn tại." });
    }
    res.status(500).json({ ok: false, reason: "Không thể tạo tài khoản lúc này." });
  }
});

app.post("/api/auth/login", loginIpLimit, loginUsernameLimit, async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== "string" || typeof password !== "string" || !username.trim() || !password) {
    return res.status(400).json({ ok: false, reason: "Vui lòng nhập tên đăng nhập và mật khẩu." });
  }

  try {
    const user = userRepo.findByUsername(username);
    if (!user || !(await verifyPasswordAsync(password, user.password_hash))) {
      return res.status(401).json({ ok: false, reason: "Tên đăng nhập hoặc mật khẩu không chính xác." });
    }

    if (user.status === "blocked") {
      return res.status(403).json({ ok: false, reason: "Tài khoản của bạn đã bị khóa." });
    }

    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    sessionRepo.create(user.id, token, expiresAt);
    setSessionCookie(res, token, req);

    res.json({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        pointsBalance: user.points_balance,
        currentStreak: user.current_streak,
        rank: publicRank(user.id),
      },
    });
  } catch {
    res.status(500).json({ ok: false, reason: "Không thể đăng nhập lúc này." });
  }
});

app.post("/api/auth/logout", (req, res) => {
  if (req.sessionToken) {
    sessionRepo.delete(req.sessionToken);
    revokeSessionSocket(req.sessionToken, "Phiên đăng nhập đã kết thúc.");
  }
  clearSessionCookie(res, req);
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  if (!req.user) {
    return res.json({ ok: true, authenticated: false, user: null });
  }

  const today = getLocalDate();
  const hasCheckedInToday = req.user.lastCheckinDate === today;
  const activeDrop = dropRepo.getActiveClaimableDrop();
  const alreadyClaimedDrop = activeDrop ? dropRepo.hasUserClaimed(activeDrop.id, req.user.id) : false;

  res.json({
    ok: true,
    authenticated: true,
    user: {
      id: req.user.id,
      username: req.user.username,
      displayName: req.user.displayName,
      role: req.user.role,
      status: req.user.status,
      pointsBalance: req.user.pointsBalance,
      currentStreak: req.user.currentStreak,
      hasCheckedInToday,
      activeClaimableDrop: activeDrop && !alreadyClaimedDrop ? { id: activeDrop.id, title: activeDrop.title, points: activeDrop.points } : null,
      votedQueueItemIds: queueRepo.listActiveVoteItemIds(req.user.id),
      rank: publicRank(req.user.id),
    },
  });
});

app.get("/api/me/rank", requireAuth, (req, res) => {
  res.json({ ok: true, rank: publicRank(req.user.id) });
});

app.get("/api/me/rank/activity", requireAuth, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "50", 10)));
  const activity = rankRepo.listActivity(req.user.id, { limit, offset: (page - 1) * limit });
  res.json({ ok: true, page, limit, activity });
});

app.patch("/api/me/profile", requireAuth, (req, res) => {
  const { displayName } = req.body || {};
  if (typeof displayName !== "string") {
    return res.status(400).json({ ok: false, reason: "Tên hiển thị không hợp lệ." });
  }

  const cleanDisplayName = displayName.trim();
  if (cleanDisplayName.length < 1 || cleanDisplayName.length > 40) {
    return res.status(400).json({ ok: false, reason: "Tên hiển thị phải từ 1 đến 40 ký tự." });
  }

  const user = userRepo.updateDisplayName(req.user.id, cleanDisplayName);
  notifyUserProfile(user.id, user.display_name);
  res.json({
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
    },
  });
});

app.post(
  "/api/me/password",
  requireAuth,
  passwordIpLimit,
  passwordUserLimit,
  async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
      return res.status(400).json({ ok: false, reason: "Vui lòng nhập đầy đủ mật khẩu hiện tại và mật khẩu mới." });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ ok: false, reason: "Mật khẩu mới phải có tối thiểu 6 ký tự." });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ ok: false, reason: "Mật khẩu mới phải khác mật khẩu hiện tại." });
    }

    try {
      const user = userRepo.findById(req.user.id);
      if (!user || !(await verifyPasswordAsync(currentPassword, user.password_hash))) {
        return res.status(400).json({ ok: false, reason: "Mật khẩu hiện tại không chính xác." });
      }

      const passwordHash = await hashPasswordAsync(newPassword);
      const nextToken = generateSessionToken();
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const rotateSession = db.transaction(() => {
        userRepo.updatePasswordHash(user.id, passwordHash);
        sessionRepo.deleteByUserId(user.id);
        sessionRepo.create(user.id, nextToken, expiresAt);
      });
      rotateSession.immediate();

      setSessionCookie(res, nextToken, req);
      rotateUserSockets(user.id, req.sessionToken, nextToken);
      res.json({ ok: true, message: "Đã đổi mật khẩu." });
    } catch {
      res.status(500).json({ ok: false, reason: "Không thể đổi mật khẩu lúc này." });
    }
  }
);

// --- CHECK-IN AND POINT-DROP API -------------------------------------------

app.post("/api/me/checkin", requireAuth, (req, res) => {
  try {
    const result = performCheckin(db, req.user.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, reason: err.message });
  }
});

app.get("/api/me/points/history", requireAuth, (req, res) => {
  const direction = (req.query.direction || "all").toString();
  if (!["all", "earned", "spent"].includes(direction)) {
    return res.status(400).json({ ok: false, reason: "Bộ lọc lịch sử điểm không hợp lệ." });
  }
  const parsedPage = parseInt(req.query.page || "1", 10);
  const parsedLimit = parseInt(req.query.limit || "20", 10);
  const page = Number.isFinite(parsedPage) ? Math.max(1, parsedPage) : 1;
  const limit = Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 20;
  const offset = (page - 1) * limit;

  const result = ledgerRepo.listByUser(req.user.id, { limit, offset, direction });
  res.json({ ok: true, page, limit, direction, total: result.total, ledger: result.ledger });
});

app.get("/api/me/votes/active", requireAuth, (req, res) => {
  const activeVoteRows = queueRepo.listActiveVotesByUser(req.user.id);
  const pointsByQueueItem = new Map(
    activeVoteRows.map((row) => [row.queue_item_id, row.points_spent])
  );
  const votes = state
    .snapshot()
    .queue.map((item, index) => ({ item, queuePosition: index + 1 }))
    .filter(({ item }) => pointsByQueueItem.has(item.id))
    .map(({ item, queuePosition }) => ({
      queueItemId: item.id,
      title: item.title,
      channel: item.channel,
      thumbnail: item.thumbnail,
      pointsSpent: pointsByQueueItem.get(item.id),
      voteScore: item.voteScore,
      queuePosition,
    }));

  res.json({ ok: true, votes });
});

app.get("/api/me/point-drops/active", (req, res) => {
  const drop = dropRepo.getActiveClaimableDrop();
  if (!drop) return res.json({ ok: true, drop: null, alreadyClaimed: false });

  const alreadyClaimed = req.user ? dropRepo.hasUserClaimed(drop.id, req.user.id) : false;
  res.json({
    ok: true,
    drop: { id: drop.id, title: drop.title, points: drop.points, createdAt: drop.created_at },
    alreadyClaimed,
  });
});

app.post("/api/me/point-drops/:dropId/claim", requireAuth, (req, res) => {
  try {
    const result = dropRepo.claimDrop(req.params.dropId, req.user.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, reason: err.message });
  }
});

// --- VOTING API -------------------------------------------------------------

app.post("/api/queue/:itemId/vote", requireAuth, (req, res) => {
  try {
    const result = state.vote(req.params.itemId, req.user.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, reason: err.message });
  }
});

// --- SYSTEM AND YOUTUBE API ------------------------------------------------

app.get("/api/info", async (_req, res) => {
  try {
    const qr = await QRCode.toDataURL(GUEST_URL, { width: 480, margin: 1 });
    res.json({
      guestUrl: GUEST_URL,
      qr,
      filterOn,
      moderationMode,
      moderationConfigured: moderationConfigured(),
      queueLimitOn,
      queueLimit,
      requireName,
      feedbackOn,
      chatOn,
      chatAiOn: chatAiSettings.enabled && chatOn,
      chatAiName: chatAiSettings.name,
      voteSortOn,
    });
  } catch {
    res.status(500).json({ error: "Không thể tạo mã QR." });
  }
});

const browseCache = new Map();
const BROWSE_TTL_MS = 30 * 60 * 1000;
const MAX_SINGLE_SECONDS = 10 * 60;
function durationSeconds(d) {
  if (!d || !/^[\d:]+$/.test(d)) return Infinity;
  return d.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
}

app.get("/api/browse", async (req, res) => {
  const q = (req.query.q || "").toString().trim().slice(0, 100);
  if (!q) return res.json({ results: [] });
  const hit = browseCache.get(q);
  if (hit && Date.now() - hit.at < BROWSE_TTL_MS) return res.json({ results: hit.results });
  try {
    const fetched =
      q === "__vn_hits"
        ? await fetchVietnamChartHits({ limit: 40 })
        : await searchYouTube(q, { limit: 40, mode: "songs" });
    const results = fetched
      .filter((r) => durationSeconds(r.duration) <= MAX_SINGLE_SECONDS)
      .slice(0, 20);
    browseCache.set(q, { at: Date.now(), results });
    if (browseCache.size > 200) browseCache.delete(browseCache.keys().next().value);
    res.json({ results });
  } catch (err) {
    console.error("[browse]", err.message);
    res.status(502).json({ error: "Không thể tải danh sách bài hát. Vui lòng thử lại." });
  }
});

const lastRequestAt = new Map();
function pruneLastRequestAt() {
  if (lastRequestAt.size <= 500) return;
  const cutoff = Date.now() - cooldownSeconds * 1000;
  for (const [key, at] of lastRequestAt) {
    if (at < cutoff) lastRequestAt.delete(key);
  }
}

const MAX_QUEUE_LENGTH = 50;

app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (!q) return res.json({ results: [] });
  try {
    const results = await searchYouTube(q);
    res.json({ results });
  } catch (err) {
    console.error("[search]", err.message);
    res.status(502).json({ error: "Tìm kiếm thất bại. Vui lòng thử lại." });
  }
});

app.post("/api/youtube/resolve", async (req, res) => {
  const rawUrl = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!rawUrl) return res.status(400).json({ ok: false, reason: "Vui lòng dán link YouTube." });

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return res.status(400).json({ ok: false, reason: "Link YouTube không đúng định dạng." });
  }
  const host = parsedUrl.hostname.toLowerCase();
  if (!["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host)) {
    return res.status(400).json({ ok: false, reason: "Hiện tại chỉ hỗ trợ link YouTube." });
  }

  const videoId = parseYouTubeVideoId(rawUrl);
  if (!videoId) return res.status(400).json({ ok: false, reason: "Link YouTube không đúng định dạng." });
  const song = await fetchYouTubeMetadata(videoId);
  if (!song) return res.status(502).json({ ok: false, reason: "Không thể lấy thông tin video này. Vui lòng thử lại." });
  res.json({ ok: true, song });
});

app.get("/api/host-token", requireHostAuth, (req, res) => {
  const isAdminSession = req.user?.role === "admin" && req.user?.status === "active";
  res.json({ token: HOST_PASSWORD && !isAdminSession ? hostToken : "" });
});

app.post("/api/request", async (req, res) => {
  const { videoId, title, channel, duration, thumbnail, name, clientId } = req.body || {};
  const requesterId = (clientId || "").toString().slice(0, 64);
  const requesterName = (name || req.user?.displayName || "").toString().trim().slice(0, 40);
  if (requireName && !requesterName) {
    return res.json({ ok: false, reason: "Vui lòng nhập tên để thêm bài hát." });
  }
  const floodKey = `${req.ip}|${requesterId}`;
  const last = lastRequestAt.get(floodKey);
  if (cooldownSeconds > 0 && last) {
    const waitMs = cooldownSeconds * 1000 - (Date.now() - last);
    if (waitMs > 0) {
      const retryIn = Math.ceil(waitMs / 1000);
      return res.json({ ok: false, reason: `Vui lòng chờ — thử lại sau ${retryIn} giây.`, retryIn });
    }
  }

  if (!videoId || !title) {
    return res.status(400).json({ ok: false, reason: "Thiếu thông tin bài hát." });
  }

  if (state.queue.length >= MAX_QUEUE_LENGTH || (queueLimitOn && state.queue.length >= queueLimit)) {
    return res.json({ ok: false, reason: "Hàng đợi đã đầy — vui lòng thử lại sau khi phát bớt bài." });
  }

  if (state.has(videoId)) {
    return res.json({ ok: false, reason: "Bài hát này đã có trong hàng đợi!" });
  }

  lastRequestAt.set(floodKey, Date.now());
  pruneLastRequestAt();

  const playable = await checkPlayable(videoId);
  if (!playable.ok) {
    return res.json({ ok: false, reason: playable.reason });
  }

  if (filterOn) {
    const details = await fetchVideoDetails(videoId);
    const verdict = await moderate({ title, channel }, details, {
      strict: moderationMode === "strict",
      ...(eventContext ? { eventContext } : {}),
    });
    if (!verdict.approved) {
      return res.json({ ok: false, reason: verdict.reason });
    }
  }

  if (state.queue.length >= MAX_QUEUE_LENGTH || (queueLimitOn && state.queue.length >= queueLimit)) {
    return res.json({ ok: false, reason: "Hàng đợi đã đầy — vui lòng thử lại sau khi phát bớt bài." });
  }
  if (state.has(videoId)) {
    return res.json({ ok: false, reason: "Bài hát này đã có trong hàng đợi!" });
  }

  const { item, position } = state.add({
    videoId,
    title,
    channel,
    duration,
    thumbnail,
    addedBy: requesterName,
    requesterId,
    userId: req.user?.id || null,
  });
  res.json({ ok: true, reason: "Đã thêm!", position, id: item.id });
});

// --- ADMIN API (/api/admin/*) -----------------------------------------------

app.get("/api/admin/users", requireAdmin, (req, res) => {
  const search = (req.query.search || "").toString().trim();
  const status = (req.query.status || "").toString().trim();
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "50", 10)));
  const offset = (page - 1) * limit;

  const result = userRepo.listUsers({ search, status, limit, offset });
  res.json({ ok: true, page, limit, ...result, users: result.users.map((user) => ({ ...user, rank: publicRank(user.id) })) });
});

app.get("/api/admin/rank/leaderboard", requireAdmin, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "50", 10)));
  const eventId = (req.query.eventId || "").toString().trim() || null;
  const leaderboard = rankRepo.listLeaderboard({ eventId, limit, offset: (page - 1) * limit });
  res.json({ ok: true, page, limit, eventId, leaderboard });
});

app.post("/api/admin/users/:id/points", requireAdmin, (req, res) => {
  const delta = Number(req.body?.delta);
  const reason = (req.body?.reason || "").toString().trim();
  if (!Number.isSafeInteger(delta) || delta === 0) {
    return res.status(400).json({ ok: false, reason: "Số điểm thay đổi không hợp lệ." });
  }
  if (!reason) {
    return res.status(400).json({ ok: false, reason: "Vui lòng nhập lý do điều chỉnh điểm." });
  }

  try {
    const actorId = req.user?.id || null;
    const result = userRepo.updatePoints(req.params.id, delta, {
      type: "admin_adjustment",
      actorUserId: actorId,
      reason,
    });
    notifyUserBalance(req.params.id, result.points_balance, { delta, reason });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, reason: err.message });
  }
});

app.patch("/api/admin/users/:id", requireAdmin, (req, res) => {
  const { status, role } = req.body || {};
  try {
    let user = userRepo.findById(req.params.id);
    if (!user) return res.status(404).json({ ok: false, reason: "Không tìm thấy người dùng." });
    if (req.params.id === req.user.id && status === "blocked") {
      return res.status(400).json({ ok: false, reason: "Bạn không thể tự khóa tài khoản quản trị đang đăng nhập." });
    }
    if (req.params.id === req.user.id && role && role !== "admin") {
      return res.status(400).json({ ok: false, reason: "Bạn không thể tự hạ quyền tài khoản quản trị đang đăng nhập." });
    }

    const shouldRevoke = (status === "blocked" && user.status !== "blocked") ||
      (role === "user" && user.role === "admin");
    if (status && ["active", "blocked"].includes(status)) {
      user = userRepo.updateStatus(req.params.id, status);
    }
    if (role && ["user", "admin"].includes(role)) {
      user = userRepo.updateRole(req.params.id, role);
    }
    if (shouldRevoke) {
      sessionRepo.deleteByUserId(req.params.id);
      revokeUserSockets(req.params.id, "Quyền truy cập của tài khoản đã thay đổi.");
    }
    res.json({ ok: true, user });
  } catch (err) {
    res.status(400).json({ ok: false, reason: err.message });
  }
});

app.get("/api/admin/users/:id/ledger", requireAdmin, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "50", 10)));
  const offset = (page - 1) * limit;

  const result = ledgerRepo.listByUser(req.params.id, { limit, offset });
  res.json({ ok: true, page, limit, ...result });
});

app.post("/api/admin/point-drops", requireAdmin, (req, res) => {
  const { type, title, points } = req.body || {};
  const cleanTitle = typeof title === "string" ? title.trim() : "";
  const numPoints = Number(points);
  if (!Number.isSafeInteger(numPoints) || numPoints <= 0 || numPoints > 1000) {
    return res.status(400).json({ ok: false, reason: "Số điểm phải là số nguyên từ 1 đến 1000." });
  }

  const actorId = req.user.id;

  if (type === "direct") {
    const reason = cleanTitle || "Airdrop từ Ban Quản Trị";
    const result = dropRepo.createDirectAirdrop({ points: numPoints, reason, createdByUserId: actorId });

    // WebSocket broadcast airdrop event
    const msg = JSON.stringify({ type: "airdropDirect", points: numPoints, reason });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(msg);
    }

    return res.json({ ok: true, type: "direct", ...result });
  }

  if (type === "claimable") {
    if (!cleanTitle) {
      return res.status(400).json({ ok: false, reason: "Vui lòng nhập tiêu đề đợt nhận điểm." });
    }
    const drop = dropRepo.createClaimableDrop({ title: cleanTitle, points: numPoints, createdByUserId: actorId });

    // WebSocket broadcast claimable drop event
    const msg = JSON.stringify({ type: "pointDropAvailable", drop: { id: drop.id, title: drop.title, points: drop.points } });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(msg);
    }

    return res.json({ ok: true, type: "claimable", drop });
  }

  res.status(400).json({ ok: false, reason: "Hình thức phát điểm không hợp lệ." });
});

app.get("/api/admin/point-drops", requireAdmin, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "50", 10)));
  const offset = (page - 1) * limit;

  const result = dropRepo.listDrops({ limit, offset });
  res.json({ ok: true, page, limit, ...result });
});

app.get("/api/admin/ledger", requireAdmin, (req, res) => {
  const search = (req.query.search || "").toString().trim();
  const type = (req.query.type || "").toString().trim();
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "50", 10)));
  const offset = (page - 1) * limit;

  const result = ledgerRepo.listAll({ search, type, limit, offset });
  res.json({ ok: true, page, limit, ...result });
});

// --- FEEDBACK AND CHAT -----------------------------------------------------

const feedbackLastSubmittedAt = new Map();
app.post("/api/feedback", (req, res) => {
  if (!feedbackOn) return res.status(403).json({ ok: false, reason: "Tính năng góp ý hiện đang tắt." });
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 40) : "";
  const content = typeof req.body?.content === "string" ? req.body.content.trim().slice(0, 1000) : "";
  if (!name || !content) return res.status(400).json({ ok: false, reason: "Vui lòng nhập tên và nội dung góp ý." });
  const last = feedbackLastSubmittedAt.get(req.ip) || 0;
  if (Date.now() - last < 30_000) {
    return res.status(429).json({ ok: false, reason: "Bạn vừa gửi góp ý. Vui lòng thử lại sau ít phút." });
  }
  const item = { id: randomUUID(), name, content, createdAt: new Date().toISOString() };
  feedbackItems.unshift(item);
  if (feedbackItems.length > 1000) feedbackItems.length = 1000;
  feedbackLastSubmittedAt.set(req.ip, Date.now());
  saveFeedback();
  res.json({ ok: true });
});

app.get("/api/feedback", requireAdmin, (_req, res) => {
  res.json({ feedbackOn, chatOn, stats: feedbackStats(), items: feedbackItems });
});

app.patch("/api/feedback/settings", requireAdmin, (req, res) => {
  const hasFeedbackSetting = typeof req.body?.on === "boolean";
  const hasChatSetting = typeof req.body?.chatOn === "boolean";
  if (!hasFeedbackSetting && !hasChatSetting) {
    return res.status(400).json({ ok: false, reason: "Giá trị không hợp lệ." });
  }
  if (hasFeedbackSetting) feedbackOn = req.body.on;
  if (hasChatSetting) {
    chatOn = req.body.chatOn;
    if (!chatOn) {
      chatAiCoordinator.reset();
      chatMessages.length = 0;
      chatRepo.clear();
      chatAiMemoryRepo.clearConversationState();
      const message = JSON.stringify({ type: "chatCleared" });
      for (const client of wss.clients) {
        if (client.readyState === 1) client.send(message);
      }
    }
  }
  saveSettings();
  broadcastState();
  res.json({ ok: true, feedbackOn, chatOn });
});

app.delete("/api/feedback/:id", requireAdmin, (req, res) => {
  const before = feedbackItems.length;
  feedbackItems = feedbackItems.filter((item) => item.id !== req.params.id);
  if (feedbackItems.length === before) return res.status(404).json({ ok: false, reason: "Không tìm thấy góp ý." });
  saveFeedback();
  res.json({ ok: true });
});

app.delete("/api/chat", requireAdmin, (_req, res) => {
  const cleared = chatMessages.length;
  chatAiCoordinator.reset();
  chatMessages.length = 0;
  chatRepo.clear();
  chatAiMemoryRepo.clearConversationState();
  const message = JSON.stringify({ type: "chatCleared" });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(message);
  }
  res.json({ ok: true, cleared });
});

app.get("/api/admin/chat-ai/settings", requireAdmin, (_req, res) => {
  res.json({
    ok: true,
    configured: chatAiConfigured(),
    settings: chatAiSettings,
    status: chatAiCoordinator.status(),
    summary: chatAiMemoryRepo.getSummary(),
    memories: chatAiMemoryRepo.listActive("default_event", 100),
    feedbackDigest,
  });
});

app.patch("/api/admin/chat-ai/settings", requireAdmin, (req, res) => {
  const patch = req.body && typeof req.body === "object" ? req.body : {};
  chatAiSettings = normalizeChatAiSettings({
    ...chatAiSettings,
    ...patch,
    features: { ...chatAiSettings.features, ...(patch.features || {}) },
  });
  if (!chatAiSettings.enabled) chatAiCoordinator.reset();
  saveSettings();
  broadcastState();
  res.json({ ok: true, configured: chatAiConfigured(), settings: chatAiSettings, status: chatAiCoordinator.status() });
});

app.post("/api/admin/chat-ai/kick", requireAdmin, (_req, res) => {
  if (!chatAiSettings.enabled) {
    return res.status(409).json({ ok: false, reason: "Hãy bật AI trước khi khuấy động." });
  }
  if (!chatOn) {
    return res.status(409).json({ ok: false, reason: "Phòng chat đang tắt." });
  }
  if (!chatAiConfigured()) {
    return res.status(409).json({ ok: false, reason: "Chưa cấu hình API key cho AI." });
  }
  void chatAiCoordinator.run("manual");
  res.json({ ok: true, accepted: true });
});

app.post("/api/admin/chat-ai/feedback-digest", requireAdmin, async (_req, res) => {
  if (!chatAiSettings.features.feedbackDigest) {
    return res.status(409).json({ ok: false, reason: "Hãy bật nhóm digest góp ý trong cấu hình AI trước." });
  }
  if (!chatAiConfigured()) {
    return res.status(409).json({ ok: false, reason: "Chưa cấu hình API key cho AI." });
  }
  try {
    const digest = await summarizeFeedback({ feedback: feedbackItems, settings: chatAiSettings });
    if (!digest) return res.status(502).json({ ok: false, reason: "AI chưa tạo được digest góp ý. Vui lòng thử lại." });
    feedbackDigest = { ...digest, generatedAt: new Date().toISOString() };
    saveSettings();
    res.json({ ok: true, digest: feedbackDigest });
  } catch {
    res.status(502).json({ ok: false, reason: "Không thể tạo digest góp ý lúc này." });
  }
});

app.patch("/api/admin/chat-ai/memories/:id", requireAdmin, (req, res) => {
  if (typeof req.body?.pinned !== "boolean") {
    return res.status(400).json({ ok: false, reason: "Giá trị ghim không hợp lệ." });
  }
  const updated = chatAiMemoryRepo.setPinned(req.params.id, req.body.pinned);
  if (!updated) return res.status(404).json({ ok: false, reason: "Không tìm thấy memory." });
  res.json({ ok: true });
});

app.delete("/api/admin/chat-ai/memories/:id", requireAdmin, (req, res) => {
  const deleted = chatAiMemoryRepo.delete(req.params.id);
  if (!deleted) return res.status(404).json({ ok: false, reason: "Không tìm thấy memory." });
  res.json({ ok: true });
});

app.delete("/api/admin/chat-ai/memory", requireAdmin, (_req, res) => {
  chatAiCoordinator.reset();
  chatAiMemoryRepo.clearConversationState();
  res.json({ ok: true });
});

// --- SERVE HTML PAGES ------------------------------------------------------

const BOOT_ID = Date.now().toString(36);
function versionedPage(name) {
  const filePath = path.join(__dirname, "public", name);
  if (!existsSync(filePath)) return `<!DOCTYPE html><html><body><h1>${name} not found</h1></body></html>`;
  return readFileSync(filePath, "utf8").replace(
    /(href|src)="\/((?:guest|host|feedback|admin|account|auth-utils)\.(?:css|js))"/g,
    `$1="/$2?v=${BOOT_ID}"`
  );
}

const HOST_PAGE = versionedPage("host.html");
const GUEST_PAGE = versionedPage("guest.html");
const ADMIN_PAGE = versionedPage("admin.html");
const ACCOUNT_PAGE = versionedPage("account.html");

app.get("/", requireHostAuth, (_req, res) => {
  res.set("Cache-Control", "no-cache").type("html").send(HOST_PAGE);
});

app.get("/guest", (_req, res) => {
  res.set("Cache-Control", "no-cache").type("html").send(GUEST_PAGE);
});

app.get("/admin", (_req, res) => {
  res.set("Cache-Control", "no-cache").type("html").send(ADMIN_PAGE);
});

app.get("/account", (_req, res) => {
  res.set("Cache-Control", "no-cache").type("html").send(ACCOUNT_PAGE);
});

app.get("/feedback", (_req, res) => {
  res.redirect(302, "/admin#feedback");
});

// --- WebSocket: REALTIME SYNC AND HOST CONTROLS ----------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcastChatMessage(message) {
  const payload = JSON.stringify({ type: "chatMessage", message });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

const chatAiCoordinator = new ChatAiCoordinator({
  chatRepository: chatRepo,
  memoryRepository: chatAiMemoryRepo,
  getSettings: () => chatAiSettings,
  getChatOn: () => chatOn,
  getRoomState: () => {
    const snapshot = state.snapshot();
    const recentPlayed = queueRepo.getRecentPlayed("default_event", 20).map((item) => ({
      title: item.title,
      channel: item.channel || "",
      addedBy: item.added_by || "",
      playedAt: item.finished_at ? new Date(item.finished_at).toISOString() : null,
      playCount: 1,
    }));
    const counts = new Map();
    for (const item of recentPlayed) counts.set(item.title, (counts.get(item.title) || 0) + 1);
    const songTrends = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([title, plays]) => ({ title, plays }));
    return {
      ...snapshot,
      eventContext,
      queueCount: snapshot.queue.length + (snapshot.nowPlaying ? 1 : 0),
      queueStats: queueRepo.getQueueStats("default_event"),
      recentPlayed,
      songTrends,
      topVotes: queueRepo.getVoteLeaders("default_event", 10),
    };
  },
  onAiMessage: (message) => {
    pushRecentChat(chatMessages, message);
    broadcastChatMessage(message);
  },
});
chatAiCoordinator.start();

function stateMessage() {
  return JSON.stringify({
    type: "state",
    state: publicStateSnapshot(),
    filterOn,
    moderationMode,
    cooldownSeconds,
    eventContext,
    queueLimitOn,
    queueLimit,
    requireName,
    feedbackOn,
    chatOn,
    chatAiOn: chatAiSettings.enabled && chatOn,
    chatAiName: chatAiSettings.name,
    voteSortOn,
  });
}

function broadcastState() {
  const msg = stateMessage();
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}
state.onChange = (nextState) => {
  broadcastState();
  chatAiCoordinator.scheduleQueueChange({
    queueCount: nextState.queue?.length || 0,
    nowPlaying: nextState.nowPlaying?.title || null,
    topQueue: (nextState.queue || []).slice(0, 3).map((item) => item.title),
  });
};

function notifyUserBalance(userId, newBalance, { delta = 0, reason = "" } = {}) {
  const msg = JSON.stringify({ type: "balanceUpdated", newBalance, delta, reason });
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    const session = refreshSocketIdentity(client, sessionRepo);
    if (session?.user_id === userId) client.send(msg);
  }
}

function revokeSessionSocket(sessionToken, reason) {
  for (const client of wss.clients) {
    if (client.sessionToken === sessionToken) revokeSocket(client, reason);
  }
}

function revokeUserSockets(userId, reason) {
  for (const client of wss.clients) {
    if (client.userId === userId) revokeSocket(client, reason);
  }
}

function rotateUserSockets(userId, previousToken, nextToken) {
  for (const client of wss.clients) {
    if (client.userId !== userId) continue;
    if (client.sessionToken === previousToken) {
      client.sessionToken = nextToken;
      refreshSocketIdentity(client, sessionRepo);
      if (client.readyState === 1) client.send(JSON.stringify({ type: "sessionRotated" }));
    } else {
      revokeSocket(client, "Mật khẩu đã được thay đổi trên thiết bị khác.");
    }
  }
}

function notifyUserProfile(userId, displayName) {
  const msg = JSON.stringify({ type: "profileUpdated", displayName });
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    const session = refreshSocketIdentity(client, sessionRepo);
    if (session?.user_id === userId) client.send(msg);
  }
}

function notifyUserRank(userId, rank) {
  const msg = JSON.stringify({ type: "rankUpdated", rank });
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    const session = refreshSocketIdentity(client, sessionRepo);
    if (session?.user_id === userId) client.send(msg);
  }
}

function recordRankChatActivity(message, userId) {
  if (!message || !userId) return;
  const normalizedText = String(message.text || "").trim().toLocaleLowerCase("vi-VN");
  const now = Date.now();
  const previous = rankChatLastText.get(userId);
  const isRepeated = previous && previous.text === normalizedText && now - previous.at < 90_000;
  rankChatLastText.set(userId, { text: normalizedText, at: now });
  if (rankChatLastText.size > 1000) {
    for (const [key, value] of rankChatLastText) {
      if (now - value.at > 30 * 60 * 1000) rankChatLastText.delete(key);
    }
  }
  const activity = rankRepo.recordChatActivity({
    userId,
    createdAt: message.createdAt,
    isSpam: !!isRepeated,
  });
  if (!activity.awardedXp) return;
  const award = rankRepo.awardXp({
    userId,
    activityType: "chat_window",
    sourceId: `${activity.windowStart}:${activity.xpAwarded}`,
    deltaXp: activity.awardedXp,
    metadata: { windowStart: activity.windowStart, messageCount: activity.messageCount },
  });
  if (award.awarded) {
    notifyUserRank(userId, publicRank(userId));
    broadcastState();
  }
}

function settleRankTransition(transition) {
  const finishedItem = transition?.finishedItem;
  if (!finishedItem || transition.finalStatus !== "played") return;
  const qualified = isQualifiedPlay({
    finishReason: transition.finishReason,
    playedSeconds: transition.playedSeconds,
    duration: finishedItem.duration,
  });
  if (!qualified) return;

  const updatedUsers = new Map();
  if (finishedItem.addedByUserId) {
    const playAward = rankRepo.awardQualifiedPlay({
      userId: finishedItem.addedByUserId,
      queueItemId: finishedItem.id,
      title: finishedItem.title,
      playedSeconds: transition.playedSeconds,
    });
    if (playAward.awarded) updatedUsers.set(finishedItem.addedByUserId, playAward.profile);
  }

  // A voter earns one participation XP for a qualifying played item. The
  // repository's idempotency key prevents repeated host events from farming XP
  // and deliberately ignores additional points spent on the same item.
  for (const voter of transition.voters || []) {
    const award = rankRepo.awardVoteParticipation({
      userId: voter.user_id,
      queueItemId: finishedItem.id,
      title: finishedItem.title,
    });
    if (award.awarded) updatedUsers.set(voter.user_id, award.profile);
  }
  for (const [userId, profile] of updatedUsers) notifyUserRank(userId, publicRank(userId));
  if (updatedUsers.size) broadcastState();
}

function revokeSocket(client, reason) {
  if (client.readyState === 1) client.send(JSON.stringify({ type: "sessionRevoked", reason }));
  client.sessionToken = null;
  client.userId = null;
  client.isAdmin = false;
  client.close(4003, "Session revoked");
}

state.onBalanceChange = ({ userId, newBalance, pointsRefunded, reason }) => {
  notifyUserBalance(userId, newBalance, { delta: pointsRefunded, reason });
};

wss.on("connection", (ws, request) => {
  ws.sessionToken = getSessionTokenFromCookieHeader(request.headers.cookie);
  ws.hostAuthenticated = !HOST_PASSWORD;
  refreshSocketIdentity(ws, sessionRepo);

  ws.send(stateMessage());
  if (chatOn && chatMessages.length) {
    ws.send(JSON.stringify({ type: "chatHistory", messages: chatMessages }));
  }

  ws.on("message", (raw) => {
    if (raw.length > 4000) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const currentSession = refreshSocketIdentity(ws, sessionRepo);

    if (msg.type === "auth") {
      if (!HOST_PASSWORD || msg.token === hostToken) ws.hostAuthenticated = true;
      return;
    }

    if (msg.type === "chatSend") {
      if (!chatOn) {
        ws.send(JSON.stringify({ type: "chatSendResult", ok: false, reason: "Tính năng chat hiện đang tắt." }));
        return;
      }
      const isAdmin = msg.admin === true;
      if (isAdmin && currentSession?.role !== "admin") {
        ws.send(JSON.stringify({ type: "chatSendResult", ok: false, reason: "Bạn không có quyền gửi tin nhắn admin." }));
        return;
      }
      const parsed = parseChatInput(msg);
      if (!parsed.ok) {
        ws.send(JSON.stringify({ type: "chatSendResult", ok: false, reason: parsed.reason }));
        return;
      }
      const now = Date.now();
      const last = chatLastSentAt.get(ws) || 0;
      if (now - last < CHAT_MIN_INTERVAL_MS) {
        ws.send(JSON.stringify({ type: "chatSendResult", ok: false, reason: "Bạn gửi hơi nhanh. Vui lòng chờ một chút." }));
        return;
      }
      const message = chatRepo.create({
        id: randomUUID(),
        name: parsed.name,
        text: parsed.text,
        senderId: (msg.clientId || "").toString().slice(0, 64),
        userId: currentSession?.user_id || null,
        isAdmin,
        isAI: false,
        createdAt: new Date().toISOString(),
      });
      const publicMessage = currentSession?.user_id
        ? { ...message, rank: publicRank(currentSession.user_id) }
        : message;
      pushRecentChat(chatMessages, publicMessage);
      recordRankChatActivity(message, currentSession?.user_id);
      chatLastSentAt.set(ws, now);
      broadcastChatMessage(publicMessage);
      ws.send(JSON.stringify({ type: "chatSendResult", ok: true, id: message.id }));
      chatAiCoordinator.schedule(message);
      return;
    }

    if (msg.type === "removeOwn") {
      const id = typeof msg.id === "string" ? msg.id : "";
      const removed = state.removeOwned(id, (msg.clientId || "").toString().slice(0, 64), ws.userId);
      ws.send(JSON.stringify({
        type: "removeOwnResult",
        id,
        ok: removed,
        ...(removed ? {} : { reason: "Bài hát không còn trong hàng đợi hoặc không thuộc về bạn." }),
      }));
      return;
    }

    if (!canUseHostControls(ws, currentSession)) return;

    switch (msg.type) {
      case "ended":
        console.log(`[host] finished playing ${msg.videoId}`);
        settleRankTransition(state.advance(msg.videoId, { finishReason: "ended" }));
        break;
      case "error":
        console.warn(`[host] playback error ${msg.code} on ${msg.videoId} — skipping and refunding points`);
        settleRankTransition(state.advance(msg.videoId, { isError: true, finishReason: "error" }));
        break;
      case "skip":
        settleRankTransition(state.skip({ playedSeconds: msg.playedSeconds }));
        break;
      case "remove":
        state.remove(msg.id);
        break;
      case "move":
        state.move(msg.id, msg.dir);
        break;
      case "reorder":
        state.reorder(msg.id, msg.beforeId);
        break;
      case "unpin":
        state.unpin(msg.id);
        break;
      case "setVoteSort":
        voteSortOn = !!msg.on;
        state.setVoteSort(voteSortOn);
        saveSettings();
        broadcastState();
        break;
      case "setFilter":
        filterOn = !!msg.on;
        if (msg.mode === "strict" || msg.mode === "default") moderationMode = msg.mode;
        saveSettings();
        broadcastState();
        break;
      case "setCooldown": {
        const s = Math.round(Number(msg.seconds));
        if (Number.isFinite(s) && s >= 0 && s <= 300) {
          cooldownSeconds = s;
          saveSettings();
          broadcastState();
        }
        break;
      }
      case "setEventContext":
        eventContext = (msg.context || "").toString().slice(0, 300);
        saveSettings();
        broadcastState();
        break;
      case "setQueueLimit": {
        const nextLimit = Number(msg.limit);
        if (typeof msg.on === "boolean") queueLimitOn = msg.on;
        if (QUEUE_LIMIT_STEPS.includes(nextLimit)) queueLimit = nextLimit;
        saveSettings();
        broadcastState();
        break;
      }
      case "setRequireName":
        requireName = !!msg.on;
        saveSettings();
        broadcastState();
        break;
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("\n  🎶  Office Jukebox is running\n");
  console.log(`  Projector (host) : http://localhost:${PORT}/`);
  console.log(`  Guest QR         : ${GUEST_URL}`);
  console.log(`  Admin            : http://localhost:${PORT}/admin`);
  console.log(
    `  Filter           : ${filterOn ? `ON (${moderationMode})` : "OFF"} (change from the host page) · ` +
      `LLM ${moderationConfigured() ? "configured" : "NOT CONFIGURED — filter approves everything"}`
  );
  console.log(
    `  Host password    : ${HOST_PASSWORD ? "SET — host page requires authentication" : "NOT SET — host page is public"}\n`
  );
  if (LAN_IP === "127.0.0.1") {
    console.warn("  ⚠  No LAN IP detected — guests on other devices cannot connect.\n");
  }
});
