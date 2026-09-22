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

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import QRCode from "qrcode";

import {
  searchYouTube,
  searchYouTubeByMode,
  fetchVietnamChartHits,
  checkPlayable,
  fetchVideoDetails,
  parseYouTubeVideoId,
  fetchYouTubeMetadata,
  sanitizeThumbnail,
  isValidYouTubeVideoId,
} from "./src/youtube.js";
import {
  parseSpotifyTrackId,
  isValidSpotifyTrackId,
  fetchSpotifyTrackMetadata,
  searchSpotifyTracks,
  buildSpotifyAuthorizeUrl,
  exchangeSpotifyCode,
  refreshSpotifyToken,
} from "./src/spotify.js";
import {
  parseSoundCloudUrl,
  isValidSoundCloudUrl,
  fetchSoundCloudMetadata,
} from "./src/soundcloud.js";
import { resolveMediaLink } from "./src/mediaLinkResolver.js";
import { fetchLyrics } from "./src/lyricsService.js";
import { avatarPublicUrl, validateAvatarUpload } from "./src/avatar.js";
import { prepareRequestSong } from "./src/requestPipeline.js";
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

import { initDb, closeDb } from "./src/db.js";
import { UserRepository } from "./src/repositories/userRepository.js";
import { SessionRepository } from "./src/repositories/sessionRepository.js";
import { LedgerRepository } from "./src/repositories/ledgerRepository.js";
import { QueueRepository } from "./src/repositories/queueRepository.js";
import { FavoriteRepository } from "./src/repositories/favoriteRepository.js";
import { DropRepository } from "./src/repositories/dropRepository.js";
import { ChatRepository } from "./src/repositories/chatRepository.js";
import { ChatAiMemoryRepository } from "./src/repositories/chatAiMemoryRepository.js";
import { RankRepository } from "./src/repositories/rankRepository.js";
import { EngagementRepository } from "./src/repositories/engagementRepository.js";
import { getEngagementRules, DEFAULT_EVENT_ID, CLAIMABLE_DROP_DURATION_PRESETS, DEFAULT_CLAIMABLE_DROP_DURATION_HOURS } from "./src/engagement.js";
import {
  NotificationRepository,
  NOTIFICATION_BODY_MAX_LENGTH,
  NOTIFICATION_KINDS,
  NOTIFICATION_TITLE_MAX_LENGTH,
  NOTIFICATION_USER_LIMIT,
} from "./src/repositories/notificationRepository.js";
import { RANK_LEVELS, isQualifiedPlay } from "./src/rank.js";
import { getWeeklyPeriod } from "./src/weeklyRank.js";
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
import { parsePagination } from "./src/pagination.js";
import { getClientIp, parseTrustProxy } from "./src/clientIp.js";
import { WebSocketRateLimiter } from "./src/websocketRateLimit.js";
import { parseDurationSeconds } from "./src/duration.js";
import { generateRandomPassword } from "./src/password.js";

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
const MAX_PASSWORD_LENGTH = 256;
const MAX_MODERATION_REASON_LENGTH = 200;
const MAX_POINT_DROP_TITLE_LENGTH = 200;
const LAN_IP = detectLanIp(process.env.HOST_IP);
const PUBLIC_BASE = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const GUEST_URL = PUBLIC_BASE ? `${PUBLIC_BASE}/guest` : `http://${LAN_IP}:${PORT}/guest`;
const SPOTIFY_CLIENT_ID = (process.env.SPOTIFY_CLIENT_ID || "").trim();
const SPOTIFY_CLIENT_SECRET = (process.env.SPOTIFY_CLIENT_SECRET || "").trim();
const SPOTIFY_REDIRECT_URI =
  (process.env.SPOTIFY_REDIRECT_URI || "").trim() ||
  (PUBLIC_BASE ? `${PUBLIC_BASE}/api/spotify/callback` : `http://${LAN_IP}:${PORT}/api/spotify/callback`);

// --- Initialize SQLite database and repositories (SSOT) --------------------
const db = initDb();
let rewardNotificationsOn = true;
let milestoneAnnouncementsOn = true;
const notificationRepo = new NotificationRepository(db);
const engagementRepo = new EngagementRepository(db, {
  notificationRepo,
  getNotificationsEnabled: () => rewardNotificationsOn,
});
const userRepo = new UserRepository(db, {
  notificationRepo,
  getNotificationsEnabled: () => rewardNotificationsOn,
});
const sessionRepo = new SessionRepository(db);
const ledgerRepo = new LedgerRepository(db);
const favoriteRepo = new FavoriteRepository(db);
const queueRepo = new QueueRepository(db, {
  notificationRepo,
  getNotificationsEnabled: () => rewardNotificationsOn,
});
const dropRepo = new DropRepository(db, {
  notificationRepo,
  getNotificationsEnabled: () => rewardNotificationsOn,
});
const chatRepo = new ChatRepository(db);
const chatAiMemoryRepo = new ChatAiMemoryRepository(db);
const rankRepo = new RankRepository(db, {
  notificationRepo,
  getNotificationsEnabled: () => rewardNotificationsOn,
  engagementRepo,
  createAnnouncementInTransaction: createEngagementAnnouncementMessagesInTransaction,
});
chatRepo.prune();
sessionRepo.pruneExpired();
const sessionPruneTimer = setInterval(() => sessionRepo.pruneExpired(), 6 * 60 * 60 * 1000);
sessionPruneTimer.unref?.();

if (!db.query("SELECT 1 FROM users WHERE role = 'admin' AND status = 'active' LIMIT 1").get()) {
  console.warn("[auth] No active admin account. Set ADMIN_USERNAME and ADMIN_PASSWORD before the first startup to create one.");
}

const state = new JukeboxState(db, {
  notificationRepo,
  getNotificationsEnabled: () => rewardNotificationsOn,
});

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
    checkinPoints: rank.checkinPoints,
  };
}

function publicRankBenefits() {
  return RANK_LEVELS.map((rank) => ({
    level: rank.level,
    minXp: rank.minXp,
    name: rank.name,
    badge: RANK_BADGE_ICONS[rank.badge] || "🎧",
    badgeId: rank.badge,
    checkinPoints: rank.checkinPoints,
  }));
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name ?? user.displayName,
    avatarUrl: avatarPublicUrl(user.avatar_file ?? user.avatarFile),
    role: user.role,
    status: user.status,
    pointsBalance: user.points_balance ?? user.pointsBalance,
    currentStreak: user.current_streak ?? user.currentStreak,
    rank: publicRank(user.id),
  };
}

function publicStateSnapshot() {
  const snapshot = state.snapshot();
  const byId = new Map([state.nowPlaying, ...state.queue].filter(Boolean).map((item) => [item.id, item]));
  const decorate = (item) => {
    if (!item) return null;
    const source = byId.get(item.id);
    const rank = source?.addedByUserId ? publicRank(source.addedByUserId) : null;
    const avatarUrl = source?.addedByUserId
      ? avatarPublicUrl(userRepo.findById(source.addedByUserId)?.avatar_file)
      : null;
    const thumbnail = sanitizeThumbnail(item.thumbnail);
    const safeItem = thumbnail === item.thumbnail ? item : { ...item, thumbnail };
    return { ...safeItem, ...(rank ? { rank } : {}), avatarUrl };
  };
  return { ...snapshot, nowPlaying: decorate(snapshot.nowPlaying), queue: snapshot.queue.map(decorate) };
}

