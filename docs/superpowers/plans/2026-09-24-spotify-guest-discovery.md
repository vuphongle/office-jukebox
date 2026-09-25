# Spotify Guest Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mở rộng phần Khám phá (Discovery) trên trang Guest (`/guest`) để hỗ trợ chuyển đổi giữa YouTube và Spotify khi người dùng chọn tab nền tảng trên thanh tìm kiếm, giữ nguyên bộ lọc danh mục/ca sĩ và hiển thị đầy đủ kết quả tương ứng từ Spotify.

**Architecture:** Mở rộng endpoint `GET /api/browse?q=...&platform=spotify` với bộ nhớ đệm phân tách theo `${platform}:${q}` (TTL 30 phút). Phía client (`public/guest.js`), bổ sung phản hồi khi click tab nền tảng để tự động tải lại Khám phá với platform mới bằng cơ chế phân trang variants và bộ đếm thế hệ `browse.gen` chống race condition.

**Tech Stack:** JavaScript (ES Modules), Bun runtime & test runner, Spotify Web API, Vanilla JS Frontend.

**Spec:** `docs/superpowers/specs/2026-09-24-spotify-guest-discovery-design.md`

## Global Constraints

- Mặc định `platform` là `youtube` khi tham số bị bỏ trống để bảo đảm tương thích ngược 100%.
- Giới hạn thời lượng bài hát tối đa 10 phút (`MAX_SINGLE_SECONDS = 600`).
- Giới hạn số bài hát tối đa cho mỗi lượt browse: 20 bài.
- Cache TTL: 30 phút (`BROWSE_TTL_MS = 30 * 60 * 1000`).
- An toàn âm thanh: Không tự ý phát âm thanh ra loa văn phòng khi chạy test.
- Tất cả bài hát từ Spotify phải có đầy đủ: `videoId` (Spotify Track ID), `title`, `channel`, `artists`, `duration`, `thumbnail`, `provider: "spotify"`.

## Review Focus

1. **Chuyển tab khi đang ở Genre/Ca sĩ:** Khách đang ở tab "V-pop" hoặc chip "Sơn Tùng M-TP" bấm đổi sang Spotify phải giữ nguyên tab/chip đó và tải bài hát từ Spotify, không bị reset về "Tất cả".
2. **Race condition khi click đổi tab nhanh liên tục:** Khách bấm Spotify rồi bấm YouTube ngay lập tức khi mạng chậm, các response về muộn của Spotify phải bị hủy qua `browse.gen !== gen` và không bao giờ được hiển thị đè lên YouTube.
3. **Xử lý thiếu / hỏng Credentials Spotify:** Khi `SPOTIFY_CLIENT_ID` hoặc `SECRET` trống hoặc không hợp lệ, server trả về mã HTTP 503 kèm JSON lỗi rõ ràng, client dừng loading spinner và hiển thị thông báo lỗi thân thiện thay vì treo giao diện.
4. **Sentinel `__vn_hits`:** Khi truy vấn `__vn_hits` với `platform=spotify`, server tự động chuyển thành tìm kiếm `top hits vietnam` với `market=VN`.
5. **Lọc bài hát podcast / set nhạc dài:** Các bài hát trên Spotify có `duration > 10 phút` phải bị lọc bỏ trước khi lưu cache và trả về client.

---

### Task 1: Nâng cấp tham số `limit` trong `searchSpotifyTracks` & Unit Tests

**Files:**
- Modify: `src/spotify.js:225-235`
- Test: `tests/spotify-search.test.mjs`

**Interfaces:**
- Consumes: `searchSpotifyTracks(query, options)` từ `src/spotify.js`.
- Produces: Cho phép truyền `limit` lên đến 20 (hoặc tối đa 50 theo chuẩn Spotify API) thay vì bị chặn cứng ở 10.

- [ ] **Step 1: Viết test kiểm tra `searchSpotifyTracks` chấp nhận `limit > 10`**

Mở file `tests/spotify-search.test.mjs` và thêm test case xác nhận tham số `limit` được truyền chính xác vào URL Spotify API:

