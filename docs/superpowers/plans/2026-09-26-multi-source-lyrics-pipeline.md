# Multi-Source Lyrics Pipeline (LRCLIB + Zing MP3 + YouTube Creator Captions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Xây dựng hệ thống lấy lời bài hát đa nguồn (Multi-Source Pipeline) tích hợp đồng thời **LRCLIB**, **Zing MP3 API** và **YouTube Creator Captions** (chỉ cho YouTube, chỉ lấy phụ đề do người đăng tạo và **phải đúng ngôn ngữ gốc của bài hát**, loại bỏ hoàn toàn phụ đề tự động ASR), bảo đảm hai nguồn LRCLIB và Zing MP3 bổ trợ nhau hài hòa, không xung đột, **nếu cả hai không có bản thu đúng thì trả về không có lời bài hát đồng bộ**, chuẩn hóa chung định dạng.

**Architecture:** Multi-Provider Fallback Orchestrator:
1. Nếu bài hát phát từ nguồn YouTube (`platform === "youtube"` & có `videoId`):
   - Thử lấy **YouTube Creator Captions**.
   - Kiểm tra metadata bài hát (title, artist) để nhận diện ngôn ngữ gốc (`vi`, `en`, `ko`, `ja`, `zh`, v.v.).
   - Lọc danh sách `captionTracks`: **Chỉ chấp nhận track do người đăng tạo** (`kind !== "asr"` và `!vssId.startsWith("a.")`), loại bỏ triệt để phụ đề tự động (ASR) và track dịch máy.
   - Chọn đúng track phụ đề tương ứng với **ngôn ngữ gốc** của bài hát.
   - Nếu tìm thấy, parse và trả về ngay (khớp 100% video YouTube). Nếu không có phụ đề người tạo đúng ngôn ngữ gốc, bỏ qua và chuyển sang bước 2.
2. Nguồn trực tuyến chính: Gọi **LRCLIB**.
   - Tìm kiếm và đối soát nghiêm ngặt với nghệ sĩ và thời lượng (`Math.abs(duration - durationSec) <= 35`).
   - Nếu tìm thấy bản ghi chuẩn, lưu cache và trả về ngay.
3. Nguồn bổ trợ chuyên sâu: Nếu LRCLIB không có (`not_found` hoặc `no_matching_version` do lệch thời lượng/sai bản phối):
   - Tự động fallback sang **Zing MP3** (`ac-suggestions` -> tải `.lrc` từ CDN của Zing).
   - Kiểm tra ứng viên Zing MP3 nghiêm ngặt: phải có `lyricLink`, phải khớp nghệ sĩ, phải khớp thời lượng (±35s), không được dính nhãn remix/cover/karaoke/beat nếu bài gốc không có.
   - Nếu tìm thấy bản ghi hợp lệ, lưu cache và trả về.
4. **Trường hợp cả 2 nguồn đều không có bản thu đúng**:
   - Dứt khoát trả về `{ ok: false, error: "no_matching_version" }`.
   - Giao diện người dùng hiển thị chuẩn: *"Chưa có lời bài hát đồng bộ cho bài hát này"*.
   - **Tuyệt đối không lấy bất kỳ bản thu nào lệch thời lượng hoặc sai nghệ sĩ**.

**Tech Stack:** Bun/Node.js, InnerTube TimedText XML parser, Zing MP3 suggestions & CDN LRC reader, LRCLIB API.

---

