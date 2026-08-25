# Hệ thống âm nhạc sự kiện — tóm tắt giao diện

Một **jukebox QR** cho sự kiện trực tiếp (bữa tối tốt nghiệp trung học ở Hồng
Kông). Máy chiếu hiển thị **trang người phụ trách**; khách quét mã QR trên màn
hình, mở **trang khách** bằng điện thoại và xếp bài hát YouTube vào hàng đợi.
Chỉ có hai màn hình này.
Bản triển khai hiện tại dùng HTML/CSS/JS thuần (`public/host.*` và
`public/guest.*`) — bản thiết kế lại có thể thay đổi toàn bộ kiểu dáng, nhưng
id phần tử và các hành vi dưới đây phải tiếp tục hoạt động.

---

## 1. Trang người phụ trách (`/`) — màn hình được chiếu

Được xem từ khoảng cách xa trong một địa điểm tối, trên máy chiếu. Chữ phải
lớn, rõ ràng và dễ đọc lướt.

**Lớp phủ bắt đầu** — thẻ toàn màn hình có logo, tiêu đề và một nút duy nhất
**▶ Bắt đầu** (trình duyệt yêu cầu một lần nhấp để mở khóa âm thanh). Ghi chú
ngắn về việc chuyển âm thanh tới hệ thống AV của địa điểm.

**Khu vực trình phát** (khu vực chính)
- Trình phát YouTube nhúng (16:9), chiếm phần lớn màn hình.
- Trạng thái chờ khi hàng đợi trống: emoji 🎧 + "Quét mã QR để thêm bài đầu tiên!"
- Bên dưới video: **tiêu đề bài đang phát** và một dòng phụ gồm
  **kênh · Yêu cầu: guest-name** (tên người yêu cầu, chỉ hiển thị khi khách đã nhập tên).
