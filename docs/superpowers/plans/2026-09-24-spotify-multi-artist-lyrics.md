# Kế hoạch triển khai: Tối ưu Lời bài hát Spotify Đa Nghệ sĩ (Spotify Multi-Artist Lyrics Optimization)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tối ưu hóa việc tìm kiếm và hiển thị lời bài hát đồng bộ (synced lyrics) cho bài hát Spotify: khi một bài hát được order, trích xuất toàn bộ danh sách nghệ sĩ tham gia (chính + hợp tác/featuring), tìm kiếm và chấm điểm ứng viên lyrics để chọn chính xác phiên bản có đủ tất cả các nghệ sĩ, loại bỏ hoàn toàn các bản cover/remix/live lệch thời gian, hỗ trợ pre-fetch ngầm khi order bài, và xử lý toàn diện các tình huống biên/lỗi ngoại lệ.

**Architecture:**
- **Metadata Extraction (`src/spotify.js`, `src/mediaLinkResolver.js`):** Trích xuất danh sách mảng nghệ sĩ đầy đủ (`artists: string[]`) từ Spotify Web API `data.artists` và fallback regex cho oEmbed/Title, lưu giữ `durationMs` chính xác.
- **Candidate Scoring & Matching Engine (`src/lyricsMatcher.js`):** Xây dựng bộ chấm điểm ứng viên lyrics độc lập: chuẩn hóa tiếng Việt/Unicode/ký tự đặc biệt, kiểm tra độ bao phủ tập hợp nghệ sĩ (Artist Overlap Set Containment), đối chiếu dung sai thời lượng (Duration Tolerance: ±2s đến ±5s), phát hiện xung đột phiên bản (Remix / Live / Acoustic / Cover / Speed Up).
- **Multi-Query Search & Fallback Hierarchy (`src/lyricsService.js`):** Nâng cấp service lyrics với chiến lược tìm kiếm đa truy vấn theo thứ tự ưu tiên (Exact Multi-Artist `/api/get` → Primary Artist `/api/get` → Multi-Artist Fuzzy `/api/search` → Primary Fuzzy → Title Fallback), xếp hạng và chọn ứng viên tốt nhất vượt ngưỡng tin cậy an toàn; nếu không có bản khớp an toàn thì trả về thông báo chưa có lời thay vì nạp lời sai từ bài khác.
- **Pre-Caching & State Integration (`src/state.js`, `server.js`):** Khi bài hát Spotify được order qua `POST /api/request`, lưu mảng `artists` vào queue item và kích hoạt tiến trình nạp trước lyrics (pre-fetch) không đồng bộ trong nền (unawaited background task), giúp lời bài hát sẵn sàng tức thì (0ms) khi phát hoặc khi mở giao diện lyrics.
- **Client Resilience (`public/lyrics-client.js`, `public/host.js`, `public/guest.js`):** Cập nhật client truyền danh sách `artists` lên backend và đồng bộ thuật toán lọc ở client fallback để tránh chọn nhầm bản cover/remix khi chạy độc lập trên trình duyệt.

**Tech Stack:** Node.js / Bun, Express, SQLite, LRCLIB API, Vanilla JS, Test-Driven Development (TDD) với `node:test` / Bun test runner.

**Spec:** Yêu cầu từ user:
1. Khi order một bài hát Spotify, cần kiểm tra tên tất cả nghệ sĩ có trong bài đó.
2. Tìm kiếm đúng bản lyrics có đủ tất cả nghệ sĩ đó, tránh tình trạng lấy nhầm phiên bản (cover, remix, acoustic, bài trùng tên của nghệ sĩ khác).
3. Triển khai toàn diện xử lý các tình huống không mong muốn (unwanted cases/edge cases), không chỉ làm mỗi happy case.

---

## Global Constraints

- **MANDATORY AUDIO SAFETY:** Tuyệt đối không phát âm thanh thật ra loa văn phòng khi chạy test hoặc phát triển. Mọi test chạy trên môi trường cô lập (:memory: db, mock fetch).
- **ZERO LIVE DISRUPTION:** Không can thiệp hoặc làm gián đoạn tiến trình `bun server.js` đang phục vụ nhạc cho văn phòng.
- **BACKWARD COMPATIBILITY:** Giữ nguyên 100% khả năng tương thích cho các nguồn nhạc khác (YouTube, SoundCloud, TikTok) và các bài hát cũ chỉ có string `channel`.
- **FAIL-SAFE LYRICS:** Thà hiển thị "Chưa có lời bài hát đồng bộ cho bài hát này" còn hơn hiển thị sai lời của ca sĩ khác hoặc phiên bản lệch nhịp.

---

## Review Focus

