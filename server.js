// Hệ thống âm nhạc sự kiện — jukebox QR cho máy chiếu.
//
//   /        -> trang host (chiếu trang này; hiển thị QR + trình phát + hàng đợi)
//   /guest   -> trang khách (điện thoại mở trang này qua mã QR)
//   /admin   -> bảng điều khiển quản trị (thành viên, airdrop, điểm, góp ý, chat)
//
// Quy trình khi khách yêu cầu bài hát:
//   1. rào chắn           — thời gian chờ, trùng lặp, giới hạn hàng đợi
//   2. checkPlayable()    — từ chối video đã xóa/riêng tư/không tồn tại
//   3. moderate()         — phán quyết LLM tùy chọn cho sự kiện này (fail-open)
//   4. state.add()        — thêm vào hàng đợi (SQLite SSOT); phát tới mọi client qua WebSocket

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

import { initDb } from "./src/db.js";
import { UserRepository } from "./src/repositories/userRepository.js";
import { SessionRepository } from "./src/repositories/sessionRepository.js";
import { LedgerRepository } from "./src/repositories/ledgerRepository.js";
import { QueueRepository } from "./src/repositories/queueRepository.js";
import { DropRepository } from "./src/repositories/dropRepository.js";
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

// --- Bộ nạp .env tối giản (không phụ thuộc) -------------------------------
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

// --- Khởi tạo SQLite Database & Repositories (SSOT) -----------------------
const db = initDb();
const userRepo = new UserRepository(db);
const sessionRepo = new SessionRepository(db);
const ledgerRepo = new LedgerRepository(db);
const queueRepo = new QueueRepository(db);
const dropRepo = new DropRepository(db);

if (!db.query("SELECT 1 FROM users WHERE role = 'admin' AND status = 'active' LIMIT 1").get()) {
  console.warn("[auth] Chưa có tài khoản admin active. Đặt ADMIN_USERNAME và ADMIN_PASSWORD trước lần khởi động đầu để tạo admin.");
}

const state = new JukeboxState(db);

// --- Cài đặt host được lưu bền vững ----------------------------------------
const DATA_DIR = path.join(__dirname, "data");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const FEEDBACK_PATH = path.join(DATA_DIR, "feedback.json");
let savedSettings = {};
try {
  savedSettings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
} catch {
  /* lần chạy đầu tiên — dùng .env bên dưới */
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
state.setVoteSort(voteSortOn);

const chatMessages = [];
const chatLastSentAt = new WeakMap();

let feedbackItems = [];
try {
  const storedFeedback = JSON.parse(readFileSync(FEEDBACK_PATH, "utf8"));
  feedbackItems = Array.isArray(storedFeedback) ? storedFeedback : [];
} catch {
  /* lần chạy đầu tiên — chưa có góp ý */
}

function saveSettings() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(
      SETTINGS_PATH,
      JSON.stringify(
        { filterOn, moderationMode, eventContext, cooldownSeconds, queueLimitOn, queueLimit, requireName, feedbackOn, chatOn, voteSortOn },
        null,
        2
      )
    );
  } catch (err) {
    console.warn(`[settings] không thể lưu: ${err.message}`);
  }
}

function saveFeedback() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FEEDBACK_PATH, JSON.stringify(feedbackItems, null, 2));
  } catch (err) {
    console.warn(`[feedback] không thể lưu: ${err.message}`);
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

// --- Xác thực host (Basic Auth hoặc Admin Session) ------------------------
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

// --- API XÁC THỰC & THÀNH VIÊN --------------------------------------------

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
    },
  });
});

// --- API ĐIỂM DANH & QUÀ TẶNG (POINT DROPS) -------------------------------

app.post("/api/me/checkin", requireAuth, (req, res) => {
  try {
    const result = performCheckin(db, req.user.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, reason: err.message });
  }
});

app.get("/api/me/points/history", requireAuth, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "20", 10)));
  const offset = (page - 1) * limit;

  const result = ledgerRepo.listByUser(req.user.id, { limit, offset });
  res.json({ ok: true, page, limit, total: result.total, ledger: result.ledger });
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

// --- API BÌNH CHỌN (VOTING) ------------------------------------------------

app.post("/api/queue/:itemId/vote", requireAuth, (req, res) => {
  try {
    const result = state.vote(req.params.itemId, req.user.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, reason: err.message });
  }
});

// --- API HỆ THỐNG & YOUTUBE -----------------------------------------------

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

