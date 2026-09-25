# Kế hoạch triển khai: Per-User Queue Limit, Đồng bộ Badge & Avatar Host, Lịch sử phát và Chuẩn hóa Toast Mạng Host

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Triển khai tính năng giới hạn bài order cho từng user (5, 10, 15 bài) với cơ chế chống lách luật bằng IP/Device ID, đồng bộ badge nền tảng và căn chỉnh avatar danh sách phát bên Host, bổ sung xem lịch sử phát toàn bộ cho Host, và chuẩn hóa trải nghiệm Toast/Button khi cập nhật mạng Host. Đảm bảo giao diện responsive hoàn chỉnh và kiểm thử an toàn trên môi trường độc lập.

**Architecture:**
- Backend:
  - Mở rộng cấu hình máy chủ: `userQueueLimitOn` (boolean), `userQueueLimit` (5, 10, 15; mặc định 5 bài), đồng bộ qua WebSocket state và lưu trữ trong `settings.json`.
  - Phân loại và kiểm tra hạn ngạch order trong `POST /api/request`: Kiểm tra bài hát đang chờ trong `state.queue` theo `addedByUserId`, `deviceId` (HttpOnly persistent cookie), `requesterId` (clientId) và `requesterIp` (đặc biệt cho khách chưa đăng nhập và máy cùng dải IP mạng nội bộ).
  - API Lịch sử phát toàn bộ: `GET /api/history/all` trả về danh sách bài đã phát trên toàn hệ thống kèm người yêu cầu, thời gian kết thúc, điểm vote, thumbnail, provider.
  - Chuẩn hóa thông điệp WebSocket `registerOrderNetworkHost` và trạng thái cập nhật mạng Host.
- Frontend Host (`host.html`, `host.js`, `host.css`):
  - Thêm nút điều khiển `user-queue-limit-toggle` trong thanh controls: Chuyển đổi chu kỳ `Mỗi người: Tắt → 5 bài → 10 bài → 15 bài → Tắt`.
  - Đồng bộ badge nền tảng: Thay thế text `Spotify`/`SoundCloud`/`TikTok` bằng `.platform-icon-badge` SVG chuẩn (YouTube, Spotify, SoundCloud, TikTok) giống hệt trang Guest.
  - Sửa lệch avatar người order: Đưa `.q-requester-avatar` và `.q-sub-label` vào container `.q-requester-row` với `display: inline-flex; align-items: center; gap: 5px;` đồng bộ chuẩn CSS với Guest.
  - Tab / Modal Lịch sử phát: Thêm chuyển đổi tab `Hàng đợi` / `Lịch sử phát` ở thẻ `queue-card` và nút `Lịch sử phát` trên thanh điều khiển.
  - Chuẩn hóa Toast mạng Host:
    - Khi bấm "Cập nhật ngay": Toast dạng `loading/info` trung tính ("Đang cập nhật IP mạng Host..."), bỏ màu đỏ và icon tam giác cảnh báo.
    - Khi hoàn tất: Toast `success` ("Đã cập nhật IP mạng Host thành công!"), giữ nguyên nhãn nút "Cập nhật ngay" (không đổi thành nút "Mạng host đã cập nhật").
    - Khi lỗi: Toast `bad` với nội dung lỗi trực quan, thân thiện từ server trả về.
  - **Đảm bảo Responsive:** Tối ưu CSS Flex/Grid cho thanh controls, queue tabs, items hàng chờ và danh sách lịch sử trên mọi độ phân giải (Projector lớn, Laptop nhỏ, Tablet, Mobile).
- Frontend Guest (`guest.js`):
  - Nhận `userQueueLimitOn` và `userQueueLimit` từ WebSocket state, tính số bài user đang có trong hàng đợi và hiển thị thông báo/chặn order thân thiện khi chạm giới hạn cá nhân.

**Tech Stack:** Node.js / Bun, Express, SQLite, Vanilla JS / CSS, WebSocket.

---

## User Review & Phản hồi đã xử lý

> [!CAUTION]
> **QUY TẮC MÔI TRƯỜNG KIỂM THỬ (MANDATORY TESTING ISOLATION):**
> - **Máy chủ thật (live server trên cổng 3000) hiện đang chạy phục vụ âm nhạc cho toàn bộ văn phòng.**
> - **TUYỆT ĐỐI KHÔNG** gửi request order bài, trigger skip, hay thao tác lên cổng 3000 của server live.
> - Toàn bộ kiểm thử logic tự động được viết trong test files chạy với in-memory database hoặc test server riêng biệt trên cổng ngẫu nhiên độc lập (ví dụ cổng 3456) trong thư mục test tạm thời, không phát âm thanh ra loa.