## Global Constraints
- **Zero hardcoding**: Tuyệt đối không hardcode text bài hát trong source code.
- **YouTube Captions**: Chỉ áp dụng cho bài nhạc order từ YouTube, **chỉ lấy phụ đề do người đăng tạo** (`kind !== "asr"` và `!vssId.startsWith("a.")`), và **phải lấy đúng ngôn ngữ gốc của bài hát**, loại bỏ phụ đề tự động (ASR).
- **Zing MP3 Fallback**: Bổ trợ cho LRCLIB, đối soát nghiêm ngặt thời lượng và nghệ sĩ. Nếu không có bản thu đúng, trả về không có lời, không lấy bừa.
- **Không xung đột (Conflict-Free)**: Cache key chung `${artistKey}:::${title}`, validate thời lượng (±35s) và tên nghệ sĩ trước khi chấp nhận dữ liệu từ bất kỳ nguồn nào.
- **Backward Compatibility**: Giữ nguyên toàn bộ interface của `fetchLyrics`, `prefetchLyricsForTrack`, và `public/lyrics-client.js`.
- **Git State**: Tuyệt đối **không `git commit`** hay `git push`; tất cả file được chỉnh sửa giữ nguyên ở trạng thái unstaged.
- **Chu trình thực thi**: Thực hiện theo chu trình: `implement -> review -> fix -> review ... -> kiểm thử hồi quy toàn bộ`.

---

## Review Focus
1. **Ngôn ngữ gốc của YouTube Captions**: Khi video có nhiều track phụ đề (ví dụ bài hát tiếng Việt có cả sub tiếng Anh, tiếng Hàn, hoặc bài K-Pop có sub tiếng Việt, tiếng Anh), hệ thống phải phát hiện đúng ngôn ngữ gốc của bài và chọn track gốc, không chọn nhầm bản dịch.
2. **Loại trừ phụ đề tự động ASR**: Track có `kind === "asr"` hoặc `vssId` bắt đầu bằng `a.` phải bị loại bỏ 100%.
3. **Từ chối bản thu sai lệch trên Zing MP3**: Khi bài hát gốc dài 6:30 (Út Trà Ôn), nếu Zing MP3 chỉ có bản 2:22 (Thanh Duy) thì phải reject; chỉ accept khi thời lượng và nghệ sĩ khớp. Nếu không có bản thu nào khớp, trả về `no_matching_version`.
4. **Xử lý ký tự đặc biệt & HTML entities**: Phụ đề YouTube chứa `&amp;`, `&#39;`, `&quot;`, `[âm nhạc]`, `♪` - phải được decode và làm sạch hoàn toàn.
5. **Mạng & Timeout**: Mỗi provider có timeout độc lập (<= 3.5s), tổng thời gian không vượt quá timeout của request, không gây treo giao diện Host.

---

## File Structure

- **Create**: `src/providers/youtubeCaptions.js`
  - Chức năng: Nhận diện ngôn ngữ gốc (`detectOriginalLanguage`), lọc creator caption tracks theo ngôn ngữ gốc, tải và parse timedtext XML.
- **Create**: `src/providers/zingMp3Lyrics.js`
  - Chức năng: Tìm kiếm ứng viên trên Zing MP3 `ac-suggestions`, lọc nghiêm ngặt thời lượng & nghệ sĩ & tag biến thể (remix/cover), tải và parse `.lrc` từ CDN.
- **Modify**: `src/lyricsService.js`
  - Chức năng: Điều phối pipeline: Cache -> YouTube Creator Captions (nếu youtube) -> LRCLIB -> Zing MP3 fallback -> nếu cả 2 không có thì trả về `no_matching_version`.
- **Modify**: `server.js`
  - Chức năng: Endpoint `/api/lyrics` tiếp nhận query `platform` và `videoId` (hoặc `ytId`), chuyển vào `fetchLyrics`.
- **Modify**: `public/lyrics-client.js`
  - Chức năng: Khi client gọi `/api/lyrics`, truyền kèm `platform` và `videoId` của bài hát đang phát.
- **Create Tests**:
  - `tests/youtube-captions.test.mjs`: Test nhận diện ngôn ngữ gốc, chặn ASR, bóc tách XML.
  - `tests/zingmp3-lyrics.test.mjs`: Test tìm kiếm Zing MP3, lọc thời lượng/nghệ sĩ, reject khi không khớp bản thu.
  - `tests/multi-source-lyrics.test.mjs`: Test toàn bộ pipeline tương hỗ, fallback và case không nguồn nào có bản thu đúng.

