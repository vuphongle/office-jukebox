# CLAUDE.md

Tệp này cung cấp hướng dẫn cho Claude Code (claude.ai/code) khi làm việc với mã
nguồn trong kho này.

## Tổng quan

Một jukebox QR trên máy chiếu dành cho các sự kiện: trang người phụ trách
(`/`) được chiếu và phát video YouTube; khách quét mã QR trên màn hình để mở
`/guest` bằng điện thoại, tìm kiếm/duyệt YouTube và xếp bài hát vào hàng đợi.
Toàn bộ dùng JavaScript thuần — không framework, không bundler, không TypeScript,
không có bài kiểm thử.

## Lệnh

Dùng **bun** (không dùng npm):

```bash
bun install
cp .env.example .env   # giá trị mặc định dùng được; kiểm duyệt đang tắt
bun start              # chạy server.js trên cổng 45416
bun run check-llm      # xác minh LLM_API_KEY và liệt kê model khả dụng
```

Không có bước lint, build hoặc test. Xác minh thay đổi bằng cách chạy máy chủ và
kiểm tra cả hai trang (`/` và `/guest`).

## Kiến trúc

**Máy chủ quản lý toàn bộ trạng thái.** `src/state.js` (`JukeboxState`) là
hàng đợi trong bộ nhớ có thẩm quyền; mỗi thay đổi gọi `onChange`, còn
`server.js` phát toàn bộ ảnh chụp trạng thái tới mọi máy khách WebSocket. Trang
máy chiếu chỉ là một trình phát đơn giản: trang hiển thị nội dung mà
`nowPlaying` chỉ định và gửi lại các sự kiện `ended`/`error`, từ đó máy chủ
chuyển sang bài tiếp theo. Các điều khiển của người phụ trách (bỏ qua/xóa/di
chuyển/bật tắt bộ lọc) cũng đi qua cùng WebSocket. Không có cơ chế lưu trữ —
khởi động lại sẽ xóa hàng đợi.

**Luồng yêu cầu bài hát** (`POST /api/request` trong `server.js`):
1. `checkPlayable()` — kiểm tra oEmbed của YouTube để từ chối video đã bị xóa
   hoặc đặt ở chế độ riêng tư (cho phép tiếp tục khi lỗi mạng; trình phát máy
   chiếu tự động bỏ qua mã lỗi iframe 101/150 như lớp dự phòng cho video bị tắt
   nhúng hoặc khóa theo khu vực).
2. `moderate()` — bộ lọc LLM tùy chọn, chỉ chạy khi được bật từ trang máy chiếu.
3. `state.add()` — thêm vào hàng đợi và phát thông báo.

**YouTube không cần khóa API** (`src/youtube.js`): tìm kiếm gọi InnerTube API
nội bộ của YouTube Music (điểm cuối JSON mà ứng dụng web
`music.youtube.com` sử dụng), được lọc theo danh mục "Songs" — chỉ trả về kết
quả âm nhạc (phần lớn là bản âm thanh có ảnh bìa, không phải video ca nhạc)
kèm siêu dữ liệu nghệ sĩ thực tế; các `videoIds` này phát được trong iframe
YouTube thông thường. Chi tiết video để kiểm duyệt lấy từ
`ytInitialPlayerResponse` trên trang xem. Cookie `SOCS/CONSENT` giúp tránh
trang yêu cầu đồng ý của EU. Nếu tìm kiếm hỏng, hãy nghi ngờ thay đổi API hoặc
schema của InnerTube. `/api/browse` (các tab thể loại/chip ca sĩ trên trang
khách) dùng cùng cơ chế tìm kiếm nhưng được lưu bộ nhớ đệm 30 phút cho mỗi truy
vấn và lọc chỉ các đĩa đơn (≤10 phút) để dự phòng các bản phát trực tiếp hoặc
bản tuyển tập quá dài. Truy vấn sentinel `__vn_hits` (lần tải đầu tiên của tab
Tất cả) trả về bảng xếp hạng âm nhạc Việt Nam hiện tại của YouTube thay vì tìm
kiếm văn bản, vì tìm kiếm văn bản xếp hạng theo mức khớp tiêu đề chứ không theo
độ phổ biến tại địa phương.