// --- Persisted host settings ------------------------------------------------
const DATA_DIR = process.env.JUKEBOX_DATA_DIR || path.join(__dirname, "data");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const FEEDBACK_PATH = path.join(DATA_DIR, "feedback.json");
const AVATAR_DIR = path.join(DATA_DIR, "avatars");
let savedSettings = {};
try {
  savedSettings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
} catch (err) {
  if (err?.code !== "ENOENT") console.warn(`[settings] unable to read saved settings: ${err.message}`);
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
rewardNotificationsOn = savedSettings.rewardNotificationsOn ?? true;
milestoneAnnouncementsOn = savedSettings.milestoneAnnouncementsOn ?? true;
let voteSortOn = savedSettings.voteSortOn ?? true;
const SEARCH_MODES = new Set(["youtube-music", "youtube-web"]);
let searchMode = SEARCH_MODES.has(savedSettings.searchMode) ? savedSettings.searchMode : "youtube-web";
let orderNetworkLockOn = savedSettings.orderNetworkLockOn ?? false;
let orderNetworkLockIp = typeof savedSettings.orderNetworkLockIp === "string" ? savedSettings.orderNetworkLockIp : "";
let chatAiSettings = normalizeChatAiSettings(savedSettings.chatAi || {});
let spotifySettings = savedSettings.spotify && typeof savedSettings.spotify === "object"
  ? savedSettings.spotify
  : { refreshToken: "" };
let activeSpotifyToken = "";
let activeSpotifyTokenExpiresAt = 0;

async function getValidSpotifyAccessToken() {
  const now = Date.now();
  if (activeSpotifyToken && now < activeSpotifyTokenExpiresAt - 60_000) {
    return activeSpotifyToken;
  }
  if (spotifySettings?.refreshToken && SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET) {
    try {
      const refreshed = await refreshSpotifyToken(spotifySettings.refreshToken, {
        clientId: SPOTIFY_CLIENT_ID,
        clientSecret: SPOTIFY_CLIENT_SECRET,
      });
      if (refreshed?.access_token) {
        activeSpotifyToken = refreshed.access_token;
        activeSpotifyTokenExpiresAt = now + (Number(refreshed.expires_in) || 3600) * 1000;
        return activeSpotifyToken;
      }
    } catch (err) {
      console.warn("[spotify] token refresh failed:", err.message);
    }
  }
  return "";
}
state.setVoteSort(voteSortOn);

const chatMessages = chatRepo.listRecent("default_event", 40);
const chatLastSentAt = new WeakMap();
const rankChatLastText = new Map();

let feedbackItems = [];
try {
  const storedFeedback = JSON.parse(readFileSync(FEEDBACK_PATH, "utf8"));
  feedbackItems = Array.isArray(storedFeedback) ? storedFeedback : [];
} catch (err) {
  if (err?.code !== "ENOENT") console.warn(`[feedback] unable to read saved feedback: ${err.message}`);
}
let feedbackDigest = savedSettings.feedbackDigest && typeof savedSettings.feedbackDigest === "object"
  ? savedSettings.feedbackDigest
  : null;

function writeJsonAtomically(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  let renamed = false;
  try {
    writeFileSync(tempPath, JSON.stringify(value, null, 2));
    renameSync(tempPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      try { unlinkSync(tempPath); } catch {}
    }
  }
}

function saveSettings() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeJsonAtomically(SETTINGS_PATH, {
    filterOn,
    moderationMode,
    eventContext,
    cooldownSeconds,
    queueLimitOn,
    queueLimit,
    requireName,
    feedbackOn,
    chatOn,
    rewardNotificationsOn,
    milestoneAnnouncementsOn,
    voteSortOn,
    searchMode,
    orderNetworkLockOn,
    orderNetworkLockIp,
    chatAi: chatAiSettings,
    feedbackDigest,
    spotify: spotifySettings,
  });
}

function saveFeedback() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeJsonAtomically(FEEDBACK_PATH, feedbackItems);
}

function settingsSnapshot() {
  return {
    filterOn,
    moderationMode,
    eventContext,
    cooldownSeconds,
    queueLimitOn,
    queueLimit,
    requireName,
    feedbackOn,
    chatOn,
    rewardNotificationsOn,
    milestoneAnnouncementsOn,
    voteSortOn,
    searchMode,
    orderNetworkLockOn,
    orderNetworkLockIp,
    chatAi: chatAiSettings,
    feedbackDigest,
    spotifyConnected: !!spotifySettings?.refreshToken,
  };
}

function restoreSettings(snapshot) {
  ({
    filterOn,
    moderationMode,
    eventContext,
    cooldownSeconds,
    queueLimitOn,
    queueLimit,
    requireName,
    feedbackOn,
    chatOn,
    rewardNotificationsOn,
    milestoneAnnouncementsOn,
    voteSortOn,
    searchMode,
    orderNetworkLockOn,
    orderNetworkLockIp,
    chatAi: chatAiSettings,
    feedbackDigest,
  } = snapshot);
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
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});
const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY || "false");
app.set("trust proxy", TRUST_PROXY);
app.use(express.json({ limit: "32kb" }));
app.use(createAuthMiddleware(db));
app.use(
  "/avatars",
  express.static(AVATAR_DIR, {
    fallthrough: true,
    setHeaders: (res) => res.setHeader("Cache-Control", "public, max-age=31536000, immutable"),
  })
);

// --- Host authentication (Basic Auth or admin session) ---------------------
const HOST_PASSWORD = process.env.HOST_PASSWORD || "";
const hostToken = randomUUID();

function requireHostAuth(req, res, next) {
  if (req.user && req.user.role === "admin" && req.user.status === "active") {
    return next();
  }
  if (!HOST_PASSWORD) return next();
  return hostAuthLimit(req, res, () => {
    const b64 = (req.headers.authorization || "").split(" ")[1] || "";
    const pass = Buffer.from(b64, "base64").toString().split(":").slice(1).join(":");
    if (pass === HOST_PASSWORD) return next();
    res.set("WWW-Authenticate", 'Basic realm="Event Music Host"').status(401).send("Yêu cầu mật khẩu.");
  });
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
  key: (req) => getClientIp(req, TRUST_PROXY),
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
  key: (req) => getClientIp(req, TRUST_PROXY),
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
  key: (req) => getClientIp(req, TRUST_PROXY),
  reason: "Có quá nhiều lần thử đổi mật khẩu từ mạng này. Vui lòng thử lại sau.",
});
const passwordUserLimit = createFixedWindowRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  key: (req) => req.user?.id,
  reason: "Bạn đã thử đổi mật khẩu quá nhiều lần. Vui lòng thử lại sau.",
});
const hostAuthLimit = createFixedWindowRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  key: (req) => getClientIp(req, TRUST_PROXY),
  reason: "Có quá nhiều lần thử truy cập host. Vui lòng thử lại sau.",
});
const publicReadLimit = createFixedWindowRateLimiter({
  windowMs: 60 * 1000,
  max: 120,
  key: (req) => getClientIp(req, TRUST_PROXY),
  reason: "Có quá nhiều yêu cầu tìm kiếm. Vui lòng thử lại sau.",
});
const songRequestIpLimit = createFixedWindowRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  key: (req) => getClientIp(req, TRUST_PROXY),
  reason: "Có quá nhiều yêu cầu thêm bài hát. Vui lòng thử lại sau.",
});
const feedbackSubmitLimit = createFixedWindowRateLimiter({
  windowMs: 30 * 1000,
  max: 1,
  key: (req) => getClientIp(req, TRUST_PROXY),
  reason: "Bạn vừa gửi góp ý. Vui lòng thử lại sau ít phút.",
});
const notificationSendLimit = createFixedWindowRateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  key: (req) => req.user?.id,
  reason: "Bạn đã gửi quá nhiều thông báo. Vui lòng thử lại sau.",
});

