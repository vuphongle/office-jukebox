// Hệ thống âm nhạc sự kiện — jukebox QR cho máy chiếu.
//
//   /        -> trang host (chiếu trang này; hiển thị QR + trình phát + hàng đợi)
//   /guest   -> trang khách (điện thoại mở trang này qua mã QR)
//
// Quy trình khi khách yêu cầu bài hát:
//   1. rào chắn           — thời gian chờ, trùng lặp, giới hạn hàng đợi
//   2. checkPlayable()    — từ chối video đã xóa/riêng tư/không tồn tại
//   3. moderate()         — phán quyết LLM tùy chọn cho sự kiện này (fail-open)
//   4. state.add()        — thêm vào hàng đợi; phát tới mọi client qua WebSocket

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import QRCode from "qrcode";

import { searchYouTube, fetchVietnamChartHits, checkPlayable, fetchVideoDetails } from "./src/youtube.js";
import { moderate, moderationConfigured } from "./src/moderation.js";
import { JukeboxState } from "./src/state.js";
import { detectLanIp } from "./src/net.js";

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
// PUBLIC_URL (ví dụ https://grad-din-music.hangton.net) được ưu tiên khi ứng dụng
// chạy sau reverse proxy. Nếu không có, dùng IP LAN + port.
const PUBLIC_BASE = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const GUEST_URL = PUBLIC_BASE ? `${PUBLIC_BASE}/guest` : `http://${LAN_IP}:${PORT}/guest`;
// --- Cài đặt host được lưu bền vững ----------------------------------------
// Bộ lọc bật/tắt, chế độ kiểm duyệt, thời gian chờ và bối cảnh sự kiện đều có thể
// chỉnh trực tiếp từ trang host và được lưu qua các lần khởi động lại trong
// data/settings.json (docker-compose gắn ./data làm volume). Giá trị .env chỉ
// khởi tạo cho lần chạy đầu tiên.
const DATA_DIR = path.join(__dirname, "data");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
let savedSettings = {};
try {
  savedSettings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
} catch {
  /* lần chạy đầu tiên — dùng .env bên dưới */
}

// Bộ lọc (kiểm duyệt LLM): khi BẬT nhưng chưa cấu hình API key, kiểm duyệt sẽ
// fail-open (chấp thuận mọi thứ) — không gây hại.
let filterOn =
  savedSettings.filterOn ?? String(process.env.ENABLE_MODERATION || "").toLowerCase() === "true";
// "strict" = chỉ nội dung an toàn cho gia đình; "default" = chặn nội dung không
// phải âm nhạc/rõ ràng/không phù hợp.
let moderationMode =
  savedSettings.moderationMode ??
  ((process.env.MODERATION_MODE || "").toLowerCase() === "strict" ? "strict" : "default");
// Bối cảnh sự kiện cho LLM kiểm duyệt ("đây là loại sự kiện nào?") — một bản
// triển khai phục vụ nhiều địa điểm. Rỗng = dùng mặc định tích hợp trong moderation.js.
let eventContext = savedSettings.eventContext ?? (process.env.EVENT_CONTEXT || "");
// Thời gian chờ request theo từng khách (giây, 0 = tắt).
let cooldownSeconds = savedSettings.cooldownSeconds ?? 15;

function saveSettings() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(
      SETTINGS_PATH,
      JSON.stringify({ filterOn, moderationMode, eventContext, cooldownSeconds }, null, 2)
    );
  } catch (err) {
    console.warn(`[settings] không thể lưu: ${err.message}`);
  }
}

const app = express();
app.set("trust proxy", true); // chạy sau reverse proxy — req.ip cần đọc X-Forwarded-For
app.use(express.json());

// --- Xác thực host (tùy chọn) ---------------------------------------------
// HOST_PASSWORD trong .env bảo vệ trang máy chiếu (Basic Auth) và các điều khiển
// của trang (token theo mỗi lần khởi động được trang host gửi qua WebSocket).
// Khách không bao giờ cần mật khẩu này. Bỏ trống = mở trang host, phù hợp mạng
// LAN đáng tin cậy.
const HOST_PASSWORD = process.env.HOST_PASSWORD || "";
const hostToken = randomUUID();
function requireHostAuth(req, res, next) {
  if (!HOST_PASSWORD) return next();
  const b64 = (req.headers.authorization || "").split(" ")[1] || "";
  const pass = Buffer.from(b64, "base64").toString().split(":").slice(1).join(":");
  if (pass === HOST_PASSWORD) return next();
  // HTTP headers must be ASCII; keep the localized message in the response body.
  res.set("WWW-Authenticate", 'Basic realm="Event Music Host"').status(401).send("Yêu cầu mật khẩu.");
}
app.use("/host.html", requireHostAuth); // bản tĩnh không được bỏ qua bảo vệ của "/"