> [!IMPORTANT]
> **YÊU CẦU RESPONSIVE CHO GIAO DIỆN:**
> - Thanh điều khiển Host (`#controls`): Bổ sung nút mới nhưng phải bọc wrap tự nhiên (`flex-wrap: wrap; gap: 8px;`), không bị tràn ngang hay che lấp các thành phần khác trên màn hình nhỏ / tablet.
> - Thẻ Hàng đợi & Lịch sử phát (`.queue-card`): Tabs header co giãn linh hoạt, danh sách bài thu gọn và hiển thị text ellipsis an toàn trên các độ rộng sidebar khác nhau.
> - Hàng chờ: Avatar + Badge + Title + Sub-label căn chỉnh co giãn linh hoạt, không bị vỡ bố cục khi tên bài hoặc tên người order dài.

---

## Task Decomposition

### Task 1: Thiết lập nhánh và Schema Database
**Files:**
- Modify: `src/db.js`
- Modify: `src/repositories/queueRepository.js`
- Test: `tests/user-queue-limit.test.mjs`

- [ ] **Step 1:** Thêm migration thêm cột `requester_ip TEXT` và `device_id TEXT` vào bảng `queue_items` trong `src/db.js`.
- [ ] **Step 2:** Cập nhật `createItem` trong `QueueRepository` để lưu `requester_ip` và `device_id`.
- [ ] **Step 3:** Thêm phương thức `getAllPlaybackHistory(eventId, { limit, offset })` trong `QueueRepository`.
- [ ] **Step 4:** Viết test độc lập trong `tests/user-queue-limit.test.mjs` để kiểm tra lưu trữ và truy vấn database SQLite in-memory riêng.

### Task 2: Backend Per-User Queue Limit & Multi-Account Anti-Cheat
**Files:**
- Modify: `server.js`
- Modify: `src/state.js`
- Test: `tests/user-queue-limit.test.mjs`

- [ ] **Step 1:** Bổ sung middleware `deviceId` (HttpOnly persistent cookie `jukebox_device_id`, maxAge 1 năm) trong `server.js`.
- [ ] **Step 2:** Thêm cấu hình `userQueueLimitOn` và `userQueueLimit` (`[5, 10, 15]`), lưu trữ trong `settings.json` và đồng bộ qua WebSocket `state`.
- [ ] **Step 3:** Xử lý tin nhắn WebSocket `setUserQueueLimit`.
- [ ] **Step 4:** Cập nhật kiểm tra hạn ngạch trong `POST /api/request`:
  - Khớp theo `addedByUserId`, `deviceId`, `clientId`, và `requesterIp` (đặc biệt với khách chưa đăng nhập hoặc mạng LAN nội bộ).
- [ ] **Step 5:** Cập nhật `state.add({ ..., deviceId, requesterIp })` trong `src/state.js` và ẩn trường này trong `_publicItem` để bảo vệ quyền riêng tư.
- [ ] **Step 6:** Chạy unit test xác nhận các kịch bản: Guest mở Incognito cùng IP bị chặn; User có 2 account trên cùng thiết bị bị chặn; đồng nghiệp khác máy không bị ảnh hưởng.

### Task 3: Backend All-Users Playback History API
**Files:**
- Modify: `server.js`
- Test: `tests/user-queue-limit.test.mjs`

- [ ] **Step 1:** Thêm endpoint `GET /api/history/all` trong `server.js`.
- [ ] **Step 2:** Trả về danh sách bài đã phát toàn phòng với phân trang `limit`, `offset`.
- [ ] **Step 3:** Chạy test kiểm tra kết quả trả về của endpoint `GET /api/history/all`.

### Task 4: Frontend Host - Đồng bộ Badge nền tảng & Sửa lệch Avatar & Responsive
**Files:**
- Modify: `public/host.js`
- Modify: `public/host.css`

- [ ] **Step 1:** Thêm hàm `getPlatformIconBadge(provider)` vào `public/host.js` đồng bộ icon SVG của YouTube, Spotify, SoundCloud, TikTok (chỉ icon, tooltip tên nền tảng khi hover).
- [ ] **Step 2:** Cập nhật `public/host.css` với các style `.platform-icon-badge` (kích thước chuẩn 18px, màu sắc thương hiệu, bo tròn).
- [ ] **Step 3:** Đưa avatar và sub-label vào `.q-requester-row` (`<span class="q-requester-row"><span class="q-requester-avatar"></span><span class="q-sub-label"></span></span>`).
- [ ] **Step 4:** Cập nhật CSS `.q-sub` và `.q-requester-row` trong `public/host.css`:
  - Avatar và tên người order nằm trên cùng hàng ngang, căn giữa hoàn hảo (`align-items: center; gap: 5px; min-width: 0;`).
  - Text ellipsis an toàn cho tên người order dài, responsive mượt mà trên mọi độ rộng sidebar.