app.post("/api/auth/register", registerIpLimit, registerGlobalLimit, async (req, res) => {
  const { username, password, displayName } = req.body || {};
  if (!username || typeof username !== "string" || username.trim().length < 3 || username.trim().length > 30) {
    return res.status(400).json({ ok: false, reason: "Tên đăng nhập phải từ 3 đến 30 ký tự." });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username.trim())) {
    return res.status(400).json({ ok: false, reason: "Tên đăng nhập chỉ chứa chữ cái, số và dấu gạch dưới." });
  }
  if (!password || typeof password !== "string" || password.length < 6 || password.length > MAX_PASSWORD_LENGTH) {
    return res.status(400).json({ ok: false, reason: "Mật khẩu phải từ 6 đến 256 ký tự." });
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
    const cleanDisplayName = displayName?.trim() || username.trim();
    const registration = db.transaction(() => {
      const user = userRepo.create({
        username: username.trim(),
        passwordHash,
        displayName: cleanDisplayName.slice(0, 40),
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
        avatarUrl: avatarPublicUrl(user.avatar_file),
        role: user.role,
        pointsBalance: user.points_balance,
        currentStreak: user.current_streak,
        unreadNotificationCount: notificationRepo.getUnreadCount(user.id),
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
  if (typeof username !== "string" || typeof password !== "string" || !username.trim() || !password || password.length > MAX_PASSWORD_LENGTH) {
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
        avatarUrl: avatarPublicUrl(user.avatar_file),
        role: user.role,
        pointsBalance: user.points_balance,
        currentStreak: user.current_streak,
        unreadNotificationCount: notificationRepo.getUnreadCount(user.id),
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

app.get("/api/rank/benefits", publicReadLimit, (_req, res) => {
  res.json({ ok: true, benefits: publicRankBenefits() });
});

app.get("/api/engagement/rules", publicReadLimit, (_req, res) => {
  res.json({ ok: true, rules: getEngagementRules() });
});

app.get("/api/rank/leaderboard", publicReadLimit, (_req, res) => {
  const leaderboard = rankRepo.listPublicLeaderboard({ limit: 10 });
  res.json({ ok: true, leaderboard });
});

app.get("/api/rank/weekly-leaderboard", publicReadLimit, (_req, res) => {
  const period = getWeeklyPeriod();
  const leaderboard = rankRepo.listWeeklyMusicLeaderboard({ period, limit: 10 });
  res.json({ ok: true, period, leaderboard });
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
      avatarUrl: avatarPublicUrl(req.user.avatarFile),
      role: req.user.role,
      status: req.user.status,
      pointsBalance: req.user.pointsBalance,
      currentStreak: req.user.currentStreak,
      unreadNotificationCount: notificationRepo.getUnreadCount(req.user.id),
      hasCheckedInToday,
      activeClaimableDrop: activeDrop && !alreadyClaimedDrop
        ? { id: activeDrop.id, title: activeDrop.title, points: activeDrop.points, expiresAt: activeDrop.expires_at }
        : null,
      votedQueueItemIds: queueRepo.listActiveVoteItemIds(req.user.id),
      rank: publicRank(req.user.id),
      weeklyRank: rankRepo.getWeeklyMusicSummary(req.user.id),
    },
  });
});

app.get("/api/me/rank", requireAuth, (req, res) => {
  res.json({ ok: true, rank: publicRank(req.user.id) });
});

app.get("/api/me/rank/weekly", requireAuth, (req, res) => {
  const period = getWeeklyPeriod();
  res.json({ ok: true, period, weeklyRank: rankRepo.getWeeklyMusicSummary(req.user.id, { period }) });
});

app.get("/api/me/favorites", requireAuth, (req, res) => {
  const items = favoriteRepo.list(req.user.id);
  res.json({ ok: true, items });
});

app.post("/api/me/favorites", requireAuth, (req, res) => {
  try {
    const favorite = favoriteRepo.save(req.user.id, req.body);
    res.json({ ok: true, favorite });
  } catch (err) {
    res.status(400).json({ ok: false, reason: err.message || "Không thể lưu bài hát yêu thích." });
  }
});

app.delete("/api/me/favorites/:videoId", requireAuth, (req, res) => {
  const removed = favoriteRepo.remove(req.user.id, req.params.videoId);
  res.json({ ok: true, removed });
});

app.get("/api/me/rank/activity", requireAuth, (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const activity = rankRepo.listActivity(req.user.id, { limit, offset });
  res.json({ ok: true, page, limit, activity });
});

app.get("/api/me/notifications", requireAuth, (req, res) => {
  const { page, limit, offset } = parsePagination(req.query, {
    defaultLimit: NOTIFICATION_USER_LIMIT,
    maxLimit: NOTIFICATION_USER_LIMIT,
  });
  const result = notificationRepo.listForUser(req.user.id, { limit, offset });
  res.json({ ok: true, page, limit, ...result });
});

app.post("/api/me/notifications/read-all", requireAuth, (req, res) => {
  const markedCount = notificationRepo.markAllRead(req.user.id);
  const unreadCount = notificationRepo.getUnreadCount(req.user.id);
  notifyUserNotificationsUpdated(req.user.id, unreadCount);
  res.json({ ok: true, markedCount, unreadCount });
});

app.post("/api/me/notifications/:id/read", requireAuth, (req, res) => {
  const notificationId = typeof req.params.id === "string" ? req.params.id.trim() : "";
  if (!notificationId || notificationId.length > 100) {
    return res.status(404).json({ ok: false, reason: "Không tìm thấy thông báo." });
  }
  const marked = notificationRepo.markRead(notificationId, req.user.id);
  if (!marked) return res.status(404).json({ ok: false, reason: "Không tìm thấy thông báo chưa đọc." });
  const unreadCount = notificationRepo.getUnreadCount(req.user.id);
  notifyUserNotificationsUpdated(req.user.id, unreadCount);
  res.json({ ok: true, unreadCount });
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
      avatarUrl: avatarPublicUrl(user.avatar_file),
    },
  });
});

app.put(
  "/api/me/avatar",
  requireAuth,
  express.raw({ type: "image/*", limit: "5mb" }),
  (req, res) => {
    let uploadedPath = "";
    let tempPath = "";
    try {
      const { extension } = validateAvatarUpload(req.body, req.headers["content-type"]);
      mkdirSync(AVATAR_DIR, { recursive: true });
      const filename = `${randomUUID()}.${extension}`;
      uploadedPath = path.join(AVATAR_DIR, filename);
      tempPath = `${uploadedPath}.${process.pid}.tmp`;
      writeFileSync(tempPath, req.body, { flag: "wx" });
      renameSync(tempPath, uploadedPath);
      tempPath = "";

      const previousFile = userRepo.findById(req.user.id)?.avatar_file;
      const user = userRepo.updateAvatarFile(req.user.id, filename);
      if (previousFile && avatarPublicUrl(previousFile)) {
        try { unlinkSync(path.join(AVATAR_DIR, previousFile)); } catch (err) {
          if (err?.code !== "ENOENT") console.warn(`[avatar] unable to remove replaced file: ${err.message}`);
        }
      }

      const avatarUrl = avatarPublicUrl(user.avatar_file);
      notifyUserProfile(user.id, user.display_name, avatarUrl);
      broadcastState();
      broadcastChatHistory();
      res.json({ ok: true, user: { id: user.id, username: user.username, displayName: user.display_name, avatarUrl } });
    } catch (err) {
      if (tempPath) {
        try { unlinkSync(tempPath); } catch {}
      }
      if (uploadedPath) {
        try { unlinkSync(uploadedPath); } catch {}
      }
      const validationError = /Ảnh|JPEG|PNG|WebP|Định dạng/.test(String(err.message));
      res.status(validationError ? 400 : 500).json({
        ok: false,
        reason: validationError ? err.message : "Không thể lưu ảnh đại diện lúc này.",
      });
    }
  }
);

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
    if (newPassword.length < 6 || newPassword.length > MAX_PASSWORD_LENGTH || currentPassword.length > MAX_PASSWORD_LENGTH) {
      return res.status(400).json({ ok: false, reason: "Mật khẩu mới phải từ 6 đến 256 ký tự." });
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
    const result = performCheckin(db, req.user.id, {
      eventId: DEFAULT_EVENT_ID,
      notificationRepo,
      engagementRepo,
      getNotificationsEnabled: () => rewardNotificationsOn,
      createAnnouncementInTransaction: createEngagementAnnouncementMessagesInTransaction,
    });
    publishEngagementResult(result, { userId: req.user.id });
    const { chatMessages: _chatMessages, ...response } = result;
    res.json(response);
  } catch (err) {
    res.status(400).json({ ok: false, reason: err.message });
  }
});

app.get("/api/me/points/history", requireAuth, (req, res) => {
  const direction = (req.query.direction || "all").toString();
  if (!["all", "earned", "spent"].includes(direction)) {
    return res.status(400).json({ ok: false, reason: "Bộ lọc lịch sử điểm không hợp lệ." });
  }
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 20 });

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
      thumbnail: sanitizeThumbnail(item.thumbnail),
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
    drop: {
      id: drop.id,
      title: drop.title,
      points: drop.points,
      createdAt: drop.created_at,
      expiresAt: drop.expires_at,
    },
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

let guestQrPromise = null;
app.get("/api/info", async (_req, res) => {
  try {
    guestQrPromise ??= QRCode.toDataURL(GUEST_URL, { width: 480, margin: 1 });
    const qr = await guestQrPromise;
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
      rewardNotificationsOn,
      milestoneAnnouncementsOn,
      chatAiOn: chatAiSettings.enabled && chatOn,
      chatAiName: chatAiSettings.name,
      voteSortOn,
    });
  } catch {
    guestQrPromise = null;
    res.status(500).json({ error: "Không thể tạo mã QR." });
  }
});

const browseCache = new Map();
const BROWSE_TTL_MS = 30 * 60 * 1000;
const MAX_SINGLE_SECONDS = 10 * 60;
function durationSeconds(d) {
  return parseDurationSeconds(d, { maxSeconds: MAX_SINGLE_SECONDS }) ?? Infinity;
}

app.get("/api/browse", publicReadLimit, async (req, res) => {
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

app.get("/api/history", requireAuth, publicReadLimit, (req, res) => {
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 10, maxLimit: 50 });
  const result = queueRepo.getPlaybackHistory("default_event", req.user.id, { limit, offset });
  const items = result.items.map((item) => ({
    id: item.id,
    videoId: item.video_id,
    title: item.title,
    channel: item.channel || "",
    duration: item.duration || "3:30",
    thumbnail: sanitizeThumbnail(item.thumbnail),
    addedBy: item.added_by || "",
    voteScore: item.vote_score || 0,
    finishedAt: item.finished_at || null,
    finishReason: item.finish_reason || "ended",
    playedSeconds: item.played_seconds || null,
  }));
  res.json({
    ok: true,
    page,
    limit,
    offset,
    total: result.total,
    hasMore: offset + items.length < result.total,
    items,
  });
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

app.get("/api/search", publicReadLimit, async (req, res) => {
  const q = (req.query.q || "").toString().trim().slice(0, 100);
  if (!q) return res.json({ results: [] });
  const platform = (req.query.platform || "youtube").toString().toLowerCase().trim();

  try {
    if (platform === "spotify") {
      if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
        return res.status(400).json({ error: "Spotify chưa được cấu hình Client ID / Secret trên hệ thống." });
      }
      let accessToken = "";
      try {
        accessToken = await getValidSpotifyAccessToken();
      } catch {}
      const results = await searchSpotifyTracks(q, {
        clientId: SPOTIFY_CLIENT_ID,
        clientSecret: SPOTIFY_CLIENT_SECRET,
        accessToken,
      });
      return res.json({ results });
    }

    const results = await searchYouTubeByMode(q, { mode: searchMode });
    res.json({ results });
  } catch (err) {
    console.error("[search]", err.message);
    res.status(502).json({ error: "Tìm kiếm thất bại. Vui lòng thử lại." });
  }
});

app.post("/api/youtube/resolve", publicReadLimit, async (req, res) => {
  const rawUrl = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!rawUrl) return res.status(400).json({ ok: false, reason: "Vui lòng dán link YouTube, Spotify hoặc SoundCloud." });

  let spotifyAccessToken = "";
  try {
    spotifyAccessToken = await getValidSpotifyAccessToken();
  } catch {}

  const result = await resolveMediaLink(rawUrl, {
    fetchYouTube: fetchYouTubeMetadata,
    spotifyConfig: {
      clientId: SPOTIFY_CLIENT_ID,
      clientSecret: SPOTIFY_CLIENT_SECRET,
      accessToken: spotifyAccessToken,
    },
  });

  if (!result.ok) {
    return res.status(400).json(result);
  }
  res.json(result);
});