**Kiểm duyệt: cho phép tiếp tục hay từ chối khi lỗi** (`src/moderation.js`) —
đây là sự phân biệt có chủ ý, phải giữ nguyên:
- **Cho phép tiếp tục** (phê duyệt) chỉ khi có lỗi hạ tầng: thiếu khóa API, lỗi
  HTTP hoặc lỗi mạng. Sự cố kiểm duyệt không được làm nhạc dừng (người phụ
  trách cũng có thể tắt trực tiếp bộ lọc).
- **Từ chối kèm lý do có thể thử lại** ("Hệ thống đang bận, vui lòng thử lại")
  khi hết thời gian chờ: các phán quyết chậm thường tập trung đúng vào những
  bài hát mà bộ lọc cần xử lý — từng có một bài hát phản kháng bị cấm lọt qua
  do hết thời gian chờ — vì vậy bài hết thời gian chờ không được phát mà chưa
  kiểm duyệt. Khách chỉ cần chạm lại.
- **Từ chối** khi mô hình trả lời nhưng né tránh: lý do kết thúc
  `content_filter` của nhà cung cấp, hoặc câu trả lời không có JSON hợp lệ
  `{"approved": boolean}`. Cách này bắt được, chẳng hạn, các bài hát phản
  kháng bị cấm mà những mô hình do Trung Quốc lưu trữ từ chối thảo luận.

LLM có thể là bất kỳ API trò chuyện nào tương thích OpenAI, được cấu hình hoàn
toàn qua `LLM_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY` — không có mã riêng cho từng
nhà cung cấp, với một ngoại lệ phải chủ động bật: `LLM_WEB_SEARCH=true` gắn
plugin web của OpenRouter (`plugins: [{id: "web"}]`) để mô hình thấy kết quả
tìm kiếm trực tiếp (thường là lời bài hát) thay vì chỉ đánh giá theo tiêu đề.
Các nhà cung cấp khác sẽ từ chối trường bổ sung này, nên trường đó phải tiếp
tục là tùy chọn. Đừng phụ thuộc vào `response_format: json_object` (mức hỗ trợ
khác nhau) và đừng đặt `temperature` trừ khi `LLM_TEMPERATURE` được chỉ định rõ
(một số mô hình từ chối giá trị tùy ý). Prompt bao gồm `EVENT_CONTEXT` để mô
hình đánh giá mức phù hợp với dịp, không chỉ mức độ nhạy cảm.

**Không phụ thuộc dotenv** — `server.js` có bộ nạp `.env` tối giản riêng.
Dependency chỉ gồm express, ws, qrcode; hãy giữ nguyên như vậy trừ khi có lý do
thực sự cần thiết.

## Triển khai

Chạy trên máy chủ gia đình bằng `docker compose up -d --build` — image được
xây dựng cục bộ từ mã nguồn; không có registry và không có bước build CI. Một
runner GitHub Actions tự lưu trữ (`.github/workflows/deploy.yml`) xây dựng lại
sau mỗi lần đẩy lên `main`. Container tham gia mạng Docker bên ngoài
`reverseproxy`; `PUBLIC_URL` trong `.env` là địa chỉ mà mã QR trỏ tới, còn
proxy ngược phải chuyển tiếp việc nâng cấp WebSocket. Không thêm trigger
`pull_request` vào quy trình triển khai — kho mã là công khai và runner tự lưu
trữ.

Tài sản tĩnh được phục vụ với `Cache-Control: no-cache` có chủ ý (nếu không,
iOS Safari sẽ giữ JS/CSS cũ qua các lần triển khai).