1. **LRCLIB trả về bản cover/parody/remix có synced lyrics thay vì bản gốc đa nghệ sĩ:** Thuật toán chấm điểm phải loại bỏ bản cover (nghệ sĩ không khớp) và remix lệch thời lượng (>5s), rơi về đúng bản gốc hoặc safe fallback.
2. **Nghệ sĩ phụ nằm trong tiêu đề bài hát (ví dụ: `Catch Me If You Can (feat. Quang Hùng MasterD)`):** Bộ trích xuất phải gom được cả nghệ sĩ từ `artists` array và từ pattern `(feat. ...)` trong title để kiểm tra đầy đủ.
3. **Sai khác dấu tiếng Việt, viết hoa, dấu ngoặc kép hoặc ký tự nối (ví dụ: `Sơn Tùng M-TP` vs `Son Tung M-TP`, `Anh Trai "Say Hi"` vs `Anh Trai Say Hi`):** Chuẩn hóa Unicode/dấu câu đảm bảo so khớp chính xác mà không bị false-positive (ví dụ tên ngắn "An" không được match nhầm vào "Anh Tú").
4. **Sai lệch thời lượng giữa bản Single và bản Album (chênh lệch 1-3 giây khoảng lặng đầu bài):** Hệ thống chấp nhận sai số nhỏ (±2s) cho cùng bản thu nhưng từ chối các bản sai thời lượng lớn (>5-10s).
5. **LRCLIB bị chậm, timeout (AbortController), hoặc trả về HTTP 429/500 khi order bài:** Tác vụ pre-fetch chạy nền an toàn, không làm treo hoặc chậm response của API `/api/request` của khách order bài.

---

## Task Decomposition

### Task 1: Trích xuất và Bảo tồn Mảng Đa Nghệ sĩ từ Spotify

**Files:**
- Modify: `src/spotify.js:108-160, 220-245`
- Modify: `src/mediaLinkResolver.js:50-71`
- Test: `tests/spotify-artists-metadata.test.mjs`

**Interfaces:**
- Consumes: Spotify Web API track payload (`data.artists: Array<{ name: string }>`), oEmbed payload (`data.author_name: string`), track title string.
- Produces: Metadata object trả về chứa:
  - `artists: string[]` (danh sách tên tất cả nghệ sĩ đã làm sạch và loại bỏ trùng lặp)
  - `durationMs: number` (thời lượng mili-giây chính xác)
  - `channel: string` (chuỗi hiển thị tương thích ngược: `"Artist 1, Artist 2"`)

- [ ] **Step 1: Viết test thất bại (Failing Test) cho việc trích xuất `artists` từ Spotify API và oEmbed**