app.use(
  express.static(path.join(__dirname, "public"), {
    // Buộc xác thực lại ở mỗi lần tải (304 nhanh qua ETag). Nếu không, iOS Safari
    // có thể giữ JS/CSS cũ sau khi triển khai.
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
  })
);

const state = new JukeboxState();

// --- API HTTP -------------------------------------------------------------

// Khởi tạo trang host: URL của khách + mã QR trỏ tới URL đó.
app.get("/api/info", async (_req, res) => {
  try {
    const qr = await QRCode.toDataURL(GUEST_URL, { width: 480, margin: 1 });
    res.json({ guestUrl: GUEST_URL, qr, filterOn, moderationMode, moderationConfigured: moderationConfigured() });
  } catch {
    res.status(500).json({ error: "Không thể tạo mã QR." });
  }
});

// Khám phá/duyệt: cùng cách tìm kiếm YouTube nhưng có cache. Các tab thể loại và
// chip ca sĩ trên trang khách đều dùng các query định sẵn, nên một lần lấy dữ liệu
// phục vụ mọi khách trong TTL thay vì gọi YouTube cho từng lần chạm.
const browseCache = new Map(); // query -> { at, results }
const BROWSE_TTL_MS = 30 * 60 * 1000;

// Duyệt chỉ dành cho bài đơn: video tổng hợp "100 bài hát" dài một giờ vẫn qua
// bộ lọc tìm kiếm chỉ-video của YouTube, nhưng một bài đơn không dài như vậy.
const MAX_SINGLE_SECONDS = 10 * 60;
function durationSeconds(d) {
  if (!d || !/^[\d:]+$/.test(d)) return Infinity; // "LIVE"/không rõ → không phải bài đơn
  return d.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
}

app.get("/api/browse", async (req, res) => {
  const q = (req.query.q || "").toString().trim().slice(0, 100);
  if (!q) return res.json({ results: [] });
  const hit = browseCache.get(q);
  if (hit && Date.now() - hit.at < BROWSE_TTL_MS) return res.json({ results: hit.results });
  try {
    // "__vn_hits" is the All-tab sentinel: use the Vietnam chart instead of text search.
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

// Kiểm soát spam: mỗi khách chỉ được một request trong mỗi khoảng thời gian chờ
// (cooldownSeconds). Khóa dựa trên IP + clientId cố định của trang khách — tại sự
// kiện, phần lớn khách dùng chung một IP NAT của Wi-Fi địa điểm, nên chỉ dùng IP
// sẽ khiến cả buổi tiệc dùng chung thời gian chờ. (clientId do client chọn, nên
// người phá rối có chủ ý vẫn có thể đổi nó — nút xóa của host là lớp bảo vệ cuối.)
const lastRequestAt = new Map(); // "ip|clientId" -> thời điểm của lần thử cuối
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

// Khởi tạo trang host, phần 2: token điều khiển WS (được bảo vệ bằng Basic Auth,
// chỉ trang host đã xác thực mới lấy được token).
app.get("/api/host-token", requireHostAuth, (_req, res) => {
  res.json({ token: HOST_PASSWORD ? hostToken : "" });
});

// Khách yêu cầu bài hát.
app.post("/api/request", async (req, res) => {
  const { videoId, title, channel, duration, thumbnail, name, clientId } = req.body || {};
  const floodKey = `${req.ip}|${(clientId || "").toString().slice(0, 64)}`;
  const last = lastRequestAt.get(floodKey);
  if (cooldownSeconds > 0 && last) {
    const waitMs = cooldownSeconds * 1000 - (Date.now() - last);
    if (waitMs > 0) {
      const retryIn = Math.ceil(waitMs / 1000);
      // retryIn cho phép trang khách hiển thị đồng hồ đếm ngược trực tiếp.
      return res.json({ ok: false, reason: `Vui lòng chờ — thử lại sau ${retryIn} giây.`, retryIn });
    }
  }

  if (!videoId || !title) {
    return res.status(400).json({ ok: false, reason: "Thiếu thông tin bài hát." });
  }

  if (state.queue.length >= MAX_QUEUE_LENGTH) {
    return res.json({ ok: false, reason: "Hàng đợi đã đầy — vui lòng thử lại sau khi phát bớt bài." });
  }

  // Từ chối thêm lại bài hát đang phát hoặc đã có trong hàng đợi.
  if (state.has(videoId)) {
    return res.json({ ok: false, reason: "Bài hát này đã có trong hàng đợi!" });
  }

  // Chỉ bắt đầu tính thời gian chờ từ đây: các bước kiểm tra phía trên không tốn
  // tài nguyên và không nên khóa khách (ví dụ sau khi chạm vào bài trùng), còn
  // mọi bước bên dưới đều gọi YouTube và có thể gọi LLM — đó là phần cần bảo vệ.
  lastRequestAt.set(floodKey, Date.now());
  pruneLastRequestAt();

  // 1. Video có thực sự phát được không?
  const playable = await checkPlayable(videoId);
  if (!playable.ok) {
    return res.json({ ok: false, reason: playable.reason });
  }

  // 2. Bộ lọc (kiểm duyệt LLM) — chỉ chạy khi được bật. Bổ sung category /
  //    isFamilySafe / description của video rồi hỏi LLM. Fail-open.
  if (filterOn) {
    const details = await fetchVideoDetails(videoId); // cố gắng tối đa, có thể là null
    const verdict = await moderate({ title, channel }, details, {
      strict: moderationMode === "strict",
      ...(eventContext ? { eventContext } : {}),
    });
    if (!verdict.approved) {
      return res.json({ ok: false, reason: verdict.reason });
    }
  }

  // 3. Thêm vào hàng đợi.
  const { item, position } = state.add({ videoId, title, channel, duration, thumbnail, addedBy: name });
  res.json({ ok: true, reason: "Đã thêm!", position, id: item.id });
});

// Cloudflare ghi đè no-cache bằng TTL trình duyệt 4 giờ cho .js/.css, khiến các
// trang đang mở chạy script cũ sau khi triển khai. Gắn phiên bản vào URL asset
// để phá cache: mỗi lần khởi động (= mỗi lần triển khai) HTML trỏ tới URL mới.
const BOOT_ID = Date.now().toString(36);
function versionedPage(name) {
  return readFileSync(path.join(__dirname, "public", name), "utf8").replace(
    /(href|src)="\/((?:guest|host)\.(?:css|js))"/g,
    `$1="/$2?v=${BOOT_ID}"`
  );
}
const HOST_PAGE = versionedPage("host.html");
const GUEST_PAGE = versionedPage("guest.html");

// Trang host nằm tại "/".
app.get("/", requireHostAuth, (_req, res) => {
  res.set("Cache-Control", "no-cache").type("html").send(HOST_PAGE);
});

// Trang khách — mã QR trỏ tới đây (không có phần mở rộng nên static không phục vụ).
app.get("/guest", (_req, res) => {
  res.set("Cache-Control", "no-cache").type("html").send(GUEST_PAGE);
});

// --- WebSocket: đồng bộ hàng đợi thời gian thực + điều khiển host ------------
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
  });
}
function broadcastState() {
  const msg = stateMessage();
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}
state.onChange = broadcastState;