- Hàng điều khiển:
  - ⏸/▶ phát-tạm dừng (cũng dùng phím `space`)
  - ⏭ bỏ qua (cũng dùng phím `n`)
  - 🛡 **Nút Bộ lọc** — bật/tắt trực tiếp bộ lọc nội dung LLM; có trạng thái
    "bật" (được tô sáng) và gợi ý cảnh báo nhỏ ("chưa có khóa LLM — chấp nhận
    tất cả") khi đang bật nhưng chưa được cấu hình.
  - ⏱ **Nút Thời gian chờ** — hiển thị thời gian chờ yêu cầu theo từng khách
    ("Thời gian chờ: 15s" hoặc "Thời gian chờ: TẮT"); khi nhấp sẽ chuyển qua
    các mức 0 / 5 / 10 / 15 / 30 / 60 giây.
  - 🔊 thanh trượt âm lượng.

**Thanh bên**
- **Thẻ QR** — "Quét để thêm bài hát", mã QR lớn và URL khách ở dạng văn bản
  thuần bên dưới. Đây là thành phần quan trọng nhất đối với khách đứng xa màn
  hình.
- **Thẻ Tiếp theo** — danh sách hàng đợi trực tiếp kèm huy hiệu số lượng. Mỗi
  hàng gồm: ảnh thu nhỏ, tiêu đề, kênh · tên người yêu cầu và nút ✕ xóa (chỉ
  người phụ trách được dùng). Trạng thái trống: "Hàng đợi trống — quét mã QR để
  thêm bài hát."

Mọi thứ cập nhật trực tiếp qua WebSocket — không cần làm mới, không có trạng
thái đang tải nào ngoài các trạng thái nêu trên.

---

## 2. Trang khách (`/guest`) — điện thoại di động

Trên thực tế chỉ dùng trên thiết bị di động. Khách sử dụng trong khoảng 30 giây
mỗi lần, thường ở nơi tối và có thể đã hơi chếnh choáng. Vùng chạm phải lớn.
Giao diện dùng tiếng Việt; tên bài hát và tên ca sĩ được giữ nguyên ngôn ngữ gốc
(ví dụ Sơn Tùng M-TP / BLACKPINK) để không làm sai dữ liệu âm nhạc.

**Đầu trang** — tiêu đề và phần giải thích trong một dòng.

**Trường tên** — một ô nhập tùy chọn, "hiển thị cùng bài hát của bạn"; được lưu
trên điện thoại để khách quay lại thấy trường đã được điền sẵn.

**Thanh tìm kiếm** — ô nhập văn bản và nút Tìm kiếm, truy vấn trực tiếp YouTube.

**Mục Khám phá (trình duyệt "KTV")** — chế độ mặc định và phần cốt lõi của
trang:
- **Hàng chip ca sĩ** — các chip có thể cuộn ngang, mỗi chip có ảnh đại diện
  hình tròn (ký tự đầu tiên của tên, màu theo thể loại) và tên. Chạm vào để
  tải các bài hát của ca sĩ đó. Hàng chip được lọc theo tab thể loại đang hoạt
  động.
- **Các tab thể loại** — 🔥 Tất cả · 💜 K-pop · 🎤 V-pop · 🎵 Nhạc trữ tình / bolero · 🎧
  Nhạc phương Tây · 🪩 Nhạc tiệc · 📼 Nhạc kinh điển Việt Nam. Luôn có một tab đang hoạt
  động (được tô sáng).
- **Nút 🔀 Xáo trộn** — xáo trộn lại các bài hát trong lựa chọn hiện tại.
- Các bài hát hiển thị là kết quả YouTube thực tế, hiện tại (được tải trực
  tiếp), không phải danh sách viết sẵn.

**Danh sách kết quả** (dùng chung cho khám phá và tìm kiếm) — mỗi hàng gồm: ảnh
thu nhỏ, tiêu đề, kênh · thời lượng và **nút + thêm** hình tròn. Trạng thái nút:
`+` → `…` (đang kiểm tra) → `✓` (đã thêm, bị vô hiệu hóa). Nút **"Thêm bài hát
↓"** nối thêm nhóm tiếp theo. Sau khi tìm kiếm, nút **"← Quay lại mục Khám phá"**
khôi phục chế độ khám phá.

**Dòng trạng thái** — thông báo nội tuyến: "Đang tải bài hát…", "Đang tìm
kiếm…", "Không tìm thấy bài hát — hãy thử tab khác.", cùng các chuỗi lỗi có 😕.

**Thông báo nổi** (ở dưới cùng) — kênh phản hồi yêu cầu:
- 🔎 "Đang kiểm tra bài hát…" (hiển thị liên tục trong khi máy chủ xác minh)
- ✅ "Đã thêm — đang phát!" / "Đã thêm — vị trí số 3 trong hàng đợi!"
- 🚫 từ chối kèm lý do (ví dụ: "Bài hát này đã có trong hàng đợi!",
  "Bài hát không phù hợp với sự kiện này.", "Hàng đợi đã đầy…")
- ⏳ **đếm ngược trực tiếp** khi khách bị giới hạn tần suất: "Bài tiếp theo sau
  12 giây…", giảm từng giây.

**Mục Tiếp theo** — hàng đợi trực tiếp (huy hiệu số lượng, biểu ngữ bài đang
phát với nhãn "ĐANG PHÁT", danh sách đánh số gồm tiêu đề + kênh). Hàng của các
bài hát do khách này yêu cầu có huy hiệu nhỏ **"BẠN"**. Trạng thái trống: "Chưa
có gì trong hàng đợi — hãy là người đầu tiên!"

---

## Các luồng cần lưu ý

1. **Luồng thuận lợi**: quét QR → vào mục khám phá → chạm vào thể loại/ca sĩ →
   chạm + → thông báo xác nhận vị trí trong hàng đợi → bài hát xuất hiện trong
   mục Tiếp theo (kèm huy hiệu BẠN).
2. **Luồng tìm kiếm**: nhập → kết quả → thêm → "← Quay lại mục Khám phá".
3. **Từ chối**: bài trùng, hàng đợi đầy (50), bộ lọc nội dung, video không thể
   phát và đếm ngược thời gian chờ ⏳. Mỗi trường hợp đều là một thông báo có lý
   do dễ hiểu — khách không bao giờ cảm thấy bị mắc kẹt.
4. **Người phụ trách kiểm duyệt trực tiếp**: bật/tắt bộ lọc, thay đổi thời gian
   chờ, xóa/bỏ qua bài hát — tất cả phản ánh trên mọi điện thoại trong vòng một
   giây.

## Ràng buộc

- Không dùng framework, không có bước build: sản phẩm bàn giao nên tương ứng
  với CSS thuần (hai stylesheet) và cấu trúc/id DOM hiện có khi có thể.
- Trang khách: màn hình nhỏ, dùng bằng một tay, tài sản `no-cache` (thiết kế có
  thể thay đổi tự do giữa các sự kiện). Trang người phụ trách: máy chiếu 16:9,
  phòng tối, có thể đọc được từ cách xa vài mét.
- Không thể thay đổi kiểu dáng của chính trình phát YouTube (đây là iframe
  nhúng).
- Nội dung giao diện bằng tiếng Việt; tên bài hát và nghệ sĩ giữ nguyên ngôn ngữ
  gốc nên font phải hỗ trợ tiếng Việt và các ký tự quốc tế cần thiết.