// Spotify OAuth and playback status endpoints
app.get("/api/spotify/status", (req, res) => {
  res.json({
    connected: !!spotifySettings?.refreshToken,
    configured: !!(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET),
  });
});

app.get("/api/spotify/login", (req, res) => {
  if (!SPOTIFY_CLIENT_ID) {
    return res.status(400).send("Spotify Client ID chưa được cấu hình trong .env.");
  }
  const stateVal = randomUUID();
  const authUrl = buildSpotifyAuthorizeUrl({
    clientId: SPOTIFY_CLIENT_ID,
    redirectUri: SPOTIFY_REDIRECT_URI,
    state: stateVal,
  });
  res.redirect(authUrl);
});

app.get("/api/spotify/callback", async (req, res) => {
  const code = (req.query.code || "").toString();
  const error = (req.query.error || "").toString();
  if (error || !code) {
    const errText = error || "Không nhận được mã ủy quyền từ Spotify.";
    return res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;background:#181818;color:#fff;text-align:center;padding:40px;">
      <h2 style="color:#ff5555">Kết nối Spotify thất bại</h2>
      <p>${errText}</p>
      <script>if(window.opener){window.opener.postMessage({type:"spotify_error",error:${JSON.stringify(errText)}}, "*"); setTimeout(()=>window.close(), 2500);}</script>
    </body></html>`);
  }
  try {
    const tokens = await exchangeSpotifyCode(code, {
      clientId: SPOTIFY_CLIENT_ID,
      clientSecret: SPOTIFY_CLIENT_SECRET,
      redirectUri: SPOTIFY_REDIRECT_URI,
    });
    if (!tokens?.refresh_token) {
      return res.status(400).send("Không nhận được refresh token từ Spotify.");
    }
    spotifySettings = {
      refreshToken: tokens.refresh_token,
      updatedAt: Date.now(),
    };
    activeSpotifyToken = tokens.access_token || "";
    activeSpotifyTokenExpiresAt = Date.now() + (Number(tokens.expires_in) || 3600) * 1000;
    saveSettings();
    console.log("[spotify] Spotify account successfully connected for Host playback.");
    return res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;background:#181818;color:#fff;text-align:center;padding:40px;">
      <h2 style="color:#1db954">✓ Spotify đã kết nối thành công!</h2>
      <p>Cửa sổ này sẽ tự động đóng sau giây lát...</p>
      <script>
        if (window.opener) {
          window.opener.postMessage({ type: "spotify_connected" }, "*");
          setTimeout(() => window.close(), 1200);
        } else {
          location.href = "/host";
        }
      </script>
    </body></html>`);
  } catch (err) {
    console.error("[spotify] OAuth callback error:", err.message);
    return res.status(500).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;background:#181818;color:#fff;text-align:center;padding:40px;">
      <h2 style="color:#ff5555">Lỗi kết nối Spotify</h2>
      <p>${err.message}</p>
      <script>if(window.opener){window.opener.postMessage({type:"spotify_error",error:${JSON.stringify(err.message)}}, "*");}</script>
    </body></html>`);
  }
});

app.get("/api/spotify/token", async (req, res) => {
  const token = await getValidSpotifyAccessToken();
  if (!token) {
    return res.status(401).json({ ok: false, reason: "Chưa kết nối tài khoản Spotify Premium hoặc token hết hạn." });
  }
  res.json({ ok: true, access_token: token });
});

app.post("/api/spotify/disconnect", requireHostAuth, (req, res) => {
  spotifySettings = { refreshToken: "" };
  activeSpotifyToken = "";
  activeSpotifyTokenExpiresAt = 0;
  saveSettings();
  res.json({ ok: true });
});

app.get("/api/lyrics", async (req, res) => {
  const title = (req.query.title || "").toString().trim();
  const artist = (req.query.artist || "").toString().trim();
  const durationSec = parseFloat(req.query.duration);

  if (!title) {
    return res.status(400).json({ ok: false, error: "title_required" });
  }

  const result = await fetchLyrics(title, artist, Number.isFinite(durationSec) ? durationSec : null);
  res.json(result);
});

app.get("/api/host-token", requireHostAuth, (req, res) => {
  const isAdminSession = req.user?.role === "admin" && req.user?.status === "active";
  res.json({ token: HOST_PASSWORD && !isAdminSession ? hostToken : "" });
});

app.post("/api/request", songRequestIpLimit, async (req, res) => {
  const requesterIp = getClientIp(req, TRUST_PROXY);
  if (orderNetworkLockOn && requesterIp !== orderNetworkLockIp) {
    return res.status(403).json({
      ok: false,
      code: "ORDER_NETWORK_LOCKED",
      reason: "Order chỉ khả dụng khi bạn dùng cùng mạng Internet với máy host.",
    });
  }
  const { videoId, title, channel, duration, thumbnail, name, clientId, provider = "youtube" } = req.body || {};
  const cleanProvider = (provider || "youtube").toString().toLowerCase();
  if (cleanProvider === "youtube") {
    if (!isValidYouTubeVideoId(videoId)) {
      return res.status(400).json({ ok: false, reason: "Mã video YouTube không hợp lệ." });
    }
  } else if (cleanProvider === "spotify") {
    if (!isValidSpotifyTrackId(videoId)) {
      return res.status(400).json({ ok: false, reason: "Mã bài hát Spotify không hợp lệ." });
    }
  } else if (cleanProvider === "soundcloud") {
    if (!isValidSoundCloudUrl(videoId)) {
      return res.status(400).json({ ok: false, reason: "Link bài hát SoundCloud không hợp lệ." });
    }
  } else {
    return res.status(400).json({ ok: false, reason: "Nền tảng bài hát không được hỗ trợ." });
  }
  if (title !== undefined && typeof title !== "string") {
    return res.status(400).json({ ok: false, reason: "Thông tin bài hát không hợp lệ." });
  }
  if (channel !== undefined && typeof channel !== "string") {
    return res.status(400).json({ ok: false, reason: "Thông tin kênh không hợp lệ." });
  }
  if (duration !== undefined && typeof duration !== "string") {
    return res.status(400).json({ ok: false, reason: "Thời lượng bài hát không hợp lệ." });
  }
  if (thumbnail !== undefined && thumbnail !== null && typeof thumbnail !== "string") {
    return res.status(400).json({ ok: false, reason: "Ảnh bài hát không hợp lệ." });
  }
  const rawDuration = typeof duration === "string" ? duration.trim() : "";
  if (rawDuration.length > 20) {
    return res.status(400).json({ ok: false, reason: "Thời lượng bài hát không hợp lệ hoặc vượt quá 10 phút." });
  }
  const normalizedDuration = rawDuration;
  if (normalizedDuration) {
    const durationLimit = durationSeconds(normalizedDuration);
    if (!Number.isFinite(durationLimit)) {
      return res.status(400).json({ ok: false, reason: "Thời lượng bài hát không hợp lệ hoặc vượt quá 10 phút." });
    }
  }
  const requesterId = (clientId || "").toString().slice(0, 64);
  const requesterName = (name || req.user?.displayName || "").toString().trim().slice(0, 40);
  if (requireName && !requesterName) {
    return res.json({ ok: false, reason: "Vui lòng nhập tên để thêm bài hát." });
  }
  const floodKey = `${requesterIp}|${requesterId}`;
  const last = lastRequestAt.get(floodKey);
  if (cooldownSeconds > 0 && last) {
    const waitMs = cooldownSeconds * 1000 - (Date.now() - last);
    if (waitMs > 0) {
      const retryIn = Math.ceil(waitMs / 1000);
      return res.json({ ok: false, reason: `Vui lòng chờ — thử lại sau ${retryIn} giây.`, retryIn });
    }
  }

  if (state.queue.length >= MAX_QUEUE_LENGTH || (queueLimitOn && state.queue.length >= queueLimit)) {
    return res.json({ ok: false, reason: "Hàng đợi đã đầy — vui lòng thử lại sau khi phát bớt bài." });
  }

  if (state.has(videoId)) {
    return res.json({ ok: false, reason: "Bài hát này đã có trong hàng đợi!" });
  }

  lastRequestAt.set(floodKey, Date.now());
  pruneLastRequestAt();

  try {
    let canonical = null;
    if (cleanProvider === "youtube") {
      const prepared = await prepareRequestSong({
        videoId,
        clientMetadata: { duration: normalizedDuration },
        checkPlayable,
        fetchMetadata: fetchYouTubeMetadata,
        moderationOn: filterOn,
        fetchDetails: fetchVideoDetails,
        moderateSong: moderate,
        moderationOptions: {
          strict: moderationMode === "strict",
          ...(eventContext ? { eventContext } : {}),
        },
      });
      if (!prepared.ok) return res.status(prepared.unavailable ? 502 : 200).json({ ok: false, reason: prepared.reason });
      canonical = prepared.song;
    } else if (cleanProvider === "spotify") {
      let accessToken = "";
      try { accessToken = await getValidSpotifyAccessToken(); } catch {}
      const meta = await fetchSpotifyTrackMetadata(videoId, {
        clientId: SPOTIFY_CLIENT_ID,
        clientSecret: SPOTIFY_CLIENT_SECRET,
        accessToken,
      });
      if (!meta) return res.status(502).json({ ok: false, reason: "Không thể lấy thông tin bài hát từ Spotify. Vui lòng thử lại." });
      if (filterOn) {
        const verdict = await moderate({ title: meta.title, channel: meta.channel }, null, {
          strict: moderationMode === "strict",
          ...(eventContext ? { eventContext } : {}),
        });
        if (!verdict?.approved) return res.json({ ok: false, reason: verdict?.reason || "Bài hát không được chấp thuận." });
      }
      canonical = meta;
    } else if (cleanProvider === "soundcloud") {
      const meta = await fetchSoundCloudMetadata(videoId);
      if (!meta) return res.status(502).json({ ok: false, reason: "Không thể lấy thông tin bài hát từ SoundCloud. Vui lòng thử lại." });
      if (filterOn) {
        const verdict = await moderate({ title: meta.title, channel: meta.channel }, null, {
          strict: moderationMode === "strict",
          ...(eventContext ? { eventContext } : {}),
        });
        if (!verdict?.approved) return res.json({ ok: false, reason: verdict?.reason || "Bài hát không được chấp thuận." });
      }
      canonical = meta;
    }

    if (state.queue.length >= MAX_QUEUE_LENGTH || (queueLimitOn && state.queue.length >= queueLimit)) {
      return res.json({ ok: false, reason: "Hàng đợi đã đầy — vui lòng thử lại sau khi phát bớt bài." });
    }
    if (state.has(videoId)) {
      return res.json({ ok: false, reason: "Bài hát này đã có trong hàng đợi!" });
    }

    const { item, position } = state.add({
      videoId,
      title: canonical.title,
      channel: canonical.channel,
      duration: canonical.duration,
      thumbnail: canonical.thumbnail,
      addedBy: requesterName,
      requesterId,
      userId: req.user?.id || null,
      provider: cleanProvider,
    });
    res.json({ ok: true, reason: "Đã thêm!", position, id: item.id });
  } catch (err) {
    console.error("[request]", err);
    res.status(500).json({ ok: false, reason: "Không thể thêm bài hát lúc này. Vui lòng thử lại." });
  }
});

// --- ADMIN API (/api/admin/*) -----------------------------------------------

app.get("/api/admin/users", requireAdmin, (req, res) => {
  const search = (req.query.search || "").toString().trim();
  const status = (req.query.status || "").toString().trim();
  const { page, limit, offset } = parsePagination(req.query);

  const result = userRepo.listUsers({ search, status, limit, offset });
  res.json({
    ok: true,
    page,
    limit,
    ...result,
    users: result.users.map(({ avatar_file: avatarFile, ...user }) => ({
      ...user,
      avatarUrl: avatarPublicUrl(avatarFile),
      rank: publicRank(user.id),
    })),
  });
});

app.get("/api/admin/search-settings", requireAdmin, (_req, res) => {
  res.json({ ok: true, searchMode });
});

app.patch("/api/admin/search-settings", requireAdmin, (req, res) => {
  if (!SEARCH_MODES.has(req.body?.searchMode)) {
    return res.status(400).json({ ok: false, reason: "Chế độ tìm kiếm không hợp lệ." });
  }
  const previous = settingsSnapshot();
  searchMode = req.body.searchMode;
  try {
    saveSettings();
  } catch (err) {
    restoreSettings(previous);
    console.error(`[settings] unable to save: ${err.message}`);
    return res.status(500).json({ ok: false, reason: "Không thể lưu cài đặt lúc này. Vui lòng thử lại." });
  }
  res.json({ ok: true, searchMode });
});

app.get("/api/admin/order-network-lock", requireAdmin, (req, res) => {
  res.json({
    ok: true,
    enabled: orderNetworkLockOn,
    hostIp: orderNetworkLockIp || null,
  });
});

app.patch("/api/admin/order-network-lock", requireAdmin, (req, res) => {
  if (typeof req.body?.enabled !== "boolean") {
    return res.status(400).json({ ok: false, reason: "Giá trị khóa mạng không hợp lệ." });
  }

  if (req.body.enabled && !orderNetworkLockIp) {
    return res.status(409).json({ ok: false, reason: "Máy host chưa cập nhật mạng hiện tại." });
  }

  const previous = settingsSnapshot();
  orderNetworkLockOn = req.body.enabled;
  try {
    saveSettings();
  } catch (err) {
    restoreSettings(previous);
    console.error(`[settings] unable to save: ${err.message}`);
    return res.status(500).json({ ok: false, reason: "Không thể lưu cài đặt lúc này. Vui lòng thử lại." });
  }

  res.json({ ok: true, enabled: orderNetworkLockOn, hostIp: orderNetworkLockIp || null });
});

app.get("/api/admin/rank/leaderboard", requireAdmin, (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const eventId = (req.query.eventId || "").toString().trim() || null;
  const leaderboard = rankRepo.listLeaderboard({ eventId, limit, offset });
  res.json({ ok: true, page, limit, eventId, leaderboard });
});

app.post("/api/admin/notifications", requireAdmin, notificationSendLimit, (req, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  const kind = typeof req.body?.kind === "string" ? req.body.kind.trim() : "info";
  if (!title || title.length > NOTIFICATION_TITLE_MAX_LENGTH) {
    return res.status(400).json({ ok: false, reason: `Tiêu đề phải từ 1 đến ${NOTIFICATION_TITLE_MAX_LENGTH} ký tự.` });
  }
  if (!body || body.length > NOTIFICATION_BODY_MAX_LENGTH) {
    return res.status(400).json({ ok: false, reason: `Nội dung phải từ 1 đến ${NOTIFICATION_BODY_MAX_LENGTH} ký tự.` });
  }
  if (!NOTIFICATION_KINDS.includes(kind)) {
    return res.status(400).json({ ok: false, reason: "Loại thông báo không hợp lệ." });
  }

  try {
    const result = notificationRepo.createForActiveUsers({
      title,
      body,
      kind,
      createdByUserId: req.user.id,
    });
    for (const userId of result.recipientUserIds) {
      notifyUserNotification(userId, result.notification);
    }
    res.json({
      ok: true,
      notification: result.notification,
      recipientCount: result.recipientCount,
    });
  } catch (err) {
    res.status(400).json({ ok: false, reason: err.message || "Không thể gửi thông báo." });
  }
});

app.get("/api/admin/notifications", requireAdmin, (req, res) => {
  const { page, limit, offset } = parsePagination(req.query, {
    defaultLimit: NOTIFICATION_USER_LIMIT,
    maxLimit: NOTIFICATION_USER_LIMIT,
  });
  const result = notificationRepo.listAdmin({ limit, offset });
  res.json({ ok: true, page, limit, ...result });
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
  if (reason.length > MAX_MODERATION_REASON_LENGTH) {
    return res.status(400).json({ ok: false, reason: `Lý do không được vượt quá ${MAX_MODERATION_REASON_LENGTH} ký tự.` });
  }

  try {
    const actorId = req.user?.id || null;
    const result = userRepo.updatePoints(req.params.id, delta, {
      type: "admin_adjustment",
      actorUserId: actorId,
      reason,
    });
    publishNotificationEvents(result.notification ? [{ userId: req.params.id, notification: result.notification }] : []);
    notifyUserBalance(req.params.id, result.points_balance, { delta, reason });
    res.json({ ok: true, pointsBalance: result.points_balance, ledgerId: result.ledgerId });
  } catch (err) {
    res.status(400).json({ ok: false, reason: err.message });
  }
});

app.post("/api/admin/users/:id/reset-password", requireAdmin, async (req, res) => {
  const user = userRepo.findById(req.params.id);
  if (!user) return res.status(404).json({ ok: false, reason: "Không tìm thấy người dùng." });
  if (user.role !== "user") {
    return res.status(400).json({ ok: false, reason: "Chỉ có thể reset mật khẩu tài khoản người dùng." });
  }

  res.set("Cache-Control", "no-store");
  try {
    const password = generateRandomPassword();
    const passwordHash = await hashPasswordAsync(password);
    const resetPassword = db.transaction(() => {
      userRepo.updatePasswordHash(user.id, passwordHash);
      sessionRepo.deleteByUserId(user.id);
    });
    resetPassword.immediate();
    revokeUserSockets(user.id, "Mật khẩu của bạn đã được quản trị viên đặt lại.");
    res.json({ ok: true, user: publicUser(userRepo.findById(user.id)), password });
  } catch (err) {
    console.error(`[admin] unable to reset password for user ${user.id}: ${err.message}`);
    res.status(500).json({ ok: false, reason: "Không thể reset mật khẩu lúc này." });
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
    res.json({ ok: true, user: publicUser(user) });
  } catch (err) {
    res.status(400).json({ ok: false, reason: err.message });
  }
});

app.get("/api/admin/users/:id/ledger", requireAdmin, (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);

  const result = ledgerRepo.listByUser(req.params.id, { limit, offset });
  res.json({ ok: true, page, limit, ...result });
});

app.post("/api/admin/point-drops", requireAdmin, (req, res) => {
  const { type, title, points } = req.body || {};
  const cleanTitle = typeof title === "string" ? title.trim() : "";
  if (cleanTitle.length > MAX_POINT_DROP_TITLE_LENGTH) {
    return res.status(400).json({ ok: false, reason: `Tiêu đề không được vượt quá ${MAX_POINT_DROP_TITLE_LENGTH} ký tự.` });
  }
  const numPoints = Number(points);
  if (!Number.isSafeInteger(numPoints) || numPoints <= 0 || numPoints > 1000) {
    return res.status(400).json({ ok: false, reason: "Số điểm phải là số nguyên từ 1 đến 1000." });
  }

  const actorId = req.user.id;

  if (type === "direct") {
    const reason = cleanTitle || "Airdrop từ Ban Quản Trị";
    const result = dropRepo.createDirectAirdrop({ points: numPoints, reason, createdByUserId: actorId });

    for (const event of result.notifications || []) {
      notifyUserNotification(event.userId, event.notification);
    }

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
    const durationHours = Number(req.body?.durationHours || DEFAULT_CLAIMABLE_DROP_DURATION_HOURS);
    if (!CLAIMABLE_DROP_DURATION_PRESETS.includes(durationHours)) {
      return res.status(400).json({ ok: false, reason: `Thời hạn chỉ được chọn: ${CLAIMABLE_DROP_DURATION_PRESETS.join(", ")} giờ.` });
    }
    const previousActiveDrop = dropRepo.getActiveClaimableDrop();
    const drop = dropRepo.createClaimableDrop({
      title: cleanTitle,
      points: numPoints,
      createdByUserId: actorId,
      durationHours,
    });

    if (previousActiveDrop && previousActiveDrop.id !== drop.id) {
      broadcastPointDropClosed(previousActiveDrop.id, "superseded");
    }

    // WebSocket broadcast claimable drop event
    const msg = JSON.stringify({
      type: "pointDropAvailable",
      drop: { id: drop.id, title: drop.title, points: drop.points, expiresAt: drop.expires_at },
    });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(msg);
    }

    return res.json({ ok: true, type: "claimable", drop });
  }

  res.status(400).json({ ok: false, reason: "Hình thức phát điểm không hợp lệ." });
});

app.post("/api/admin/point-drops/:id/cancel", requireAdmin, (req, res) => {
  const reason = typeof req.body?.reason === "string" && req.body.reason.trim()
    ? req.body.reason.trim().slice(0, MAX_MODERATION_REASON_LENGTH)
    : "Admin hủy đợt phát điểm";
  try {
    const drop = dropRepo.cancelClaimableDrop(req.params.id, req.user.id, reason);
    broadcastPointDropClosed(drop.id, "cancelled");
    res.json({ ok: true, drop });
  } catch (err) {
    res.status(400).json({ ok: false, reason: err.message || "Không thể hủy đợt nhận điểm." });
  }
});

app.get("/api/admin/point-drops", requireAdmin, (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);

  const result = dropRepo.listDrops({ limit, offset });
  res.json({ ok: true, page, limit, ...result });
});

app.get("/api/admin/ledger", requireAdmin, (req, res) => {
  const search = (req.query.search || "").toString().trim();
  const type = (req.query.type || "").toString().trim();
  const { page, limit, offset } = parsePagination(req.query);

  const result = ledgerRepo.listAll({ search, type, limit, offset });
  res.json({ ok: true, page, limit, ...result });
});

// --- FEEDBACK AND CHAT -----------------------------------------------------

app.post("/api/feedback", feedbackSubmitLimit, (req, res) => {
  if (!feedbackOn) return res.status(403).json({ ok: false, reason: "Tính năng góp ý hiện đang tắt." });
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 40) : "";
  const content = typeof req.body?.content === "string" ? req.body.content.trim().slice(0, 1000) : "";
  if (!name || !content) return res.status(400).json({ ok: false, reason: "Vui lòng nhập tên và nội dung góp ý." });
  const item = { id: randomUUID(), name, content, createdAt: new Date().toISOString() };
  const previousItems = feedbackItems.slice();
  feedbackItems.unshift(item);
  if (feedbackItems.length > 1000) feedbackItems.length = 1000;
  try {
    saveFeedback();
  } catch (err) {
    feedbackItems = previousItems;
    console.error(`[feedback] unable to save: ${err.message}`);
    return res.status(500).json({ ok: false, reason: "Không thể lưu góp ý lúc này. Vui lòng thử lại." });
  }
  res.json({ ok: true });
});

app.get("/api/feedback", requireAdmin, (_req, res) => {
  res.json({
    feedbackOn,
    chatOn,
    rewardNotificationsOn,
    milestoneAnnouncementsOn,
    stats: feedbackStats(),
    items: feedbackItems,
  });
});

app.patch("/api/feedback/settings", requireAdmin, (req, res) => {
  const hasFeedbackSetting = typeof req.body?.on === "boolean";
  const hasChatSetting = typeof req.body?.chatOn === "boolean";
  const hasRewardNotificationsSetting = typeof req.body?.rewardNotificationsOn === "boolean";
  const hasMilestoneAnnouncementsSetting = typeof req.body?.milestoneAnnouncementsOn === "boolean";
  if (!hasFeedbackSetting && !hasChatSetting && !hasRewardNotificationsSetting && !hasMilestoneAnnouncementsSetting) {
    return res.status(400).json({ ok: false, reason: "Giá trị không hợp lệ." });
  }
  const previous = settingsSnapshot();
  if (hasFeedbackSetting) feedbackOn = req.body.on;
  if (hasChatSetting) chatOn = req.body.chatOn;
  if (hasRewardNotificationsSetting) rewardNotificationsOn = req.body.rewardNotificationsOn;
  if (hasMilestoneAnnouncementsSetting) milestoneAnnouncementsOn = req.body.milestoneAnnouncementsOn;
  try {
    saveSettings();
  } catch (err) {
    restoreSettings(previous);
    console.error(`[settings] unable to save: ${err.message}`);
    return res.status(500).json({ ok: false, reason: "Không thể lưu cài đặt lúc này. Vui lòng thử lại." });
  }
  if (hasChatSetting && !chatOn && previous.chatOn) {
    try {
      chatAiCoordinator.reset();
      chatRepo.clear();
      chatAiMemoryRepo.clearConversationState();
      chatMessages.length = 0;
      const message = JSON.stringify({ type: "chatCleared" });
      for (const client of wss.clients) {
        if (client.readyState === 1) client.send(message);
      }
    } catch (err) {
      // The durable setting has already been accepted. Keep chat disabled but
      // do not claim that its history was cleared when the delete failed.
      console.error(`[chat] unable to clear history after disabling chat: ${err.message}`);
      broadcastState();
      return res.status(500).json({ ok: false, reason: "Đã tắt chat nhưng không thể xóa lịch sử lúc này." });
    }
  }
  broadcastState();
  res.json({ ok: true, feedbackOn, chatOn, rewardNotificationsOn, milestoneAnnouncementsOn });
});

app.delete("/api/feedback/:id", requireAdmin, (req, res) => {
  const previousItems = feedbackItems;
  const before = feedbackItems.length;
  feedbackItems = feedbackItems.filter((item) => item.id !== req.params.id);
  if (feedbackItems.length === before) return res.status(404).json({ ok: false, reason: "Không tìm thấy góp ý." });
  try {
    saveFeedback();
  } catch (err) {
    feedbackItems = previousItems;
    console.error(`[feedback] unable to save: ${err.message}`);
    return res.status(500).json({ ok: false, reason: "Không thể xóa góp ý lúc này. Vui lòng thử lại." });
  }
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
  const previousSettings = settingsSnapshot();
  chatAiSettings = normalizeChatAiSettings({
    ...chatAiSettings,
    ...patch,
    features: { ...chatAiSettings.features, ...(patch.features || {}) },
  });
  try {
    saveSettings();
  } catch (err) {
    restoreSettings(previousSettings);
    console.error(`[settings] unable to save: ${err.message}`);
    return res.status(500).json({ ok: false, reason: "Không thể lưu cài đặt lúc này. Vui lòng thử lại." });
  }
  if (!chatAiSettings.enabled) chatAiCoordinator.reset();
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
    const previousDigest = feedbackDigest;
    feedbackDigest = { ...digest, generatedAt: new Date().toISOString() };
    try {
      saveSettings();
    } catch (err) {
      feedbackDigest = previousDigest;
      console.error(`[settings] unable to save: ${err.message}`);
      return res.status(500).json({ ok: false, reason: "Không thể lưu digest lúc này. Vui lòng thử lại." });
    }
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
const PAGE_CACHE = new Map();

function versionedPage(name) {
  const filePath = path.join(__dirname, "public", name);
  if (!existsSync(filePath)) return `<!DOCTYPE html><html><body><h1>${name} not found</h1></body></html>`;
  let version = BOOT_ID;
  try {
    version = Math.floor(statSync(filePath).mtimeMs).toString(36);
  } catch {}
  return readFileSync(filePath, "utf8").replace(
    /(href|src)="\/((?:guest|host|admin|account|leaderboard|rules|auth-utils|avatar|avatar-crop|history-controller|favorites-controller)\.(?:css|js))"/g,
    `$1="/$2?v=${version}"`
  );
}

function getPage(name) {
  if (process.env.NODE_ENV === "production") {
    if (!PAGE_CACHE.has(name)) PAGE_CACHE.set(name, versionedPage(name));
    return PAGE_CACHE.get(name);
  }
  return versionedPage(name);
}

app.get("/", requireHostAuth, (_req, res) => {
  res.set("Cache-Control", "no-cache").type("html").send(getPage("host.html"));
});

app.get("/guest", (_req, res) => {
  res.set("Cache-Control", "no-cache").type("html").send(getPage("guest.html"));
});

app.get("/admin", (_req, res) => {
  res.set("Cache-Control", "no-cache").type("html").send(getPage("admin.html"));
});

app.get("/account", (_req, res) => {
  res.set("Cache-Control", "no-cache").type("html").send(getPage("account.html"));
});

app.get("/leaderboard", (_req, res) => {
  res.set("Cache-Control", "no-cache").type("html").send(getPage("leaderboard.html"));
});

app.get("/rules", (_req, res) => {
  res.set("Cache-Control", "no-cache").type("html").send(getPage("rules.html"));
});

app.get("/feedback", (_req, res) => {
  res.redirect(302, "/admin#feedback");
});

// --- WebSocket: REALTIME SYNC AND HOST CONTROLS ----------------------------

const server = http.createServer(app);
function boundedEnvInteger(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
const wsRateLimiter = new WebSocketRateLimiter({
  maxConnections: boundedEnvInteger("WS_MAX_CONNECTIONS_PER_IP", 200, 1, 10_000),
  maxMessages: boundedEnvInteger("WS_MAX_MESSAGES_PER_IP", 600, 1, 100_000),
  maxTrackedIps: boundedEnvInteger("WS_MAX_TRACKED_IPS", 5_000, 100, 100_000),
});
const wss = new WebSocketServer({
  server,
  // Application messages are capped at 4,000 bytes below; keep the frame
  // limit close to that bound so oversized payloads are rejected before ws
  // buffers them in memory.
  maxPayload: 8 * 1024,
  verifyClient: (info, done) => {
    const clientIp = getClientIp(info.req, TRUST_PROXY);
    if (!wsRateLimiter.allowConnection(clientIp)) {
      done(false, 429, "Too many WebSocket connections", { "Retry-After": "60" });
      return;
    }
    // verifyClient runs before ws emits `connection`. If a client aborts the
    // HTTP upgrade in that window, there is no WebSocket close event to release
    // the reservation, so tie it to the request/socket lifecycle as well.
    const reservation = { committed: false, released: false };
    const releasePending = () => {
      if (reservation.committed || reservation.released) return;
      reservation.released = true;
      wsRateLimiter.releaseConnection(clientIp);
    };
    reservation.commit = () => {
      reservation.committed = true;
      info.req.off?.("aborted", releasePending);
      info.req.off?.("error", releasePending);
      info.req.socket?.off?.("close", releasePending);
    };
    info.req.once("aborted", releasePending);
    info.req.once("error", releasePending);
    info.req.socket?.once("close", releasePending);
    info.req.__jukeboxClientIp = clientIp;
    info.req.__jukeboxWsReservation = reservation;
    done(true);
  },
});
const wsHeartbeatTimer = setInterval(() => {
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, 30_000);
wsHeartbeatTimer.unref?.();

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
    rewardNotificationsOn,
    milestoneAnnouncementsOn,
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
let latestSpotifyPlaybackTick = null;

state.onChange = (nextState) => {
  if (latestSpotifyPlaybackTick && latestSpotifyPlaybackTick.videoId !== nextState.nowPlaying?.videoId) {
    latestSpotifyPlaybackTick = null;
  }
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

function notifyUserProfile(userId, displayName, avatarUrl = undefined) {
  const msg = JSON.stringify({ type: "profileUpdated", displayName, avatarUrl });
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    const session = refreshSocketIdentity(client, sessionRepo);
    if (session?.user_id === userId) client.send(msg);
  }
}

function publicChatMessage(message, linkedUserId = undefined) {
  if (!message) return message;
  const { userId: embeddedUserId, ...safeMessage } = message;
  const userId = linkedUserId === undefined
    ? embeddedUserId || chatRepo.findUserId(message.id)
    : linkedUserId;
  if (!userId) return safeMessage;
  const user = userRepo.findById(userId);
  return {
    ...safeMessage,
    rank: publicRank(userId),
    avatarUrl: avatarPublicUrl(user?.avatar_file),
  };
}

function broadcastChatHistory() {
  if (!chatOn || !chatMessages.length) return;
  const message = JSON.stringify({ type: "chatHistory", messages: chatMessages.map((item) => publicChatMessage(item)) });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(message);
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

function notifyUserNotification(userId, notification) {
  const unreadCount = notificationRepo.getUnreadCount(userId);
  const msg = JSON.stringify({ type: "notificationCreated", notification, unreadCount });
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    const session = refreshSocketIdentity(client, sessionRepo);
    if (session?.user_id === userId) client.send(msg);
  }
}

function publishNotificationEvents(events, fallbackUserId = null) {
  for (const event of events || []) {
    const userId = event?.userId || fallbackUserId;
    const notification = event?.notification || (event?.id ? event : null);
    if (userId && notification) notifyUserNotification(userId, notification);
  }
}

function broadcastPointDropClosed(dropId, reason = "expired") {
  const payload = JSON.stringify({ type: "pointDropClosed", dropId, reason });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

function groupEngagementAnnouncements(announcements) {
  const grouped = new Map();
  for (const announcement of announcements) {
    const key = `${announcement.userId}:${announcement.category}:${announcement.milestoneKey}`;
    const current = grouped.get(key) || {
      ...announcement,
      points: 0,
      places: [],
    };
    current.points += Number(announcement.points || 0);
    if (announcement.place) current.places.push(announcement.place);
    grouped.set(key, current);
  }
  return grouped.values();
}

function createEngagementAnnouncementMessagesInTransaction(announcements) {
  if (!milestoneAnnouncementsOn || !chatOn || !Array.isArray(announcements) || !announcements.length) return [];
  const messages = [];
  for (const announcement of groupEngagementAnnouncements(announcements)) {
    const isRank = announcement.category === "rank";
    const label = isRank ? announcement.title.replace(/^Top \d+ /, "") : `streak ${announcement.milestoneKey} ngày`;
    const placeText = announcement.places.length
      ? ` và đứng top ${Math.min(...announcement.places)}`
      : "";
    const message = chatRepo.create({
      id: randomUUID(),
      name: "Thành tích",
      text: `${announcement.displayName} vừa đạt ${label}${placeText}, nhận tổng +${announcement.points} điểm! 🎉`,
      senderId: "system:engagement",
      userId: announcement.userId,
      isAdmin: false,
      isAI: false,
      isSystem: true,
      createdAt: announcement.createdAt || new Date().toISOString(),
    }, DEFAULT_EVENT_ID);
    messages.push(message);
  }
  return messages;
}

function publishEngagementAnnouncementMessages(messages) {
  for (const message of messages || []) {
    pushRecentChat(chatMessages, message);
    broadcastChatMessage(message);
  }
}

function publishEngagementResult(result, { userId = null } = {}) {
  if (!result) return;
  publishNotificationEvents(result.notifications, userId);
  if (userId && Number(result.pointsAwarded || 0) > 0) {
    const user = userRepo.findById(userId);
    if (user) {
      notifyUserBalance(userId, user.points_balance, {
        delta: result.pointsAwarded,
        reason: "Thưởng hoạt động thành tích",
      });
    }
  }
  publishEngagementAnnouncementMessages(result.chatMessages);
}

function notifyUserNotificationsUpdated(userId, unreadCount = notificationRepo.getUnreadCount(userId)) {
  const msg = JSON.stringify({ type: "notificationsUpdated", unreadCount });
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
    publishEngagementResult(award, { userId });
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
    if (playAward.awarded) {
      publishEngagementResult(playAward, { userId: finishedItem.addedByUserId });
      updatedUsers.set(finishedItem.addedByUserId, playAward.profile);
    }
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
    if (award.awarded) {
      publishEngagementResult(award, { userId: voter.user_id });
      updatedUsers.set(voter.user_id, award.profile);
    }
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

function reportSettingsPersistenceFailure(ws, err) {
  console.error(`[settings] unable to save: ${err.message}`);
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: "error", reason: "Không thể lưu cài đặt lúc này. Vui lòng thử lại." }));
}

state.onBalanceChange = ({ userId, newBalance, pointsRefunded, reason }) => {
  notifyUserBalance(userId, newBalance, { delta: pointsRefunded, reason });
};
state.onNotification = (event) => {
  publishNotificationEvents([event]);
};

const dropExpiryTimer = setInterval(() => {
  try {
    for (const drop of dropRepo.expireDueClaimableDrops()) {
      broadcastPointDropClosed(drop.id, "expired");
    }
  } catch (err) {
    console.error(`[point-drops] expiry sweep failed: ${err.message}`);
  }
}, 60_000);
dropExpiryTimer.unref?.();

wss.on("connection", (ws, request) => {
  const clientIp = request.__jukeboxClientIp || getClientIp(request, TRUST_PROXY);
  request.__jukeboxWsReservation?.commit();
  ws.__jukeboxClientIp = clientIp;
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.sessionToken = getSessionTokenFromCookieHeader(request.headers.cookie);
  ws.hostAuthenticated = !HOST_PASSWORD;
  refreshSocketIdentity(ws, sessionRepo);

  ws.send(stateMessage());
  if (chatOn && chatMessages.length) {
    ws.send(JSON.stringify({ type: "chatHistory", messages: chatMessages.map((item) => publicChatMessage(item)) }));
  }

  ws.on("error", (err) => {
    console.warn(`[ws] client error: ${err?.message || err}`);
  });

  ws.on("close", () => {
    wsRateLimiter.releaseConnection(clientIp);
  });

  ws.on("message", (raw) => {
    try {
      if (!wsRateLimiter.allowMessage(clientIp)) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "error", reason: "Kết nối gửi quá nhiều yêu cầu. Vui lòng thử lại sau." }));
          ws.close(1008, "Message rate limit exceeded");
        }
        return;
      }
      if (raw.length > 4000) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;

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
        const publicMessage = publicChatMessage(message, currentSession?.user_id || null);
        pushRecentChat(chatMessages, message);
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

      if (msg.type === "skipOwn") {
        const id = typeof msg.id === "string" ? msg.id : "";
        const userId = currentSession?.user_id || null;
        const requesterId = userId ? "" : (msg.clientId || "").toString().slice(0, 64);
        const transition = state.skipOwned(id, requesterId, userId);
        ws.send(JSON.stringify({
          type: "skipOwnResult",
          id,
          ok: !!transition,
          ...(transition ? {} : { reason: "Bài đang phát không thuộc về bạn hoặc đã chuyển bài." }),
        }));
        if (transition) {
          latestSpotifyPlaybackTick = null;
          settleRankTransition(transition);
        }
        return;
      }

      if (msg.type === "requestPlaybackTick") {
        if (latestSpotifyPlaybackTick && ws.readyState === 1) {
          const now = Date.now();
          const elapsed = latestSpotifyPlaybackTick.paused
            ? 0
            : Math.max(0, now - (latestSpotifyPlaybackTick.serverTime || now));
          ws.send(JSON.stringify({
            type: "playbackTick",
            ...latestSpotifyPlaybackTick,
            position: latestSpotifyPlaybackTick.position + elapsed,
            serverTime: now,
          }));
        }
        return;
      }

      if (!canUseHostControls(ws, currentSession)) return;

      switch (msg.type) {
        case "playbackTick": {
          if (typeof msg.position !== "number" || msg.position < 0) break;
          const position = Math.max(0, Math.floor(msg.position));
          const paused = Boolean(msg.paused);
          const seek = Boolean(msg.seek);
          const videoId = typeof msg.videoId === "string" ? msg.videoId : "";
          latestSpotifyPlaybackTick = {
            position,
            paused,
            seek,
            videoId,
            serverTime: Date.now(),
          };
          const payload = JSON.stringify({
            type: "playbackTick",
            ...latestSpotifyPlaybackTick,
          });
          for (const client of wss.clients) {
            if (client !== ws && client.readyState === 1) {
              client.send(payload);
            }
          }
          break;
        }
        case "ended":
          latestSpotifyPlaybackTick = null;
          if (typeof msg.playbackToken !== "string" || !msg.playbackToken) break;
          const activeItem = state.nowPlaying;
          const expectedVideoId = activeItem?.videoId;
          if (msg.videoId !== undefined && msg.videoId !== null && msg.videoId !== expectedVideoId && !isValidYouTubeVideoId(msg.videoId)) break;
          console.log(`[host] finished playing ${msg.videoId}`);
          settleRankTransition(state.advance(msg.videoId || null, { finishReason: "ended", playbackToken: msg.playbackToken, playedSeconds: msg.playedSeconds }));
          break;
        case "error":
          latestSpotifyPlaybackTick = null;
          if (typeof msg.playbackToken !== "string" || !msg.playbackToken) break;
          const activeErrItem = state.nowPlaying;
          const expectedErrVideoId = activeErrItem?.videoId;
          if (msg.videoId !== undefined && msg.videoId !== null && msg.videoId !== expectedErrVideoId && !isValidYouTubeVideoId(msg.videoId)) break;
          console.warn(`[host] playback error ${msg.code} on ${msg.videoId} — skipping and refunding points`);
          settleRankTransition(state.advance(msg.videoId || null, { isError: true, finishReason: "error", playbackToken: msg.playbackToken }));
          break;
        case "skip":
          latestSpotifyPlaybackTick = null;
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
          {
            const previous = settingsSnapshot();
            voteSortOn = !!msg.on;
            try {
              saveSettings();
            } catch (err) {
              restoreSettings(previous);
              state.setVoteSort(voteSortOn);
              reportSettingsPersistenceFailure(ws, err);
              break;
            }
            state.setVoteSort(voteSortOn);
          }
          broadcastState();
          break;
        case "setFilter":
          {
            const previous = settingsSnapshot();
            filterOn = !!msg.on;
            if (msg.mode === "strict" || msg.mode === "default") moderationMode = msg.mode;
            try {
              saveSettings();
            } catch (err) {
              restoreSettings(previous);
              reportSettingsPersistenceFailure(ws, err);
              break;
            }
          }
          broadcastState();
          break;
        case "setCooldown": {
          const s = Math.round(Number(msg.seconds));
          if (Number.isFinite(s) && s >= 0 && s <= 300) {
            const previous = settingsSnapshot();
            cooldownSeconds = s;
            try { saveSettings(); } catch (err) {
              restoreSettings(previous);
              reportSettingsPersistenceFailure(ws, err);
              break;
            }
            broadcastState();
          }
          break;
        }
        case "setEventContext":
          {
            const previous = settingsSnapshot();
            eventContext = (msg.context || "").toString().slice(0, 300);
            try { saveSettings(); } catch (err) {
              restoreSettings(previous);
              reportSettingsPersistenceFailure(ws, err);
              break;
            }
          }
          broadcastState();
          break;
        case "setQueueLimit": {
          const previous = settingsSnapshot();
          const nextLimit = Number(msg.limit);
          if (typeof msg.on === "boolean") queueLimitOn = msg.on;
          if (QUEUE_LIMIT_STEPS.includes(nextLimit)) queueLimit = nextLimit;
          try { saveSettings(); } catch (err) {
            restoreSettings(previous);
            reportSettingsPersistenceFailure(ws, err);
            break;
          }
          broadcastState();
          break;
        }
        case "setRequireName":
          {
            const previous = settingsSnapshot();
            requireName = !!msg.on;
            try { saveSettings(); } catch (err) {
              restoreSettings(previous);
              reportSettingsPersistenceFailure(ws, err);
              break;
            }
          }
          broadcastState();
          break;
        case "registerOrderNetworkHost":
          if (!(HOST_PASSWORD && ws.hostAuthenticated) && currentSession?.role !== "admin") {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: "orderNetworkHostError", reason: "Hãy xác thực trang Host trước khi cập nhật mạng." }));
            }
            break;
          }
          {
            const nextHostIp = ws.__jukeboxClientIp;
            if (nextHostIp !== orderNetworkLockIp) {
              const previous = settingsSnapshot();
              orderNetworkLockIp = nextHostIp;
              try {
                saveSettings();
              } catch (err) {
                restoreSettings(previous);
                console.error(`[settings] unable to save: ${err.message}`);
                if (ws.readyState === 1) {
                  ws.send(JSON.stringify({ type: "orderNetworkHostError", reason: "Không thể lưu cài đặt lúc này. Vui lòng thử lại." }));
                }
                break;
              }
            }
          }
          ws.send(JSON.stringify({ type: "orderNetworkHostUpdated" }));
          break;
      }
    } catch (err) {
      console.error("[ws] message handling failed", err);
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "error", reason: "Yêu cầu không hợp lệ." }));
      }
    }
  });
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received; closing connections.`);
  clearInterval(sessionPruneTimer);
  clearInterval(wsHeartbeatTimer);
  clearInterval(dropExpiryTimer);
  chatAiCoordinator.stop();
  for (const client of wss.clients) client.close(1001, "Server shutting down");

  const forceExit = setTimeout(() => {
    closeDb();
    process.exit(1);
  }, 10_000);
  forceExit.unref?.();
  server.close((error) => {
    clearTimeout(forceExit);
    closeDb();
    if (error) {
      console.error("[server] graceful shutdown failed", error);
      process.exit(1);
    }
    process.exit(0);
  });
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

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