Tạo file `tests/spotify-artists-metadata.test.mjs`:
```javascript
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fetchSpotifyTrackMetadata, parseArtistListFromString } from "../src/spotify.js";

describe("Spotify Multi-Artist Extraction", () => {
  test("parseArtistListFromString splits commas, &, feat, and x cleanly", () => {
    const raw = "TINH HÀ \"SAY HI\", Quang Hùng MasterD & RHYDER feat. Captain Boy x Lou Hoàng";
    const artists = parseArtistListFromString(raw);
    assert.deepEqual(artists, [
      "TINH HÀ \"SAY HI\"",
      "Quang Hùng MasterD",
      "RHYDER",
      "Captain Boy",
      "Lou Hoàng",
    ]);
  });

  test("fetchSpotifyTrackMetadata returns artists array and durationMs from API response", async () => {
    const mockTrack = {
      id: "4cOdK2wGLETKBW3PvgPWqT",
      name: "Ngáo Ngơ (feat. Orange)",
      artists: [
        { name: "HIEUTHUHAI" },
        { name: "ERIK" },
        { name: "Anh Tú Atus" },
        { name: "JSOL" },
      ],
      duration_ms: 215430,
      album: { images: [{ url: "https://example.com/cover.jpg" }] },
    };

    const mockFetch = async () => ({
      ok: true,
      json: async () => mockTrack,
    });

    const meta = await fetchSpotifyTrackMetadata("4cOdK2wGLETKBW3PvgPWqT", {
      accessToken: "mock_token",
      fetchImpl: mockFetch,
    });

    assert.ok(meta);
    assert.equal(meta.title, "Ngáo Ngơ (feat. Orange)");
    assert.ok(Array.isArray(meta.artists));
    assert.ok(meta.artists.includes("HIEUTHUHAI"));
    assert.ok(meta.artists.includes("ERIK"));
    assert.ok(meta.artists.includes("Orange")); // Trích xuất thêm từ feat trong title
    assert.equal(meta.durationMs, 215430);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận test thất bại**

Run: `bun test tests/spotify-artists-metadata.test.mjs`
Expected: FAIL vì `parseArtistListFromString` chưa được export và `meta.artists` chưa có.

- [ ] **Step 3: Cập nhật `src/spotify.js` để triển khai trích xuất danh sách nghệ sĩ**

Trong `src/spotify.js`, thêm hàm `parseArtistListFromString(raw)` và cập nhật `fetchSpotifyTrackMetadata` cùng `searchSpotifyTracks`:
```javascript
export function parseArtistListFromString(raw) {
  if (typeof raw !== "string" || !raw.trim()) return [];
  // Tách theo dấu phẩy, &, x, vs, feat., ft., with, và
  const splitRegex = /\s*(?:,|&|\band\b|\bwith\b|\bfeat\.?|\bft\.?|\bx\b|\bvs\.?|\bvà\b)\s*/gi;
  const parts = raw.split(splitRegex);
  const seen = new Set();
  const result = [];
  for (const p of parts) {
    const cleaned = p.replace(/^["']|["']$/g, "").trim();
    const lower = cleaned.toLowerCase();
    if (cleaned && !seen.has(lower) && !/^(official|audio|mv|topic)$/i.test(cleaned)) {
      seen.add(lower);
      result.push(cleaned);
    }
  }
  return result;
}

export function extractFeaturedArtistsFromTitle(title) {
  if (typeof title !== "string") return [];
  const match = title.match(/\((?:feat\.?|ft\.?|with)\s+([^)]+)\)/i);
  if (!match) return [];
  return parseArtistListFromString(match[1]);
}
```

Và trong `fetchSpotifyTrackMetadata`:
```javascript
const apiArtists = Array.isArray(data.artists)
  ? data.artists.map((a) => a.name?.trim()).filter(Boolean)
  : [];
const titleFeatured = extractFeaturedArtistsFromTitle(title);
const allArtists = Array.from(new Set([...apiArtists, ...titleFeatured]));

return {
  videoId: trackId,
  title,
  channel: allArtists.join(", ") || "Spotify Artist",
  artists: allArtists,
  duration: formatDurationMs(data.duration_ms),
  durationMs: data.duration_ms,
  thumbnail: image,
  provider: "spotify",
};
```
Đồng thời cập nhật fallback `fetchSpotifyOEmbed` và `searchSpotifyTracks` để luôn trả về `artists: string[]`.

- [ ] **Step 4: Chạy lại test để xác nhận test vượt qua (PASS)**

Run: `bun test tests/spotify-artists-metadata.test.mjs`
Expected: PASS cả 2 tests.

- [ ] **Step 5: Commit task 1**

```bash
git add src/spotify.js tests/spotify-artists-metadata.test.mjs
git commit -m "feat(spotify): extract and preserve multi-artist list and exact duration"
```

---

### Task 2: Xây dựng Module Chấm điểm và Xác minh Ứng viên Lyrics (`src/lyricsMatcher.js`)

**Files:**
- Create: `src/lyricsMatcher.js`
- Test: `tests/lyrics-matcher.test.mjs`

**Interfaces:**
- Consumes:
  - `candidate`: `{ trackName, artistName, duration, syncedLyrics, plainLyrics }`
  - `target`: `{ targetTitle: string, targetArtists: string[], targetDurationSec: number | null }`
- Produces:
  - `scoreLyricsCandidate(candidate, target)`:
    - `{ score: number, allArtistsMatched: boolean, matchedArtists: string[], missingArtists: string[], isAcceptable: boolean, reason: string }`
  - `normalizeText(str)`: string chuẩn hóa chữ thường, bỏ dấu và ký tự thừa.

- [ ] **Step 1: Viết test thất bại cho bộ đối soát nghệ sĩ và chấm điểm phiên bản lyrics**

Tạo file `tests/lyrics-matcher.test.mjs`:
```javascript
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { scoreLyricsCandidate, normalizeSearchText } from "../src/lyricsMatcher.js";

describe("Lyrics Matcher & Candidate Scoring", () => {
  const target = {
    targetTitle: "Ngáo Ngơ",
    targetArtists: ["HIEUTHUHAI", "ERIK", "Anh Tú Atus", "JSOL"],
    targetDurationSec: 215, // 3:35
  };

  test("Gives top score to candidate having ALL artists, synced lyrics, and matching duration", () => {
    const candidate = {
      trackName: "Ngáo Ngơ",
      artistName: "HIEUTHUHAI, ERIK, Anh Tú Atus, JSOL",
      duration: 216,
      syncedLyrics: "[00:10.00]Lời bài hát...",
      plainLyrics: "Lời bài hát...",
    };

    const res = scoreLyricsCandidate(candidate, target);
    assert.equal(res.allArtistsMatched, true);
    assert.equal(res.missingArtists.length, 0);
    assert.ok(res.isAcceptable);
    assert.ok(res.score >= 100);
  });

  test("Recognizes artists even if featured in trackName instead of artistName", () => {
    const candidate = {
      trackName: "Ngáo Ngơ (feat. ERIK, Anh Tú Atus, JSOL)",
      artistName: "HIEUTHUHAI",
      duration: 214,
      syncedLyrics: "[00:10.00]Lời...",
    };

    const res = scoreLyricsCandidate(candidate, target);
    assert.equal(res.allArtistsMatched, true);
    assert.ok(res.isAcceptable);
  });

  test("Disqualifies candidate from a completely different cover artist", () => {
    const coverCandidate = {
      trackName: "Ngáo Ngơ (Cover)",
      artistName: "Nguyễn Văn A",
      duration: 210,
      syncedLyrics: "[00:05.00]Cover...",
    };

    const res = scoreLyricsCandidate(coverCandidate, target);
    assert.equal(res.allArtistsMatched, false);
    assert.equal(res.isAcceptable, false);
    assert.ok(res.score < 30);
  });

  test("Penalizes / rejects Remix version when target song is original and duration differs > 15s", () => {
    const remixCandidate = {
      trackName: "Ngáo Ngơ - Remix",
      artistName: "HIEUTHUHAI, ERIK, Anh Tú Atus, JSOL",
      duration: 150, // 2:30 vs 3:35
      syncedLyrics: "[00:02.00]Remix...",
    };

    const res = scoreLyricsCandidate(remixCandidate, target);
    assert.equal(res.isAcceptable, false);
  });

  test("Matches Vietnamese names with or without diacritics and smart quotes", () => {
    const candidate = {
      trackName: "Chay Ngay Di",
      artistName: "Son Tung M-TP, Snoop Dogg",
      duration: 198,
      syncedLyrics: "[00:01.00]Chay ngay di...",
    };
    const tg = {
      targetTitle: "Chạy Ngay Đi",
      targetArtists: ["Sơn Tùng M-TP", "Snoop Dogg"],
      targetDurationSec: 200,
    };
    const res = scoreLyricsCandidate(candidate, tg);
    assert.equal(res.allArtistsMatched, true);
    assert.ok(res.isAcceptable);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận test thất bại**

Run: `bun test tests/lyrics-matcher.test.mjs`
Expected: FAIL vì `src/lyricsMatcher.js` chưa tồn tại.

- [ ] **Step 3: Cài đặt `src/lyricsMatcher.js`**

Tạo `src/lyricsMatcher.js`:
```javascript
// Candidate scoring and multi-artist containment engine for lyrics matching.

export function stripDiacritics(str) {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

export function normalizeSearchText(str) {
  if (typeof str !== "string") return "";
  return str
    .toLowerCase()
    .replace(/["'“”‘’`]/g, "")
    .replace(/[–—_]/g, "-")
    .replace(/[()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const VERSION_MODIFIERS = [
  "remix",
  "acoustic",
  "live",
  "cover",
  "instrumental",
  "karaoke",
  "speed up",
  "slowed",
  "nightcore",
  "edit",
];

export function extractVersionTags(text) {
  const norm = normalizeSearchText(text);
  return VERSION_MODIFIERS.filter((mod) => norm.includes(mod));
}

export function containsArtist(haystack, artistName) {
  if (!haystack || !artistName) return false;
  const hNorm = normalizeSearchText(haystack);
  const aNorm = normalizeSearchText(artistName);

  // 1. Exact normalized match with word boundary check
  const escaped = aNorm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i");
  if (regex.test(hNorm)) return true;

  // 2. Fallback to diacritic-free match
  const hNoDia = stripDiacritics(hNorm);
  const aNoDia = stripDiacritics(aNorm);
  const escNoDia = aNoDia.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regexNoDia = new RegExp(`(?:^|[^a-z0-9])${escNoDia}(?:$|[^a-z0-9])`, "i");
  return regexNoDia.test(hNoDia);
}

export function scoreLyricsCandidate(candidate, { targetTitle, targetArtists = [], targetDurationSec = null }) {
  if (!candidate || typeof candidate !== "object") {
    return { score: 0, allArtistsMatched: false, matchedArtists: [], missingArtists: targetArtists, isAcceptable: false, reason: "invalid_candidate" };
  }

  const combinedCandidateText = `${candidate.trackName || ""} ${candidate.artistName || ""}`;
  const matchedArtists = [];
  const missingArtists = [];

  for (const artist of targetArtists) {
    if (containsArtist(combinedCandidateText, artist)) {
      matchedArtists.push(artist);
    } else {
      missingArtists.push(artist);
    }
  }

  const totalRequired = Math.max(1, targetArtists.length);
  const allArtistsMatched = targetArtists.length > 0 && missingArtists.length === 0;
  const artistMatchRatio = targetArtists.length > 0 ? matchedArtists.length / targetArtists.length : 0.5;

  let score = 0;

  // 1. Artist overlap score (up to 50 pts)
  if (allArtistsMatched) {
    score += 50;
  } else {
    score += Math.round(artistMatchRatio * 35);
  }

  // 2. Synced vs Plain (up to 30 pts)
  const hasSynced = Boolean(candidate.syncedLyrics && typeof candidate.syncedLyrics === "string" && candidate.syncedLyrics.trim());
  const hasPlain = Boolean(candidate.plainLyrics && typeof candidate.plainLyrics === "string" && candidate.plainLyrics.trim());

  if (hasSynced) score += 30;
  else if (hasPlain) score += 10;
  else return { score: 0, allArtistsMatched, matchedArtists, missingArtists, isAcceptable: false, reason: "no_lyrics_content" };

  // 3. Duration match (up to 20 pts or severe penalty)
  let durationDiff = null;
  if (targetDurationSec && Number.isFinite(targetDurationSec) && candidate.duration && Number.isFinite(candidate.duration)) {
    durationDiff = Math.abs(candidate.duration - targetDurationSec);
    if (durationDiff <= 2) {
      score += 20; // Excellent match
    } else if (durationDiff <= 5) {
      score += 10; // Acceptable tolerance
    } else if (durationDiff <= 15) {
      score -= 20; // Questionable
    } else {
      score -= 80; // Definite different version or edit
    }
  }

  // 4. Version modifier check (prevent Remix vs Original, Live vs Studio, etc.)
  const targetTags = extractVersionTags(targetTitle);
  const candidateTags = extractVersionTags(combinedCandidateText);

  // If candidate has a version tag that target DOES NOT have (e.g. candidate is Remix/Cover/Acoustic but target is not)
  const extraCandidateTags = candidateTags.filter((t) => !targetTags.includes(t));
  if (extraCandidateTags.length > 0) {
    if (extraCandidateTags.includes("cover") || extraCandidateTags.includes("karaoke") || extraCandidateTags.includes("tribute")) {
      score -= 70; // Reject covers
    } else if (extraCandidateTags.includes("remix") || extraCandidateTags.includes("acoustic") || extraCandidateTags.includes("live")) {
      score -= 40;
    }
  }

  // Threshold criteria for acceptability:
  // - If target has multiple artists (>=2): MUST match all artists (or at least primary + duration <= 2s if solo release)
  // - Duration diff must not exceed 15s
  // - Score must be >= 60
  let isAcceptable = score >= 60;
  let reason = "acceptable";

  if (targetArtists.length >= 2 && !allArtistsMatched) {
    // If only matched 1 artist out of many, only accept if duration is virtually identical (<= 2s) and candidate has synced lyrics
    if (matchedArtists.length === 0 || (durationDiff !== null && durationDiff > 2)) {
      isAcceptable = false;
      reason = "missing_collaborating_artists";
    }
  } else if (targetArtists.length === 1 && matchedArtists.length === 0) {
    isAcceptable = false;
    reason = "artist_mismatch";
  }

  if (durationDiff !== null && durationDiff > 15) {
    isAcceptable = false;
    reason = "duration_mismatch";
  }

  if (extraCandidateTags.includes("cover") && !targetTags.includes("cover")) {
    isAcceptable = false;
    reason = "unwanted_cover";
  }

  return {
    score: Math.max(0, score),
    allArtistsMatched,
    matchedArtists,
    missingArtists,
    isAcceptable,
    durationDiff,
    reason,
  };
}
```

- [ ] **Step 4: Chạy lại test để xác nhận test vượt qua (PASS)**

Run: `bun test tests/lyrics-matcher.test.mjs`
Expected: PASS all 5 tests.

- [ ] **Step 5: Commit task 2**

```bash
git add src/lyricsMatcher.js tests/lyrics-matcher.test.mjs
git commit -m "feat(lyrics): implement candidate scoring and multi-artist verification engine"
```

---

### Task 3: Cải tiến `src/lyricsService.js` với Chiến lược Tìm kiếm Đa Truy vấn và Fallback An toàn

**Files:**
- Modify: `src/lyricsService.js:1-209`
- Test: `tests/lyrics-service-multi-artist.test.mjs`

**Interfaces:**
- Consumes:
  - `fetchLyrics(rawTitle, rawArtist = "", durationSec = null, options = {})`
  - `options.artists`: `string[]` (mảng nghệ sĩ từ Spotify)
  - `options.spotifyTrackId`: `string`
- Produces:
  - Trả về payload `{ ok: true, synced: boolean, trackName, artistName, lines, plain, verifiedArtists: string[] }`
  - Nếu không tìm thấy ứng viên đạt chuẩn: trả về `{ ok: false, error: "not_found" | "no_matching_version" }`
  - Export `prefetchLyricsForTrack({ title, artist, artists, durationSec, trackId })` (chạy nền không block).

- [ ] **Step 1: Viết test thất bại cho `fetchLyrics` với mảng đa nghệ sĩ và kiểm tra lọc ứng viên**

Tạo file `tests/lyrics-service-multi-artist.test.mjs`:
```javascript
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fetchLyrics } from "../src/lyricsService.js";

describe("Lyrics Service Multi-Artist Search & Candidate Selection", () => {
  test("Prefers exact multi-artist candidate over an earlier single-artist cover in search results", async () => {
    const mockSearchResults = [
      {
        id: 101,
        trackName: "Ngáo Ngơ",
        artistName: "Ca Sĩ Cover A",
        duration: 215,
        syncedLyrics: "[00:01.00]Cover lyrics...",
      },
      {
        id: 102,
        trackName: "Ngáo Ngơ",
        artistName: "HIEUTHUHAI, ERIK, Anh Tú Atus, JSOL",
        duration: 216,
        syncedLyrics: "[00:01.00]Official multi-artist lyrics...",
      },
    ];

    const mockFetch = async (url) => {
      if (url.includes("/api/get")) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      if (url.includes("/api/search")) {
        return {
          ok: true,
          status: 200,
          json: async () => mockSearchResults,
        };
      }
      return { ok: false, status: 404 };
    };

    const res = await fetchLyrics(
      "Ngáo Ngơ",
      "HIEUTHUHAI, ERIK, Anh Tú Atus, JSOL",
      215,
      {
        artists: ["HIEUTHUHAI", "ERIK", "Anh Tú Atus", "JSOL"],
        fetchImpl: mockFetch,
        timeoutMs: 1000,
      }
    );

    assert.ok(res.ok);
    assert.equal(res.artistName, "HIEUTHUHAI, ERIK, Anh Tú Atus, JSOL");
    assert.equal(res.lines[0].text, "Official multi-artist lyrics...");
  });

  test("Returns error: 'no_matching_version' when LRCLIB only has wrong covers or wildly different durations", async () => {
    const badResults = [
      {
        id: 201,
        trackName: "Ngáo Ngơ (Remix 140BPM)",
        artistName: "Random DJ",
        duration: 120, // 2:00 vs 3:35
        syncedLyrics: "[00:01.00]Remix...",
      },
    ];

    const mockFetch = async () => ({
      ok: true,
      json: async () => badResults,
    });

    const res = await fetchLyrics("Ngáo Ngơ", "HIEUTHUHAI, ERIK", 215, {
      artists: ["HIEUTHUHAI", "ERIK"],
      fetchImpl: mockFetch,
    });

    assert.equal(res.ok, false);
    assert.ok(res.error === "no_matching_version" || res.error === "not_found");
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận test thất bại**

Run: `bun test tests/lyrics-service-multi-artist.test.mjs`
Expected: FAIL vì logic cũ chọn `mockSearchResults[0]` (bản cover của "Ca Sĩ Cover A" vì nó có `syncedLyrics`).

- [ ] **Step 3: Cập nhật `src/lyricsService.js` sử dụng `scoreLyricsCandidate` và chiến lược đa truy vấn**

Tích hợp `src/lyricsMatcher.js` vào `src/lyricsService.js`:
- Trích xuất `targetArtists = options.artists?.length ? options.artists : splitArtistNames(artist)`.
- Thực hiện các lượt truy vấn:
  1. `/api/get` với `track_name: title`, `artist_name: targetArtists.join(", ")`, `duration`
  2. `/api/get` với `artist_name: primaryArtist`, `duration`
  3. `/api/search` với full query `${primaryArtist} ${featuredArtists} ${title}`
  4. `/api/search` với query `${primaryArtist} ${title}`
  5. `/api/search` với query `${title}`
- Gom tất cả kết quả vào một mảng `candidatePool` (deduplicate theo id).
- Đánh giá tất cả ứng viên với `scoreLyricsCandidate(candidate, { targetTitle, targetArtists, targetDurationSec })`.
- Chọn ứng viên có `score` cao nhất thỏa mãn `isAcceptable === true`.
- Nếu có ứng viên thỏa mãn, phân tích `syncedLyrics` hoặc `plainLyrics` và ghi vào cache.
- Thêm cơ chế negative caching với TTL ngắn (3 phút) để tránh spam API khi bài không có lời.
- Export `prefetchLyricsForTrack(...)` với hàm wrapper bọc `try...catch` không ném lỗi unhandled rejection.

- [ ] **Step 4: Chạy lại test để xác nhận test vượt qua (PASS)**

Run: `bun test tests/lyrics-service-multi-artist.test.mjs`
Expected: PASS cả 2 tests.

- [ ] **Step 5: Chạy lại bộ test cũ của lyrics để đảm bảo không hồi quy**

Run: `bun test tests/lyrics-service.test.mjs tests/lyrics-client.test.mjs`
Expected: PASS 100%.

- [ ] **Step 6: Commit task 3**

```bash
git add src/lyricsService.js tests/lyrics-service-multi-artist.test.mjs
git commit -m "feat(lyrics): integrate multi-artist candidate scoring and query ranking into lyricsService"
```

---

### Task 4: Tích hợp Hàng đợi, Lưu trữ `artists` và Pre-cache ngầm khi Order Bài trên Server

**Files:**
- Modify: `src/state.js:220-250`
- Modify: `server.js:1292-1304, 1423-1440, 1487-1505`
- Test: `tests/lyrics-order-prefetch.test.mjs`

**Interfaces:**
- Consumes: `POST /api/request` với `provider: "spotify"`
- Produces:
  - `state.add({ ..., artists: canonical.artists })` lưu mảng `artists` vào in-memory queue item và snapshot.
  - `prefetchLyricsForTrack` được gọi ngầm (asynchronous background task).
  - Route `GET /api/lyrics?title=...&artist=...&artists=...&duration=...` chuyển `artists` xuống `fetchLyrics`.

- [ ] **Step 1: Viết test cho việc bảo tồn `artists` trong hàng đợi và gọi pre-cache khi order Spotify**

Tạo file `tests/lyrics-order-prefetch.test.mjs`:
```javascript
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { JukeboxState } from "../src/state.js";

describe("Queue State and Order Integration for Multi-Artist Spotify", () => {
  test("JukeboxState preserves artists array in queue item and snapshot", () => {
    const state = new JukeboxState(null);
    const added = state.add({
      videoId: "4cOdK2wGLETKBW3PvgPWqT",
      title: "Ngáo Ngơ",
      channel: "HIEUTHUHAI, ERIK, Anh Tú Atus",
      artists: ["HIEUTHUHAI", "ERIK", "Anh Tú Atus"],
      duration: "3:35",
      provider: "spotify",
    });

    assert.ok(added.item);
    assert.deepEqual(added.item.artists, ["HIEUTHUHAI", "ERIK", "Anh Tú Atus"]);

    const snap = state.snapshot();
    assert.equal(snap.nowPlaying.title, "Ngáo Ngơ");
    assert.deepEqual(snap.nowPlaying.artists, ["HIEUTHUHAI", "ERIK", "Anh Tú Atus"]);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận test thất bại**

Run: `bun test tests/lyrics-order-prefetch.test.mjs`
Expected: FAIL vì `state.add` hiện chưa giữ thuộc tính `artists`.

- [ ] **Step 3: Triển khai lưu `artists` trong `src/state.js` và tích hợp pre-cache trong `server.js`**

1. Trong `src/state.js`:
Cập nhật `state.add`:
```javascript
artists: Array.isArray(artists) ? artists : (channel ? parseArtistListFromString(channel) : []),
```
Và trong `_publicItem`:
```javascript
artists: item.artists || [],
```

2. Trong `server.js`:
Cập nhật `POST /api/request` nhánh `spotify`:
```javascript
canonical = {
  ...meta,
  artists: meta.artists || (meta.channel ? parseArtistListFromString(meta.channel) : []),
};
```
Khi gọi `state.add`:
```javascript
const { item, position } = state.add({
  videoId,
  title: canonical.title,
  channel: canonical.channel,
  artists: canonical.artists,
  duration: canonical.duration,
  thumbnail: canonical.thumbnail,
  ...
});

// Non-blocking asynchronous pre-fetch in background
if (cleanProvider === "spotify" || canonical.artists?.length > 0) {
  const durSec = durationSeconds(canonical.duration);
  prefetchLyricsForTrack({
    title: canonical.title,
    artist: canonical.channel,
    artists: canonical.artists,
    durationSec: Number.isFinite(durSec) ? durSec : null,
    trackId: videoId,
  }).catch((err) => {
    console.warn("[lyrics-prefetch] Non-blocking prefetch failed:", err?.message);
  });
}
```

3. Trong `server.js` route `GET /api/lyrics`:
```javascript
app.get("/api/lyrics", async (req, res) => {
  const title = (req.query.title || "").toString().trim();
  const artist = (req.query.artist || "").toString().trim();
  const durationSec = parseFloat(req.query.duration);
  let artists = [];
  if (req.query.artists) {
    try {
      artists = JSON.parse(req.query.artists);
    } catch {
      artists = (req.query.artists || "").toString().split(",").map((s) => s.trim()).filter(Boolean);
    }
  }

  if (!title) {
    return res.status(400).json({ ok: false, error: "title_required" });
  }

  const result = await fetchLyrics(title, artist, Number.isFinite(durationSec) ? durationSec : null, {
    artists,
  });
  res.json(result);
});
```

- [ ] **Step 4: Chạy lại test để xác nhận test vượt qua (PASS)**

Run: `bun test tests/lyrics-order-prefetch.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit task 4**

```bash
git add src/state.js server.js tests/lyrics-order-prefetch.test.mjs
git commit -m "feat(server): store artists array in queue state and trigger non-blocking pre-fetch upon order"
```

---

### Task 5: Đồng bộ Giao diện Client (`lyrics-client.js`, `host.js`, `guest.js`)

**Files:**
- Modify: `public/lyrics-client.js:50-130`
- Modify: `public/host.js:355-400`
- Modify: `public/guest.js:1550-1605`
- Test: `tests/lyrics-client.test.mjs`

**Interfaces:**
- Consumes: `nowPlaying.artists: string[]` từ WebSocket state.
- Produces:
  - `loadLyrics(title, channel, duration, artists)` trong `host.js`
  - `loadGuestLyrics(np)` trong `guest.js` truyền `artists` xuống `fetchLyricsClient`.
  - `fetchLyricsClient({ title, artist, artists, durationSec })` gửi `artists` param lên `/api/lyrics` và áp dụng kiểm tra nghệ sĩ trong direct fallback.

- [ ] **Step 1: Viết test cho `fetchLyricsClient` với tham số `artists`**

Cập nhật `tests/lyrics-client.test.mjs`:
```javascript
test("fetchLyricsClient sends artists parameter to backend /api/lyrics", async () => {
  let requestedUrl = "";
  const mockFetch = async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      json: async () => ({ ok: true, lines: [{ time: 1, text: "Lyrics" }] }),
    };
  };

  await JukeboxLyrics.fetchLyricsClient({
    title: "Ngáo Ngơ",
    artist: "HIEUTHUHAI, ERIK",
    artists: ["HIEUTHUHAI", "ERIK"],
    durationSec: 215,
    fetchImpl: mockFetch,
  });

  assert.ok(requestedUrl.includes("artists="));
  assert.ok(requestedUrl.includes("HIEUTHUHAI"));
});
```

- [ ] **Step 2: Chạy test để xác nhận test thất bại**

Run: `bun test tests/lyrics-client.test.mjs`
Expected: FAIL vì `fetchLyricsClient` hiện chưa nhận hay gửi `artists`.

- [ ] **Step 3: Cập nhật `public/lyrics-client.js`, `public/host.js`, `public/guest.js`**

1. Trong `public/lyrics-client.js`:
Cập nhật `fetchLyricsClient`:
```javascript
async function fetchLyricsClient({
  title: rawTitle,
  artist: rawArtist = "",
  artists = [],
  durationSec = null,
  fetchImpl = global.fetch || fetch,
  timeoutMs = 6000,
} = {}) {
  ...
  // 1. Try local backend /api/lyrics first with artists param
  const params = new URLSearchParams({ title, artist });
  if (Array.isArray(artists) && artists.length > 0) {
    params.set("artists", JSON.stringify(artists));
  }
  if (durationSec && Number.isFinite(durationSec)) {
    params.set("duration", Math.round(durationSec));
  }
  ...
}
```

2. Trong `public/host.js`:
Cập nhật `loadLyrics`:
```javascript
async function loadLyrics(rawTitle, rawArtist, duration, artists = []) {
  ...
  const data = lyricsClient
    ? await lyricsClient.fetchLyricsClient({
        title: rawTitle,
        artist: rawArtist,
        artists: Array.isArray(artists) ? artists : [],
        durationSec: durSec,
      }).catch((err) => {
        console.warn("fetchLyricsClient error:", err);
        return null;
      })
    : null;
}
```
Và tại nơi gọi `loadLyrics`:
```javascript
loadLyrics(np.title, np.channel, np.duration, np.artists || []);
```

3. Trong `public/guest.js`:
Cập nhật `loadGuestLyrics`:
```javascript
data = lyricsClient
  ? await lyricsClient.fetchLyricsClient({
      title: rawTitle,
      artist: rawArtist,
      artists: Array.isArray(np.artists) ? np.artists : [],
      durationSec: durSec,
    })
  : null;
```

- [ ] **Step 4: Chạy lại test để xác nhận test vượt qua (PASS)**

Run: `bun test tests/lyrics-client.test.mjs`
Expected: PASS.

- [ ] **Step 5: Chạy toàn bộ test suite để đảm bảo không lỗi phát sinh**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 6: Commit task 5**

```bash
git add public/lyrics-client.js public/host.js public/guest.js tests/lyrics-client.test.mjs
git commit -m "feat(client): pass multi-artist metadata to lyrics client and host/guest lyrics loaders"
```

---

## Bảng tổng hợp Xử lý các Tình huống Ngoại lệ & Biên (Edge Cases Matrix)

| Tình huống (Scenario) | Nguy cơ / Vấn đề | Giải pháp xử lý trong Kế hoạch |
| :--- | :--- | :--- |
| **Bản Cover của ca sĩ khác** | LRCLIB trả về bản cover có synced lyrics do YouTuber/TikToker đăng | `scoreLyricsCandidate` kiểm tra tập hợp nghệ sĩ; nếu không có đủ tên các nghệ sĩ gốc, bản cover bị loại bỏ (reject) ngay lập tức. |
| **Bản Remix / Speed Up** | Lệch tốc độ, rap verse bị cắt, thời lượng ngắn hơn bản gốc | Kiểm tra `durationDiff`: nếu lệch > 5s trừ điểm nặng, lệch > 15s bị loại bỏ. Kiểm tra từ khóa phiên bản (Remix / Speed Up) loại bỏ nếu bài gốc không phải remix. |
| **Nghệ sĩ phụ nằm trong Title** | Spotify ghi `(feat. B)` trong title thay vì `artists` array | `extractFeaturedArtistsFromTitle` quét regex trong title gom vào danh sách `artists` trước khi tìm kiếm. |
| **Dấu câu, chữ hoa/thường, Tiếng Việt** | Khác biệt dấu ngoặc kép `"Say Hi"`, dấu gạch ngang, có/không dấu | `normalizeSearchText` & `stripDiacritics` hỗ trợ so khớp cả bản có dấu chuẩn và bản không dấu, chặn false-positive bằng word-boundary regex. |
| **Thứ tự nghệ sĩ bị đảo** | Spotify: `[A, B]`, LRCLIB: `[B, A]` | Dùng giải thuật tập hợp (`Set`), không phụ thuộc thứ tự nối chuỗi. |
| **Không tìm thấy bản có đủ 100% nghệ sĩ** | Bài collab 5 người nhưng LRCLIB chỉ ghi 3 người | Fallback theo thứ tự: Đầy đủ 100% nghệ sĩ → Nghệ sĩ chính + phụ + sai số thời lượng cực nhỏ (±2s) → Nếu vẫn không tin cậy thì trả về "Chưa có lời" an toàn, không hiển thị sai lời. |
| **LRCLIB Timeout / 429 / 5xx khi order** | Làm treo hoặc chậm response của user order bài | Pre-fetch chạy hoàn toàn bất đồng bộ trong background (unawaited promise + catch), không ảnh hưởng đến API `/api/request`. |
| **Negative Caching (Spam request)** | Bài hát không có lời trên LRCLIB bị query liên tục mỗi khi chuyển bài hoặc reload | Lưu kết quả rỗng vào bộ nhớ đệm tạm thời (TTL 3-5 phút) để không gọi lại LRCLIB liên tục cho bài đó. |
