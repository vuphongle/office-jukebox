// Kiểm thử tải: mô phỏng N khách dùng điện thoại trên một bản triển khai đang chạy.
//
//   bun scripts/loadtest.mjs --url https://your-public-url --guests 140
//
// Mỗi khách ảo hoạt động như người dùng thật: tải /guest, giữ WebSocket mở
// (kết nối lại nếu bị ngắt, giống guest.js), chạm các tab duyệt,
// thỉnh thoảng tìm kiếm và thỉnh thoảng yêu cầu bài hát. In percentile độ trễ
// và số lỗi ở cuối.
//
// Tùy chọn (mặc định thực tế cho sự kiện khoảng 140 người):
//   --url URL             đích đến (mặc định http://localhost:45416)
//   --guests N            số khách đồng thời (mặc định 140)
//   --duration SECS       thời gian duy trì sau khi tăng dần (mặc định 120)
//   --ramp SECS           khoảng thời gian giãn kết nối (mặc định 20)
//   --browse-per-min N    tổng lượt duyệt/phút của mọi khách (mặc định 60; cache phía server)
//   --search-per-min N    tổng lượt tìm kiếm trực tiếp/phút (mặc định 6 — mỗi lượt gọi YouTube, giữ thấp)
//   --request-per-min N   tổng request bài hát/phút (mặc định 20 — gọi YouTube oEmbed + LLM nếu bộ lọc BẬT)
//
// Trước khi chạy trên production: TẮT bộ lọc từ trang host (hoặc chấp nhận khoảng
// request-per-min lần gọi LLM), rồi khởi động lại container sau đó để xóa hàng đợi
// thử nghiệm.

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const m = process.argv[i].match(/^--([a-z-]+)$/);
  if (m) args[m[1]] = process.argv[++i];
}

const BASE = (args.url || "http://localhost:45416").replace(/\/+$/, "");
const WS_BASE = BASE.replace(/^http/, "ws");
const GUESTS = parseInt(args.guests || "140", 10);
const DURATION_MS = parseInt(args.duration || "120", 10) * 1000;
const RAMP_MS = parseInt(args.ramp || "20", 10) * 1000;
const BROWSE_PER_MIN = parseFloat(args["browse-per-min"] || "60");
const SEARCH_PER_MIN = parseFloat(args["search-per-min"] || "6");
const REQUEST_PER_MIN = parseFloat(args["request-per-min"] || "20");

// Các query tab/chip định sẵn của trang khách — thân thiện với cache.
const BROWSE_QUERIES = [
  "__hk_hits",
  "廣東歌 2024",
  "廣東歌 90年代",
  "英文流行曲",
  "K-pop hits",
  "畢業歌",
];
const SEARCH_QUERIES = [
  "周杰倫", "陳奕生 富士山下", "Taylor Swift", "MIRROR", "張學友",
  "aespa", "Ed Sheeran", "五月天", "林家謙", "IU",
];

// --- chỉ số -----------------------------------------------------------------
const lat = { page: [], wsFirstState: [], browse: [], search: [], request: [] };
const counts = {
  wsConnected: 0, wsDropped: 0, wsReconnects: 0, wsFailed: 0,
  broadcasts: 0,
  browseOk: 0, browseErr: 0,
  searchOk: 0, searchErr: 0,
  requestAccepted: 0, requestRejected: 0, requestErr: 0,
};
const errors = new Map(); // message -> count
function noteErr(msg) {
  errors.set(msg, (errors.get(msg) || 0) + 1);
}
function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
function fmt(arr) {
  if (!arr.length) return "  (no samples)";
  return `  n=${arr.length}  p50=${pct(arr, 50)}ms  p95=${pct(arr, 95)}ms  max=${Math.max(...arr)}ms`;
}

// --- lấy videoId thật để /api/request chạy qua pipeline thực -----------------
async function harvestVideoIds() {
  const ids = [];
  for (const q of BROWSE_QUERIES.slice(0, 4)) {
    try {
      const r = await fetch(`${BASE}/api/browse?q=${encodeURIComponent(q)}`);
      const j = await r.json();
      for (const item of j.results || []) ids.push(item);
    } catch {
      /* server vẫn được kiểm thử; chỉ bỏ qua request */
    }
  }
  return ids;
}

// --- một khách ảo -----------------------------------------------------------
let stopping = false;
const sockets = new Set();

async function timedFetch(bucket, okCounter, errCounter, url, opts) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, opts);
    const j = await r.json();
    lat[bucket].push(Date.now() - t0);
    if (r.ok) counts[okCounter]++;
    else {
      counts[errCounter]++;
      noteErr(`${bucket} HTTP ${r.status}`);
    }
    return j;
  } catch (err) {
    lat[bucket].push(Date.now() - t0);
    counts[errCounter]++;
    noteErr(`${bucket}: ${err.message}`);
    return null;
  }
}

function connectWs(guest) {
  const t0 = Date.now();
  let gotFirstState = false;
  try {
    const ws = new WebSocket(`${WS_BASE}/`);
    sockets.add(ws);
    ws.onopen = () => {
      counts.wsConnected++;
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "state") {
          counts.broadcasts++;
          if (!gotFirstState) {
            gotFirstState = true;
            lat.wsFirstState.push(Date.now() - t0);
          }
        }
      } catch { /* ignore */ }
    };
    ws.onclose = () => {
      sockets.delete(ws);
      if (!stopping) {
        counts.wsDropped++;
        counts.wsReconnects++;
        setTimeout(() => connectWs(guest), 1000 + Math.random() * 2000);
      }
    };
    ws.onerror = () => { /* onclose fires after */ };
  } catch (err) {
    counts.wsFailed++;
    noteErr(`ws connect: ${err.message}`);
  }
}