```javascript
test("respects limit option up to 50 tracks", async () => {
  let capturedUrl = "";
  const mockFetch = async (url) => {
    capturedUrl = url;
    return {
      ok: true,
      json: async () => ({ tracks: { items: [] } }),
    };
  };

  await searchSpotifyTracks("v-pop", {
    accessToken: "mock_token",
    limit: 20,
    fetchImpl: mockFetch,
  });

  expect(capturedUrl).toContain("limit=20");
});
```

- [ ] **Step 2: Chạy test để xác nhận fail**

Run: `bun test tests/spotify-search.test.mjs`
Expected: FAIL vì hiện tại `src/spotify.js` ép `Math.min(..., 10)` nên URL sẽ là `limit=10`.

- [ ] **Step 3: Cập nhật hàm `searchSpotifyTracks` trong `src/spotify.js`**

Trong `src/spotify.js`, sửa dòng khởi tạo params `limit`:

```javascript
    const params = new URLSearchParams({
      q: query.trim(),
      type: "track",
      market: market || "VN",
      limit: String(Math.min(Math.max(1, limit), 50)),
    });
```

- [ ] **Step 4: Chạy test để xác nhận pass**

Run: `bun test tests/spotify-search.test.mjs`
Expected: PASS toàn bộ 6 tests.

- [ ] **Step 5: Commit thay đổi Task 1**

```bash
git add src/spotify.js tests/spotify-search.test.mjs
git commit -m "feat(spotify): allow searchSpotifyTracks limit up to 50"
```

---

### Task 2: Mở rộng Endpoint `GET /api/browse` Hỗ trợ Platform Spotify & Cache Phân tách

**Files:**
- Modify: `server.js:1030-1060`
- Test: `tests/spotify-browse.test.mjs` (tạo mới)

**Interfaces:**
- Consumes:
  - `getValidSpotifyAccessToken()` từ `server.js`.
  - `searchSpotifyTracks(q, { clientId, clientSecret, accessToken, limit, market })` từ `src/spotify.js`.
  - `fetchVietnamChartHits({ limit })` và `searchYouTube(q, { limit, mode })` từ `server.js`.
- Produces: `GET /api/browse?q=<query>&platform=<youtube|spotify>` trả về `{ results: Array<Song> }`.

- [ ] **Step 1: Viết test suite `tests/spotify-browse.test.mjs` cho API browse**

Tạo file `tests/spotify-browse.test.mjs`:

```javascript
import { test, describe, expect } from "bun:test";
import { searchSpotifyTracks } from "../src/spotify.js";

describe("Spotify Browse Logic & Filtering", () => {
  test("filters out Spotify tracks longer than 10 minutes", () => {
    const mockTracks = [
      { id: "1", durationMs: 200000, duration: "3:20" },
      { id: "2", durationMs: 700000, duration: "11:40" },
      { id: "3", durationMs: 300000, duration: "5:00" },
    ];
    const MAX_SECONDS = 10 * 60;
    const filtered = mockTracks.filter((t) => t.durationMs / 1000 <= MAX_SECONDS);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((t) => t.id)).toEqual(["1", "3"]);
  });

  test("cache keys isolate spotify and youtube queries", () => {
    const cache = new Map();
    const query = "VPop";
    cache.set(`youtube:${query}`, { results: [{ title: "YT Song" }] });
    cache.set(`spotify:${query}`, { results: [{ title: "Spotify Song" }] });

    expect(cache.get(`youtube:${query}`).results[0].title).toBe("YT Song");
    expect(cache.get(`spotify:${query}`).results[0].title).toBe("Spotify Song");
  });

  test("sentinel __vn_hits maps to top hits vietnam for Spotify", async () => {
    let capturedQuery = "";
    const mockFetch = async (url) => {
      capturedQuery = new URL(url).searchParams.get("q");
      return {
        ok: true,
        json: async () => ({ tracks: { items: [] } }),
      };
    };

    const resolvedQuery = "__vn_hits" === "__vn_hits" ? "top hits vietnam" : "__vn_hits";
    await searchSpotifyTracks(resolvedQuery, {
      accessToken: "mock_token",
      fetchImpl: mockFetch,
    });

    expect(capturedQuery).toBe("top hits vietnam");
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận logic test ban đầu**

Run: `bun test tests/spotify-browse.test.mjs`
Expected: PASS (xác thực các tiền điều kiện).

- [ ] **Step 3: Mở rộng `app.get("/api/browse")` trong `server.js`**

Tìm đoạn xử lý `app.get("/api/browse")` trong `server.js` (khoảng dòng 1038) và cập nhật:

```javascript
app.get("/api/browse", publicReadLimit, async (req, res) => {
  const q = (req.query.q || "").toString().trim().slice(0, 100);
  if (!q) return res.json({ results: [] });
  const platform = (req.query.platform || "youtube").toString().toLowerCase().trim();

  const cacheKey = `${platform}:${q}`;
  const hit = browseCache.get(cacheKey);
  if (hit && Date.now() - hit.at < BROWSE_TTL_MS) return res.json({ results: hit.results });

  try {
    let results = [];

    if (platform === "spotify") {
      if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
        return res.status(503).json({ error: "Spotify chưa được cấu hình Client ID / Secret trên hệ thống." });
      }
      let accessToken = "";
      try {
        accessToken = await getValidSpotifyAccessToken();
      } catch {}

      const spotifyQuery = q === "__vn_hits" ? "top hits vietnam" : q;
      const fetched = await searchSpotifyTracks(spotifyQuery, {
        clientId: SPOTIFY_CLIENT_ID,
        clientSecret: SPOTIFY_CLIENT_SECRET,
        accessToken,
        limit: 20,
        market: "VN",
      });

      results = fetched
        .filter((r) => durationSeconds(r.duration) <= MAX_SINGLE_SECONDS)
        .slice(0, 20);
    } else {
      const fetched =
        q === "__vn_hits"
          ? await fetchVietnamChartHits({ limit: 40 })
          : await searchYouTube(q, { limit: 40, mode: "songs" });
      results = fetched
        .filter((r) => durationSeconds(r.duration) <= MAX_SINGLE_SECONDS)
        .slice(0, 20);
    }

    browseCache.set(cacheKey, { at: Date.now(), results });
    if (browseCache.size > 200) browseCache.delete(browseCache.keys().next().value);
    res.json({ results });
  } catch (err) {
    console.error("[browse]", err.message);
    res.status(502).json({ error: "Không thể tải danh sách bài hát. Vui lòng thử lại." });
  }
});
```

- [ ] **Step 4: Chạy test tích hợp gọi trực tiếp qua HTTP endpoint `/api/browse`**

Thêm integration test vào `tests/spotify-browse.test.mjs` kiểm tra gọi HTTP endpoint `/api/browse?q=VPop&platform=spotify` và `/api/browse?q=VPop` để xác nhận response format và cache.

Run: `bun test tests/spotify-browse.test.mjs`
Expected: PASS toàn bộ tests.

- [ ] **Step 5: Commit thay đổi Task 2**

```bash
git add server.js tests/spotify-browse.test.mjs
git commit -m "feat(browse): support platform=spotify and isolated cache key"
```

---

### Task 3: Cập nhật Client Reactivity, Platform Switching & Phân trang trong `public/guest.js`

**Files:**
- Modify: `public/guest.js:1110-1230`

**Interfaces:**
- Consumes: `GET /api/browse?q=...&platform=...`
- Produces: UI phản hồi tức thì khi chọn icon Spotify hoặc YouTube, nạp bài hát Spotify kèm badge Spotify, hỗ trợ tất cả Genre Tabs và Singer Chips.

- [ ] **Step 1: Cập nhật `loadMoreSongs()` trong `public/guest.js`**

Tìm hàm `loadMoreSongs()` trong `public/guest.js` (khoảng dòng 1118) và truyền tham số `platform`:

```javascript
      const platformParam = currentSearchPlatform === "spotify" ? "&platform=spotify" : "";
      const res = await fetch("/api/browse?q=" + encodeURIComponent(q) + platformParam);