---

### Task 1: Module bóc tách YouTube Creator Captions với nhận diện ngôn ngữ gốc (`src/providers/youtubeCaptions.js`)

**Files:**
- Create: `src/providers/youtubeCaptions.js`
- Test: `tests/youtube-captions.test.mjs`

**Interfaces:**
- Produces:
  - `detectOriginalLanguage(title, artist)`: Trả về mã ngôn ngữ ISO (`vi`, `ko`, `ja`, `zh`, `en`, v.v.).
  - `selectOriginalCreatorTrack(captionTracks, originalLang)`: Chọn đúng track creator-uploaded khớp với ngôn ngữ gốc.
  - `parseYouTubeTimedText(xmlText)`: Chuyển đổi timedtext XML sang `lines: [{ time, text }]`.
  - `fetchYouTubeCreatorCaptions(videoId, { title, artist, fetchImpl, timeoutMs })`: Hàm chính bóc tách phụ đề người đăng.

- [ ] **Step 1: Viết test cho `src/providers/youtubeCaptions.js`**
  - Test nhận diện ngôn ngữ gốc:
    - Tiếng Việt có dấu ("Tình Anh Bán Chiếu", "Sơn Tùng M-TP") -> `"vi"`.
    - Tiếng Hàn Hangul ("봄날", "BTS") -> `"ko"`.
    - Tiếng Nhật Kana ("夜に駆ける", "YOASOBI") -> `"ja"`.
    - Tiếng Anh / Latinh ("Shape of You", "Ed Sheeran") -> `"en"`.
  - Test chọn track:
    - Video có track tiếng Việt (gốc) và track tiếng Anh (dịch): Chọn track tiếng Việt khi bài hát là tiếng Việt.
    - Video có track tiếng Hàn (gốc) và track tiếng Anh (dịch): Chọn track tiếng Hàn khi bài hát là tiếng Hàn.
    - Video chỉ có track ASR (`kind: "asr"` hoặc `vssId: "a.vi"`): Từ chối hoàn toàn, trả về `null`.
    - Video có track dịch máy (`isTranslatable` nhưng không phải source track): Ưu tiên source creator track.
  - Test parse XML:
    - Chuyển đổi `<p t="15000" d="3000">♪ Lời bài hát &amp; tình yêu &#39;mẹ&#39; ♪</p>` thành `{ time: 15.0, text: "Lời bài hát & tình yêu 'mẹ'" }`.
    - Bỏ các dòng rác chỉ chứa `[Âm nhạc]`, `[Nhạc]`, `♪`, hoặc chuỗi rỗng.

- [ ] **Step 2: Chạy test để xác nhận test fail**
  `bun test tests/youtube-captions.test.mjs`

- [ ] **Step 3: Cài đặt code module `src/providers/youtubeCaptions.js`**
  - Cài đặt `detectOriginalLanguage(title, artist)` dùng regex nhận diện bộ ký tự.
  - Cài đặt `selectOriginalCreatorTrack(captionTracks, originalLang)`:
    - Lọc track: `!t.kind && !t.vssId?.startsWith("a.")` (creator upload).
    - Tìm track có `t.languageCode === originalLang` hoặc `t.vssId?.includes("." + originalLang)`.
    - Nếu không khớp tuyệt đối ngôn ngữ detect, lấy track creator đầu tiên nếu track đó không có cờ dịch thuật.
  - Cài đặt `fetchYouTubeCreatorCaptions` gọi InnerTube Android API và parse XML timedtext.

- [ ] **Step 4: Chạy test để xác nhận test pass**
  `bun test tests/youtube-captions.test.mjs`

---

### Task 2: Module lấy lời bài hát từ Zing MP3 với kiểm soát bản thu nghiêm ngặt (`src/providers/zingMp3Lyrics.js`)