wss.on("connection", (ws) => {
  // Không có mật khẩu thì mọi socket đều có thể điều khiển (mạng LAN đáng tin);
  // nếu có, chỉ socket xác thực bằng token host mới được phép.
  ws.isHost = !HOST_PASSWORD;

  // Gửi trạng thái hiện tại ngay khi kết nối.
  ws.send(stateMessage());

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "auth") {
      if (!HOST_PASSWORD || msg.token === hostToken) ws.isHost = true;
      return;
    }
    if (!ws.isHost) return; // mọi loại message khác đều là điều khiển của host
    switch (msg.type) {
      case "ended": // trình phát host đã phát xong một bài
      case "error": // trình phát host không thể phát (tắt nhúng/bị khóa theo vùng)
        if (msg.type === "error") {
          console.warn(`[host] mã lỗi phát ${msg.code} trên ${msg.videoId} — bỏ qua`);
        } else {
          console.log(`[host] đã phát xong ${msg.videoId}`);
        }
        state.advance(msg.videoId);
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
      case "setFilter": // host chuyển bộ lọc nội dung: off / on / strict
        filterOn = !!msg.on;
        if (msg.mode === "strict" || msg.mode === "default") moderationMode = msg.mode;
        console.log(`[host] bộ lọc ${filterOn ? `BẬT (${moderationMode})` : "TẮT"}`);
        saveSettings();
        broadcastState();
        break;
      case "setCooldown": {
        // host điều chỉnh thời gian chờ request theo khách (0 = tắt)
        const s = Math.round(Number(msg.seconds));
        if (Number.isFinite(s) && s >= 0 && s <= 300) {
          cooldownSeconds = s;
          console.log(`[host] đã đặt thời gian chờ request là ${s ? s + " giây" : "TẮT"}`);
          saveSettings();
          broadcastState();
        }
        break;
      }
      case "setEventContext": // host mô tả địa điểm/dịp tổ chức cho bộ lọc
        eventContext = (msg.context || "").toString().slice(0, 300);
        console.log(`[host] đã đặt bối cảnh sự kiện: ${eventContext || "(mặc định)"}`);
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