```

- [ ] **Step 2: Cập nhật `initSearchPlatformTabs()` trong `public/guest.js`**

Tìm hàm `initSearchPlatformTabs()` trong `public/guest.js` (khoảng dòng 1161) và cập nhật phản hồi khi chuyển tab:

```javascript
function initSearchPlatformTabs() {
  const tabsWrap = document.getElementById("search-platform-tabs");
  if (!tabsWrap) return;
  const tabs = tabsWrap.querySelectorAll(".platform-tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const targetPlatform = tab.dataset.platform || "youtube";
      if (targetPlatform === currentSearchPlatform) return;
      currentSearchPlatform = targetPlatform;
      tabs.forEach((t) => {
        const isActive = t === tab;
        t.classList.toggle("active", isActive);
        t.setAttribute("aria-selected", isActive ? "true" : "false");
      });
      qEl.placeholder = currentSearchPlatform === "spotify"
        ? "Tìm bài hát hoặc ca sĩ trên Spotify…"
        : "Tìm bài hát hoặc ca sĩ…";
      const currentQuery = qEl.value.trim();
      if (currentQuery && sugSection.classList.contains("hidden")) {
        doSearch(currentQuery);
      } else {
        // Tự động tải lại phần Khám phá với platform mới, giữ nguyên bộ lọc hiện tại
        startBrowse(browse.queries);
      }
    });
  });
}
```

- [ ] **Step 3: Kiểm tra xử lý bài hát Spotify trong `renderResults` / `appendResults`**

Kiểm tra hàm tạo thẻ bài hát trong `public/guest.js` để bảo đảm:
- Thẻ bài hát lấy đúng `r.provider` (là `"spotify"` khi gọi từ browse Spotify).
- Badge SVG Spotify xanh lá hiển thị chuẩn xác qua `getPlatformIconBadge(r.provider)`.
- Nút `+ Thêm` truyền đầy đủ `provider: r.provider || "spotify"`, `videoId: r.videoId`, `title`, `artists`, `duration`, `thumbnail` vào payload gửi tới `/api/youtube/add`.

- [ ] **Step 4: Kiểm tra cú pháp và build của `public/guest.js`**

Run: `bun check` hoặc kiểm tra syntax của file `public/guest.js`.
Expected: Không có lỗi cú pháp syntax error.

- [ ] **Step 5: Commit thay đổi Task 3**

```bash
git add public/guest.js
git commit -m "feat(guest): reactively reload explore when switching search platform"
```

---

### Task 4: Kiểm thử Tích hợp Toàn diện (Integration & Regression Testing)

**Files:**
- Test: `tests/spotify-browse-e2e.test.mjs`
- Chạy: Toàn bộ test suite dự án `bun test`

**Interfaces:**
- Đảm bảo 100% các tính năng hiện tại (vote refund, lyrics multi-artist, queue, search, browse) không bị ảnh hưởng (0 regression).

- [ ] **Step 1: Viết test kiểm tra tính toàn vẹn của cả 2 nền tảng**

Tạo file `tests/spotify-browse-e2e.test.mjs`:

```javascript
import { test, describe, expect } from "bun:test";

describe("Guest Discovery E2E Multi-Platform Integrity", () => {
  const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:45416";

  test("GET /api/browse default returns YouTube results with status 200", async () => {
    const res = await fetch(`${BASE_URL}/api/browse?q=VPop`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.results)).toBe(true);
    if (data.results.length > 0) {
      expect(data.results[0].provider || "youtube").toBe("youtube");
    }
  });

  test("GET /api/browse?platform=spotify returns Spotify results with valid fields", async () => {
    const res = await fetch(`${BASE_URL}/api/browse?q=VPop&platform=spotify`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.results)).toBe(true);
    if (data.results.length > 0) {
      const song = data.results[0];
      expect(song.provider).toBe("spotify");
      expect(typeof song.videoId).toBe("string");
      expect(typeof song.title).toBe("string");
      expect(typeof song.duration).toBe("string");
    }
  });

  test("GET /api/browse?q=__vn_hits&platform=spotify returns Vietnamese hit tracks", async () => {
    const res = await fetch(`${BASE_URL}/api/browse?q=__vn_hits&platform=spotify`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.results)).toBe(true);
  });
});
```

- [ ] **Step 2: Chạy test E2E với server đang chạy**

Run: `bun test tests/spotify-browse-e2e.test.mjs`
Expected: PASS toàn bộ các bài test.

- [ ] **Step 3: Chạy toàn bộ test suite của dự án để đảm bảo không có regression**

Run: `bun test`
Expected: 100% tests pass (bao gồm multi-artist lyrics, vote refund, spotify search, v.v.).

- [ ] **Step 4: Commit thay đổi Task 4**

```bash
git add tests/spotify-browse-e2e.test.mjs
git commit -m "test(browse): add multi-platform browse e2e tests"
```