function poisson(perMinutePerGuest) {
  // số mili giây tới hành động tiếp theo của khách này, phân phối mũ
  if (perMinutePerGuest <= 0) return Infinity;
  return -Math.log(1 - Math.random()) * (60000 / perMinutePerGuest);
}

async function runGuest(i, videoPool) {
  const clientId = `loadtest-${i}-${Math.random().toString(36).slice(2, 10)}`;

  // 1. tải trang
  const t0 = Date.now();
  try {
    await fetch(`${BASE}/guest`);
    lat.page.push(Date.now() - t0);
  } catch (err) {
    lat.page.push(Date.now() - t0);
    noteErr(`page: ${err.message}`);
  }

  // 2. WebSocket duy trì
  connectWs(i);

  // 3. vòng lặp hành vi — tốc độ theo từng khách để tổng đạt mục tiêu cấu hình
  const loops = [
    [BROWSE_PER_MIN / GUESTS, async () => {
      const q = BROWSE_QUERIES[Math.floor(Math.random() * BROWSE_QUERIES.length)];
      await timedFetch("browse", "browseOk", "browseErr", `${BASE}/api/browse?q=${encodeURIComponent(q)}`);
    }],
    [SEARCH_PER_MIN / GUESTS, async () => {
      const q = SEARCH_QUERIES[Math.floor(Math.random() * SEARCH_QUERIES.length)];
      await timedFetch("search", "searchOk", "searchErr", `${BASE}/api/search?q=${encodeURIComponent(q)}`);
    }],
    [REQUEST_PER_MIN / GUESTS, async () => {
      if (!videoPool.length) return;
      const v = videoPool[Math.floor(Math.random() * videoPool.length)];
      const j = await timedFetch("request", "requestAccepted", "requestErr", `${BASE}/api/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...v, name: `LoadTester ${i}`, clientId }),
      });
      // ok:false (thời gian chờ / trùng / hàng đợi đầy / bộ lọc) là traffic dự kiến,
      // không phải lỗi — phân loại lại.
      if (j && j.ok === false) {
        counts.requestAccepted--;
        counts.requestRejected++;
      }
    }],
  ];

  for (const [rate, action] of loops) {
    (async () => {
      while (!stopping) {
        const wait = poisson(rate);
        if (wait === Infinity) return;
        await new Promise((r) => setTimeout(r, wait));
        if (stopping) return;
        await action();
      }
    })();
  }
}

// --- chính -------------------------------------------------------------------
console.log(`Mục tiêu: ${BASE}`);
console.log(`Khách: ${GUESTS}, tăng dần ${RAMP_MS / 1000}s, duy trì ${DURATION_MS / 1000}s`);
console.log(`Tốc độ/phút (tổng): browse=${BROWSE_PER_MIN} search=${SEARCH_PER_MIN} request=${REQUEST_PER_MIN}\n`);

const videoPool = await harvestVideoIds();
console.log(`Đã lấy ${videoPool.length} videoId thật cho traffic request.`);
if (!videoPool.length) console.log("(!) Không lấy được videoId — /api/request sẽ không được kiểm thử.");

for (let i = 0; i < GUESTS; i++) {
  setTimeout(() => runGuest(i, videoPool), Math.random() * RAMP_MS);
}

const total = RAMP_MS + DURATION_MS;
const startedAt = Date.now();
const ticker = setInterval(() => {
  const el = Math.round((Date.now() - startedAt) / 1000);
  process.stdout.write(
    `\r[${el}s] ws=${sockets.size} broadcasts=${counts.broadcasts} ` +
    `browse=${counts.browseOk}/${counts.browseErr}err search=${counts.searchOk}/${counts.searchErr}err ` +
    `req=${counts.requestAccepted}ok/${counts.requestRejected}rej/${counts.requestErr}err   `
  );
}, 2000);

await new Promise((r) => setTimeout(r, total));
stopping = true;
clearInterval(ticker);
for (const ws of sockets) try { ws.close(); } catch { /* ignore */ }

console.log("\n\n=== KẾT QUẢ ==============================================");
console.log(`WebSocket   đã kết nối=${counts.wsConnected} ngắt=${counts.wsDropped} kết nối lại=${counts.wsReconnects} thất bại=${counts.wsFailed}`);
console.log(`Broadcast    đã nhận=${counts.broadcasts} (từ mọi khách)`);
console.log(`\nĐộ trễ:`);
console.log(`  Trang /guest     ${fmt(lat.page)}`);
console.log(`  WS -> trạng thái đầu tiên ${fmt(lat.wsFirstState)}`);
console.log(`  /api/browse      ${fmt(lat.browse)}`);
console.log(`  /api/search      ${fmt(lat.search)}`);
console.log(`  /api/request     ${fmt(lat.request)}`);
console.log(`\nRequest: chấp nhận=${counts.requestAccepted} từ chối(chờ/trùng/đầy/bộ lọc)=${counts.requestRejected} lỗi=${counts.requestErr}`);
if (errors.size) {
  console.log(`\nLỗi:`);
  for (const [msg, n] of errors) console.log(`  ${n}x  ${msg}`);
} else {
  console.log(`\nKhông có lỗi. 🎉`);
}
process.exit(0);