### Task 5: Frontend Host - Nút điều khiển Giới hạn mỗi người & Tab Lịch sử phát & Responsive
**Files:**
- Modify: `public/host.html`
- Modify: `public/host.js`
- Modify: `public/host.css`

- [ ] **Step 1:** Thêm nút `user-queue-limit-toggle` vào thanh `#controls` trong `public/host.html`.
- [ ] **Step 2:** Viết logic click chuyển đổi chu kỳ `Mỗi người: Tắt → 5 bài → 10 bài → 15 bài → Tắt` trong `public/host.js`.
- [ ] **Step 3:** Thêm tab header `Hàng đợi` và `Lịch sử phát` vào `.queue-card` trong `public/host.html` và nút `Lịch sử phát` trên thanh controls.
- [ ] **Step 4:** Viết hàm tải và render lịch sử phát từ `GET /api/history/all` khi chuyển sang tab `Lịch sử phát`.
- [ ] **Step 5:** Thêm CSS responsive cho tabs và danh sách lịch sử phát trong `public/host.css`:
  - Tabs co giãn linh hoạt (`display: flex; gap: 8px;`).
  - Danh sách lịch sử phát có thumbnail nhỏ, thông tin bài, người order, thời gian phát, badge nền tảng, cuộn mượt mà.
  - Tối ưu media queries để `#controls` và `.queue-card` hiển thị hoàn hảo từ màn hình nhỏ (768px/1024px) đến màn hình lớn (1920px+).

### Task 6: Frontend Host - Chuẩn hóa Toast & Button Cập nhật Mạng
**Files:**
- Modify: `public/host.js`
- Modify: `public/host.css`

- [ ] **Step 1:** Nâng cấp hàm hiển thị Toast `showHostToast(message, type)` hỗ trợ `loading`/`info`, `ok`, `bad`.
- [ ] **Step 2:** Khi bấm "Cập nhật ngay": Hiển thị Toast `loading` ("Đang cập nhật IP mạng Host...") với icon ⏳ và màu trung tính (loại bỏ màu đỏ và icon tam giác cảnh báo).
- [ ] **Step 3:** Khi nhận `orderNetworkHostUpdated`: Hiển thị Toast `ok` ("Đã cập nhật IP mạng Host thành công!"), giữ nguyên nhãn nút "Cập nhật ngay".
- [ ] **Step 4:** Khi nhận `orderNetworkHostError`: Hiển thị Toast `bad` với thông báo lỗi trực quan từ server.
- [ ] **Step 5:** Cập nhật CSS `#order-network-host-status` với các class `.loading`, `.ok`, `.bad` và hiệu ứng xuất hiện mượt mà.

### Task 7: Frontend Guest - Đồng bộ Giới hạn cá nhân
**Files:**
- Modify: `public/guest.js`

- [ ] **Step 1:** Lắng nghe `userQueueLimitOn` và `userQueueLimit` trong tin nhắn WebSocket `state`.
- [ ] **Step 2:** Hiển thị toast hoặc thông báo rõ ràng khi user order chạm giới hạn cá nhân.

### Task 8: Kiểm thử tự động trên môi trường độc lập
- [ ] **Step 1:** Chạy bộ test biệt lập: `bun test tests/user-queue-limit.test.mjs` (không động tới server live).
- [ ] **Step 2:** Xác nhận toàn bộ logic hoạt động chính xác, không gây ảnh hưởng đến phiên live đang phát.

---

## Verification Plan

### Automated Tests
1. **Kiểm tra cơ chế Per-User Limit & Chống lách luật (Chạy trên DB/Test Process riêng biệt):**
   - File test mới: `tests/user-queue-limit.test.mjs`
   - Test 1: Khi `userQueueLimitOn = false`, user order bình thường.
   - Test 2: Khi `userQueueLimitOn = true` và `userQueueLimit = 5`:
     - User A order 5 bài thành công, bài thứ 6 bị từ chối với lý do chạm giới hạn.
     - User B order bài 1 thành công (không bị ảnh hưởng).
   - Test 3: Guest chưa đăng nhập order 5 bài từ IP `192.168.1.100`:
     - Giả lập Incognito (xóa `clientId`), cùng IP -> Bị từ chối do trùng IP máy.
   - Test 4: Cùng 1 thiết bị (`deviceId`) đổi sang Account 2:
     - Account 1 đã order 5 bài -> Account 2 cùng `deviceId` order tiếp -> Bị từ chối do chạm hạn ngạch thiết bị.
2. **Kiểm tra API Lịch sử phát Host:**
   - Test `GET /api/history/all`: Chèn bài `played`, gọi endpoint kiểm tra định dạng và phân trang.