// --- API QUẢN TRỊ ADMIN (/api/admin/*) --------------------------------------

app.get("/api/admin/users", requireAdmin, (req, res) => {
  const search = (req.query.search || "").toString().trim();
  const status = (req.query.status || "").toString().trim();
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "50", 10)));
  const offset = (page - 1) * limit;

  const result = userRepo.listUsers({ search, status, limit, offset });
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

// --- GÓP Ý & CHAT ---------------------------------------------------------

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
      chatMessages.length = 0;
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
  chatMessages.length = 0;
  const message = JSON.stringify({ type: "chatCleared" });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(message);
  }
  res.json({ ok: true, cleared });
});

// --- PHỤC VỤ TRANG HTML ---------------------------------------------------

const BOOT_ID = Date.now().toString(36);
function versionedPage(name) {
  const filePath = path.join(__dirname, "public", name);
  if (!existsSync(filePath)) return `<!DOCTYPE html><html><body><h1>${name} not found</h1></body></html>`;
  return readFileSync(filePath, "utf8").replace(
    /(href|src)="\/((?:guest|host|feedback|admin)\.(?:css|js))"/g,
    `$1="/$2?v=${BOOT_ID}"`
  );
}

const HOST_PAGE = versionedPage("host.html");
const GUEST_PAGE = versionedPage("guest.html");
const ADMIN_PAGE = versionedPage("admin.html");

app.get("/", requireHostAuth, (_req, res) => {
  res.set("Cache-Control", "no-cache").type("html").send(HOST_PAGE);
});

app.get("/guest", (_req, res) => {
  res.set("Cache-Control", "no-cache").type("html").send(GUEST_PAGE);
});

app.get("/admin", (_req, res) => {
  res.set("Cache-Control", "no-cache").type("html").send(ADMIN_PAGE);
});

app.get("/feedback", (_req, res) => {
  res.redirect(302, "/admin#feedback");
});

// --- WebSocket: ĐỒNG BỘ REALTIME & ĐIỀU KHIỂN HOST ------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function stateMessage() {
  return JSON.stringify({
    type: "state",
    state: state.snapshot(),
    filterOn,
    moderationMode,
    cooldownSeconds,
    eventContext,
    queueLimitOn,
    queueLimit,
    requireName,
    feedbackOn,
    chatOn,
    voteSortOn,
  });
}

function broadcastState() {
  const msg = stateMessage();
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}
state.onChange = broadcastState;

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
      const message = {
        id: randomUUID(),
        name: parsed.name,
        text: parsed.text,
        senderId: (msg.clientId || "").toString().slice(0, 64),
        isAdmin,
        createdAt: new Date().toISOString(),
      };
      pushRecentChat(chatMessages, message);
      chatLastSentAt.set(ws, now);
      const chatMessage = JSON.stringify({ type: "chatMessage", message });
      for (const client of wss.clients) {
        if (client.readyState === 1) client.send(chatMessage);
      }
      ws.send(JSON.stringify({ type: "chatSendResult", ok: true, id: message.id }));
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
        console.log(`[host] đã phát xong ${msg.videoId}`);
        state.advance(msg.videoId);
        break;
      case "error":
        console.warn(`[host] mã lỗi phát ${msg.code} trên ${msg.videoId} — bỏ qua & hoàn điểm`);
        state.advance(msg.videoId, { isError: true });
        break;
      case "skip":
        state.skip();
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
  console.log("\n  🎶  Hệ thống âm nhạc sự kiện đang chạy\n");
  console.log(`  Máy chiếu (host) : http://localhost:${PORT}/`);
  console.log(`  Khách quét QR    : ${GUEST_URL}`);
  console.log(`  Quản trị (admin) : http://localhost:${PORT}/admin`);
  console.log(
    `  Bộ lọc           : ${filterOn ? `BẬT (${moderationMode})` : "TẮT"} (đổi từ trang host) · ` +
      `LLM ${moderationConfigured() ? "đã cấu hình" : "CHƯA CẤU HÌNH — bộ lọc chấp thuận tất cả"}`
  );
  console.log(
    `  Mật khẩu host    : ${HOST_PASSWORD ? "ĐÃ ĐẶT — trang host yêu cầu đăng nhập" : "CHƯA ĐẶT — trang host mở cho mọi người"}\n`
  );
  if (LAN_IP === "127.0.0.1") {
    console.warn("  ⚠  Không phát hiện được IP LAN — khách trên thiết bị khác sẽ không thể kết nối.\n");
  }
});
