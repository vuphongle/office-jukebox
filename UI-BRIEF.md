# Office Jukebox — UI brief

This brief describes the two user-facing screens for a live event. The
projector shows the host page; guests scan its QR code, open the mobile guest
page, and add YouTube songs to the queue. The current implementation uses plain
HTML/CSS/JS in public/host.* and public/guest.*. A redesign may change the visual
style, but the existing element ids and behaviors must continue to work.

The interface copy is intentionally Vietnamese for the current user base.
Developer-facing prose in this document is English. Song titles and artist names
remain in their original language.

---

## 1. Host page (/) — projected screen

The page is viewed from a distance in a dark venue. Text must be large, clear,
and easy to scan.

**Start overlay** — a full-screen card with the logo, title, and one button:
**▶ Bắt đầu**. The browser requires one click to unlock audio. Include a short
note explaining that audio is routed to the venue AV system.

**Player area** (main stage)

- Embedded YouTube player in a 16:9 frame occupying most of the screen.
- Empty-queue state: 🎧 plus "Quét mã QR để thêm bài đầu tiên!".
- Below the video: the **current song title** and a secondary line containing
  **channel · Yêu cầu: guest-name**. Show the requester name only when the guest
  entered one.
- Controls:
  - ⏸/▶ play/pause, also available through the space key.
  - ⏭ skip, also available through the n key.
  - 🛡 **Bộ lọc** button to toggle the LLM content filter. When enabled, show a
    highlighted state and a small warning such as "chưa có khóa LLM — chấp nhận
    tất cả" when no key is configured.
  - ⏱ **Thời gian chờ** button showing the per-guest cooldown ("Thời gian chờ:
    15s" or "Thời gian chờ: TẮT"). Cycle through 0 / 5 / 10 / 15 / 30 / 60
    seconds.
  - 🔊 volume slider.

**Sidebar**

- **QR card** — "Quét để thêm bài hát", a large QR code, and the guest URL as
  plain text below it. This is the most important element for guests standing
  away from the screen.
- **Tiếp theo card** — a live queue with a count badge. Each row contains a
  thumbnail, title, channel, requester name, and a ✕ remove control available
  only to the host. Empty state: "Hàng đợi trống — quét mã QR để thêm bài hát."

Everything updates through WebSocket without a refresh. There are no loading
states beyond the states described above.

---

## 2. Guest page (/guest) — mobile

The page is used on mobile devices for roughly 30 seconds at a time, often in a
dark venue. Touch targets must be large. The interface is Vietnamese; song and
artist names remain in their original language, for example Sơn Tùng M-TP and
BLACKPINK, so music metadata is not altered.

**Header** — title and explanation on one line.

**Name field** — optional input with the helper copy "hiển thị cùng bài hát của
bạn". Store it on the phone so returning guests see their previous value.

**Search bar** — text input and search button that query YouTube directly.

**Discovery section** (KTV-style browser) — the default mode and the core of the
page:

- **Singer chip row** — horizontally scrollable chips with circular initials,
  genre colors, and names. Tapping a chip loads that singer's songs. The row is
  filtered by the active genre tab.
- **Genre tabs** — 🔥 Tất cả · 💜 K-pop · 🎤 V-pop · 🎵 Nhạc trữ tình / bolero ·
  🎧 Nhạc phương Tây · 🪩 Nhạc tiệc · 📼 Nhạc kinh điển Việt Nam. Exactly one tab
  is active and highlighted.
- **🔀 Xáo trộn button** — reshuffles songs in the current selection.
- Results are fresh, real YouTube data loaded directly, not a hard-coded list.

**Results list** (shared by discovery and search) — each row contains a
thumbnail, title, channel, duration, and a circular add button. The button
states are + → … (checking) → ✓ (added and disabled). **Thêm bài hát ↓** loads
the next batch. After a search, **← Quay lại mục Khám phá** restores discovery.

**Status line** — inline messages such as "Đang tải bài hát…", "Đang tìm kiếm…",
and "Không tìm thấy bài hát — hãy thử tab khác.", plus clear error messages with
😕.

**Toasts** (bottom feedback channel):

- 🔎 "Đang kiểm tra bài hát…" while the server verifies a request.
- ✅ "Đã thêm — đang phát!" or "Đã thêm — vị trí số 3 trong hàng đợi!".
- 🚫 A rejection with a clear reason, such as "Bài hát này đã có trong hàng
  đợi!", "Bài hát không phù hợp với sự kiện này.", or "Hàng đợi đã đầy…".
- ⏳ A live cooldown countdown such as "Bài tiếp theo sau 12 giây…", updated
  every second.

**Tiếp theo section** — a live queue with a count badge, a current-song banner
labelled "ĐANG PHÁT", and numbered rows containing title and channel. The guest's
own requests have a small **"BẠN"** badge. Empty state:
"Chưa có gì trong hàng đợi — hãy là người đầu tiên!".

---

## Important flows

1. **Happy path**: scan QR → open discovery → tap a genre or singer → tap + →
   receive the queue-position confirmation → see the song in Tiếp theo with the
   BẠN badge.
2. **Search flow**: enter a query → view results → add a song → use
   "← Quay lại mục Khám phá".
3. **Rejection flow**: duplicate, full queue (50), content filter, unplayable
   video, or cooldown. Every case is a clear, actionable toast; guests should
   never feel stuck.
4. **Live host moderation**: toggle the filter, change cooldown, remove or skip a
   song. All phones reflect the change within one second.

## Constraints

- No framework and no build step. Delivered pages should remain compatible with
  plain CSS and the existing DOM structure and ids where possible.
- Guest page: small, one-handed mobile use with no-cache assets so the design can
  change between events. Host page: 16:9 projector, dark room, readable from
  several meters away.
- The YouTube player itself is an embedded iframe and cannot be visually
  restyled.
- UI copy stays Vietnamese. Song titles and artist names keep their original
  language, so the selected font must support Vietnamese and required
  international characters.