**Files:**
- Create: `src/providers/zingMp3Lyrics.js`
- Test: `tests/zingmp3-lyrics.test.mjs`

**Interfaces:**
- Produces: `fetchZingMp3Lyrics(title, artist, durationSec, { fetchImpl, timeoutMs, artists })`
  - Returns: `{ ok: true, synced: true, source: "zingmp3", trackName, artistName, lines }` hoặc `{ ok: false, error: "no_matching_version" | "not_found" }`.

- [ ] **Step 1: Viết test cho `src/providers/zingMp3Lyrics.js`**
  - Test tìm kiếm và tải file `.lrc` từ CDN khi có bản thu khớp chuẩn (ví dụ Út Trà Ôn 390s).
  - Test từ chối khi chỉ có bản thu lệch thời lượng (ví dụ cần 390s nhưng chỉ có 222s hoặc 147s remix) -> trả về `{ ok: false, error: "no_matching_version" }`.
  - Test từ chối khi nghệ sĩ không khớp (ví dụ cần ca sĩ A nhưng chỉ có ca sĩ B hát cover).
  - Test từ chối bài có từ khóa biến thể (remix, cover, karaoke, beat) khi bài gốc không có.
  - Test xử lý bài không có `lyricLink` hoặc lỗi mạng -> trả về `{ ok: false, error: "not_found" }`.

- [ ] **Step 2: Chạy test để xác nhận test fail**
  `bun test tests/zingmp3-lyrics.test.mjs`

- [ ] **Step 3: Cài đặt code module `src/providers/zingMp3Lyrics.js`**
  - Gọi endpoint gợi ý công khai `https://ac.zingmp3.vn/v1/web/ac-suggestions?query=...`.
  - Duyệt và chấm điểm các ứng viên trong `data.items`:
    - Bắt buộc có `it.lyricLink` (URL kết thúc bằng `.lrc` hoặc trỏ tới CDN Zing).
    - So khớp thời lượng: nếu có `durationSec`, `Math.abs(it.duration - durationSec) <= 35`.
    - So khớp nghệ sĩ: chuẩn hóa không dấu và đối soát với danh sách nghệ sĩ mục tiêu.
    - Loại trừ bài biến thể (remix/cover/beat/tân cổ) nếu tiêu đề gốc không chứa các từ đó.
  - Nếu không có bất kỳ ứng viên nào hợp lệ: trả về `{ ok: false, error: "no_matching_version" }`.
  - Nếu có ứng viên hợp lệ: fetch nội dung file `.lrc`, parse qua `parseLrc` và trả về kết quả chuẩn hóa.

- [ ] **Step 4: Chạy test để xác nhận test pass**
  `bun test tests/zingmp3-lyrics.test.mjs`

---

### Task 3: Tích hợp vào Lyrics Service & Orchestrator (`src/lyricsService.js`)

**Files:**
- Modify: `src/lyricsService.js`
- Modify: `server.js`
- Test: `tests/multi-source-lyrics.test.mjs`

**Interfaces:**
- Consumes: `fetchYouTubeCreatorCaptions`, `fetchZingMp3Lyrics`, `scoreLyricsCandidate`.
- Produces: `fetchLyrics(rawTitle, rawArtist, durationSec, { platform, videoId, artists, fetchImpl, timeoutMs })`.

- [ ] **Step 1: Viết test cho luồng tích hợp đa nguồn trong `tests/multi-source-lyrics.test.mjs`**
  - Case 1 (YouTube Creator Caption): `platform === "youtube"` & có videoId -> Ưu tiên lấy phụ đề người tạo đúng ngôn ngữ gốc.
  - Case 2 (YouTube ASR Caption): Video YouTube chỉ có phụ đề tự động ASR -> Bỏ qua YouTube captions, chuyển sang LRCLIB.
  - Case 3 (LRCLIB Match): LRCLIB có bản thu khớp chuẩn -> Lấy LRCLIB (source: `lrclib`), không cần gọi Zing MP3.
  - Case 4 (LRCLIB Mismatch / Missing -> Zing MP3 Fallback): LRCLIB không có bản thu đúng (như Út Trà Ôn 6:30) -> Fallback sang Zing MP3 và lấy thành công (source: `zingmp3`).
  - Case 5 (Cả 2 nguồn đều không có bản thu đúng): LRCLIB không có và Zing MP3 cũng không có bản thu đúng thời lượng/nghệ sĩ -> Trả về `{ ok: false, error: "no_matching_version" }`, **không bao giờ trả về bài sai**.

- [ ] **Step 2: Chạy test để xác nhận test fail**
  `bun test tests/multi-source-lyrics.test.mjs`

- [ ] **Step 3: Cập nhật `src/lyricsService.js` và `server.js`**
  - Trong `src/lyricsService.js`:
    1. Kiểm tra cache chung.
    2. Nếu `platform === "youtube"` và có `videoId`: Gọi `fetchYouTubeCreatorCaptions`. Nếu thành công với ngôn ngữ gốc, lưu cache và trả về.
    3. Gọi `LRCLIB`: Nếu có kết quả acceptable, lưu cache và trả về.
    4. Nếu `LRCLIB` trả về `not_found` hoặc `no_matching_version`: Fallback sang `fetchZingMp3Lyrics`. Nếu Zing MP3 có bản thu hợp lệ, lưu cache và trả về.
    5. Nếu Zing MP3 cũng không có bản thu đúng: Trả về `{ ok: false, error: "no_matching_version" }`.
  - Trong `server.js`:
    - Đọc query params `platform` và `videoId` (hoặc `ytId`) từ `/api/lyrics`, chuyển vào `fetchLyrics`.
    - Trong `prefetchLyricsForTrack`: Truyền `platform` và `trackId`/`videoId`.

- [ ] **Step 4: Chạy test để xác nhận test pass**
  `bun test tests/multi-source-lyrics.test.mjs`

---

### Task 4: Cập nhật Client & Chu trình Review - Fix lặp đến khi 0 findings

**Files:**
- Modify: `public/lyrics-client.js`
- Test: `tests/lyrics-client.test.mjs`
- Test: `tests/lyrics-service.test.mjs`

- [ ] **Step 1: Cập nhật `public/lyrics-client.js`**
  - Truyền `platform` và `videoId` lên `/api/lyrics` khi bài hát đang phát có thông tin này.
  - Giữ nguyên cơ chế client: nếu backend trả về `{ ok: false }` hoặc `null`, client hiển thị đúng thông báo *"Chưa có lời bài hát đồng bộ cho bài hát này"*.

- [ ] **Step 2: Vòng lặp Review & Fix (Review - Fix Cycle)**:
  - Rà soát toàn bộ code mới:
    - [ ] Kiểm tra memory leak, unhandled promise rejections, abort controllers.
    - [ ] Kiểm tra khả năng xử lý edge cases (tên bài hát có dấu ngoặc, nghệ sĩ có nhiều người, ký tự Unicode đặc biệt).
    - [ ] Kiểm tra các trường hợp timeout khi mạng chập chờn.
    - [ ] Sửa ngay bất kỳ finding nào được phát hiện và re-review cho tới khi **0 findings**.

- [ ] **Step 3: Kiểm thử hồi quy toàn bộ (Full Regression Testing)**:
  Chạy tất cả các test suite liên quan:
  `bun test tests/lyrics-client.test.mjs tests/lyrics-service.test.mjs tests/youtube-captions.test.mjs tests/zingmp3-lyrics.test.mjs tests/multi-source-lyrics.test.mjs tests/host-playback.test.mjs tests/spotify-ratelimit-realtime.test.mjs`
  Bảo đảm 100% test pass không có lỗi.

- [ ] **Step 4: Kiểm tra trạng thái git**:
  Chạy `git status` đảm bảo tất cả file ở trạng thái unstaged, không có commit tự động.
