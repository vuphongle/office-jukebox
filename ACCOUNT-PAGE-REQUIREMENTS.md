# Yêu cầu hoàn chỉnh — Trang tài khoản người dùng

## 1. Mục tiêu

Xây dựng trang `/account` để người dùng đã đăng nhập có thể:

- Xem thông tin tài khoản, số dư điểm và chuỗi điểm danh.
- Điểm danh và nhận phần thưởng đang hoạt động.
- Theo dõi các bài hát đang tham gia vote.
- Xem lịch sử nhận và sử dụng điểm.
- Đổi tên hiển thị.
- Đổi mật khẩu an toàn khi cần.
- Đăng xuất khỏi thiết bị hiện tại.

Đồng thời hoàn thiện luồng đăng ký hiện có bằng ô **Xác nhận mật khẩu**.

Trang Account không thay đổi nguyên tắc sản phẩm hiện tại: khách vẫn được chọn bài và chat mà không bắt buộc tạo tài khoản; tài khoản chỉ cần cho điểm danh, nhận điểm, vote và quản lý thông tin cá nhân.

## 2. Nguyên tắc sản phẩm

1. Dùng một trang cuộn duy nhất, không tạo nhiều tab khi số lượng chức năng còn ít.
2. Mỗi nhóm dữ liệu có một hành động chính rõ ràng; không có nút “Lưu tất cả”.
3. Tên đăng nhập là định danh cố định và chỉ đọc. Tên hiển thị được phép chỉnh sửa.
4. Thay đổi tên và thay đổi mật khẩu là hai thao tác độc lập.
5. Mọi thay đổi điểm vẫn do server quyết định; giao diện không tự cộng hoặc trừ điểm trước khi API xác nhận.
6. Hàng đợi, chat và luồng chọn bài dành cho guest phải tiếp tục hoạt động như hiện tại.

## 3. Phạm vi

### 3.1. Có trong phiên bản này

- Route và giao diện responsive `/account`.
- Màn hình yêu cầu đăng nhập khi truy cập Account mà chưa xác thực.
- Tổng quan tài khoản và số dư điểm.
- Điểm danh, streak và các mốc thưởng.
- Nhận point drop đang hoạt động.
- Danh sách bài đang tham gia vote trong hàng đợi hiện tại.
- Lịch sử điểm có phân trang và lọc theo chiều giao dịch.
- Chỉnh sửa tên hiển thị.
- Đổi mật khẩu bằng mật khẩu hiện tại.
- Xác nhận mật khẩu khi đăng ký.
- Đăng xuất.

### 3.2. Chưa làm

- Đổi username.
- Quên hoặc khôi phục mật khẩu qua email.
- Email, số điện thoại và xác minh danh tính.
- Upload ảnh đại diện.
- Xóa tài khoản.
- Danh sách thiết bị/phiên đăng nhập để người dùng tự quản lý.
- Leaderboard, huy hiệu hoặc mạng xã hội.
- Lịch sử vote lâu dài cho những phiên/hàng đợi đã kết thúc.
- Light mode riêng.

## 4. Kiến trúc thông tin

```text
← Quay lại chọn bài                         Office Jukebox

[ Avatar chữ cái ]  Tên hiển thị
                     @username

[       120 điểm       ] [ Streak 4 ngày ] [ Đã điểm danh ]

[ Bài đang tham gia vote trong hàng đợi hiện tại ]

┌ Hoạt động điểm ─────────────────┐  ┌ Điểm danh & phần thưởng ┐
│ Tất cả | Đã nhận | Đã dùng      │  │ Streak và các mốc       │
│ +10  Điểm danh                   │  │ Nút điểm danh           │
│  -1  Vote “Mưa vội phóng”       │  │ Point drop đang có       │
│                      Xem thêm    │  └─────────────────────────┘
│                                  │  ┌ Thông tin cá nhân ──────┐
│                                  │  │ Username — chỉ đọc      │
│                                  │  │ Tên hiển thị + Lưu       │
└──────────────────────────────────┘  └─────────────────────────┘
                                      ┌ Bảo mật ────────────────┐
                                      │ Đổi mật khẩu            │
                                      └─────────────────────────┘

                                      [ Đăng xuất ]
```

## 5. Điều hướng và xác thực

### 5.1. Từ trang Guest

- Bấm tên hoặc avatar trong profile badge sẽ mở `/account`.
- Bấm số điểm hoặc streak vẫn mở popup điểm danh nhanh hiện có.
- Nút quay lại trên Account đưa người dùng về `/guest` và để trình duyệt khôi phục vị trí cuộn trước đó khi có thể.

### 5.2. Người chưa đăng nhập

- `/account` vẫn là URL có thể truy cập trực tiếp.
- Nếu `/api/me` trả `authenticated: false`, hiển thị auth gate trong cùng ngôn ngữ thiết kế, không hiển thị dashboard rỗng.
- Sau khi đăng nhập hoặc đăng ký thành công, tải Account ngay tại chỗ; không bắt người dùng điều hướng lại.
- Có hành động phụ “Tiếp tục chọn bài không cần tài khoản” quay về `/guest`.

### 5.3. Phiên hết hạn

- Nếu API Account trả `401`, chuyển giao diện sang auth gate và thông báo “Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.”
- Không mất URL `/account`; đăng nhập xong quay lại đúng trang.

## 6. Yêu cầu chức năng

### 6.1. Tổng quan tài khoản

Hiển thị từ `/api/me`:

- `displayName`
- `username`
- `pointsBalance`
- `currentStreak`
- `hasCheckedInToday`
- `activeClaimableDrop`

Quy tắc:

- Avatar là ký tự đầu tiên của tên hiển thị, không cần upload ảnh.
- Số điểm dùng chữ số tabular để không thay đổi độ rộng khi cập nhật realtime.
- Cập nhật WebSocket không làm card, nút hoặc phần tử xung quanh thay đổi kích thước.
- Trạng thái điểm danh phải có cả icon và text, không chỉ dùng màu.

### 6.2. Điểm danh và phần thưởng

- Tái sử dụng `POST /api/me/checkin`.
- Hiển thị tiến độ và các mốc 3, 7, 14, 30 ngày.
- Nếu chưa điểm danh: CTA “Điểm danh nhận +1 điểm”.
- Nếu đã điểm danh: trạng thái ổn định “Đã điểm danh hôm nay”; không còn trông như CTA có thể bấm.
- Trong lúc gửi request, khóa nút nhưng giữ nguyên chiều rộng/chiều cao; spinner nằm trong vùng đã dự phòng.
- Sau thành công, cập nhật số dư, streak và thông báo bằng `aria-live="polite"`.
- Nếu thất bại, giữ nguyên trạng thái trước request và hiển thị lý do cùng hành động thử lại.

Point drop:

- Hiển thị khi `activeClaimableDrop` tồn tại.
- Sau khi nhận thành công, card chuyển thành trạng thái hoàn tất mà không làm nội dung phía dưới nhảy vị trí đột ngột.
- Nếu không có point drop, không tạo một card trống.

### 6.3. Bài đang tham gia vote

- Chỉ hiển thị các bài vẫn còn trạng thái `queued` và người dùng đã dùng điểm vote.
- Mỗi hàng hiển thị thumbnail, tên bài, nghệ sĩ/kênh, số điểm người dùng đã bỏ vào bài và tổng điểm bài hát.
- Bài được sắp theo thứ tự hàng đợi server hiện tại.
- Khi bài rời hàng đợi, danh sách cập nhật qua snapshot WebSocket.
- Nếu không có bài đang vote, ẩn toàn bộ section; lịch sử trừ/hoàn điểm vẫn còn trong Hoạt động điểm.
- Không cung cấp nút vote trực tiếp trên trang Account trong phiên bản này; vote tiếp tục thực hiện tại `/guest`.

### 6.4. Lịch sử điểm

Nguồn dữ liệu: `GET /api/me/points/history`.

Hiển thị mỗi giao dịch:

- Số điểm có dấu `+` hoặc `−`.
- Tên hoạt động đã được bản địa hóa.
- `reason` nếu có.
- Ngày giờ theo locale Việt Nam.
- Không hiển thị ID kỹ thuật cho người dùng.

Ánh xạ loại giao dịch:

| Type | Nhãn giao diện |
|---|---|
| `daily_checkin` | Điểm danh hằng ngày |
| `streak_bonus` | Thưởng chuỗi điểm danh |
| `vote_spend` | Vote bài hát |
| `vote_refund` | Hoàn điểm vote |
| `admin_adjustment` | Điều chỉnh bởi quản trị viên |
| `airdrop_direct` | Nhận điểm từ quản trị viên |
| `point_drop_claim` | Nhận điểm phát thưởng |

Bộ lọc:

- **Tất cả**: không lọc theo `delta`.
- **Đã nhận**: `delta > 0`.
- **Đã dùng**: `delta < 0`.
- Khi đổi bộ lọc, quay về trang 1.
- Tổng số và phân trang phải được tính theo bộ lọc ở server; không chỉ lọc 20 phần tử vừa tải trên client.

Phân trang:

- Mặc định 20 giao dịch mỗi lần.
- Nút “Xem thêm” nối thêm vào cuối danh sách.
- Nút có kích thước cố định giữa trạng thái mặc định, loading và hoàn tất.
- Không gọi thêm khi đã tải đủ `total`.

Trạng thái:

- Loading lần đầu: skeleton giữ đúng không gian dự kiến và có `aria-busy="true"`.
- Empty: “Chưa có hoạt động điểm. Hãy điểm danh hôm nay để nhận điểm đầu tiên.” kèm CTA điểm danh nếu phù hợp.
- Error: thông báo rõ nguyên nhân chung và nút “Thử lại”; không biến lỗi API thành empty state.

### 6.5. Đổi tên hiển thị

Form “Thông tin cá nhân” gồm:

- Username ở trạng thái chỉ đọc, có mô tả “Tên đăng nhập không thể thay đổi”.
- Tên hiển thị có label rõ ràng, tối đa 40 ký tự.
- Bộ đếm ký tự chỉ xuất hiện khi người dùng gần giới hạn.
- Nút “Lưu tên hiển thị” chỉ bật khi giá trị hợp lệ và khác dữ liệu đang lưu.

Validation:

- Trim khoảng trắng đầu/cuối.
- Sau khi trim phải từ 1 đến 40 ký tự.
- Cho phép tiếng Việt, khoảng trắng và ký tự Unicode thông thường.
- Không yêu cầu tên hiển thị là duy nhất.
- Validate khi blur và khi submit; không báo lỗi đỏ khi người dùng mới bắt đầu gõ.

Sau thành công:

- Cập nhật header Account và profile badge khi quay về Guest.
- Trả phản hồi “Đã cập nhật tên hiển thị”.
- Không làm thay đổi username, điểm, streak hoặc quyền.

### 6.6. Đổi mật khẩu

Khối “Bảo mật” mặc định thu gọn. Bấm “Đổi mật khẩu” mới mở form, gồm:

1. Mật khẩu hiện tại.
2. Mật khẩu mới.
3. Xác nhận mật khẩu mới.

Quy tắc:

- Mật khẩu mới tối thiểu 6 ký tự, đồng bộ với đăng ký hiện tại.
- Xác nhận phải giống chính xác mật khẩu mới.
- Mật khẩu mới phải khác mật khẩu hiện tại.
- Cho phép paste, password manager và autofill.
- Dùng `autocomplete="current-password"` cho mật khẩu hiện tại.
- Dùng `autocomplete="new-password"` cho hai ô mật khẩu mới.
- Mỗi ô có nút hiện/ẩn mật khẩu bằng SVG và có `aria-label` thay đổi theo trạng thái.
- Không gửi trường xác nhận mật khẩu lên server.
- Lỗi đặt ngay dưới trường liên quan và liên kết bằng `aria-describedby`.
- Sau lỗi submit, focus vào trường lỗi đầu tiên; không chỉ dùng toast.

Sau thành công:

- Xóa giá trị khỏi cả ba ô ngay lập tức.
- Thu gọn form và hiển thị “Đã đổi mật khẩu”.
- Hủy tất cả session cũ của tài khoản, phát hành session mới cho thiết bị hiện tại và ngắt các WebSocket gắn với token cũ.
- Người dùng hiện tại không phải đăng nhập lại ngay trên cùng thiết bị.

An toàn:

- Hash mật khẩu mới bằng hàm async scrypt hiện có.
- Không trả hoặc ghi log mật khẩu/password hash.
- Có rate limit theo user và IP cho thao tác xác minh mật khẩu hiện tại.
- Update password và thay session phải nằm trong một transaction phù hợp để tránh trạng thái đổi mật khẩu nhưng không có session thay thế.

### 6.7. Đăng xuất

- Dùng `POST /api/auth/logout` hiện có.
- Đặt cuối cột Account và tách khỏi các thao tác lưu thông tin.
- Sau thành công quay về `/guest`.
- Trong lúc logout, nút giữ nguyên kích thước và không cho bấm lặp.

## 7. Hoàn thiện luồng đăng ký

### 7.1. Form đăng ký

Khi tab “Đăng ký mới” được chọn, thứ tự trường là:

1. Username.
2. Tên hiển thị.
3. Mật khẩu.
4. Xác nhận mật khẩu.

Khi chuyển lại tab “Đăng nhập”:

- Ẩn trường tên hiển thị và xác nhận mật khẩu.
- Đặt password về `autocomplete="current-password"`.
- Xóa lỗi chỉ thuộc form đăng ký.
- Không để trường xác nhận ẩn tham gia native validation.

### 7.2. Xác nhận mật khẩu

- Field chỉ xuất hiện trong chế độ đăng ký.
- Có label “Xác nhận mật khẩu *”.
- `type="password"`, `autocomplete="new-password"`, `required`, `minlength="6"`.
- Cho phép hiện/ẩn nội dung và cho phép paste.
- So sánh khi blur và khi submit.
- Nếu không khớp: “Mật khẩu xác nhận chưa khớp.”
- Nếu trống: “Vui lòng nhập lại mật khẩu.”
- Không gọi `/api/auth/register` cho đến khi hai mật khẩu khớp.
- Payload đăng ký vẫn là `{ username, password, displayName }`; `confirmPassword` không được gửi hoặc lưu.

### 7.3. Phản hồi form

- Lỗi từng trường hiển thị tại trường đó.
- Lỗi server như username trùng hoặc rate limit hiển thị ở vùng thông báo đầu form và focus vào vùng đó sau submit.
- Button submit có chiều cao/chiều rộng ổn định khi chuyển sang loading.
- Thành công tiếp tục đăng nhập tự động như hiện tại.

## 8. API và repository cần bổ sung

### 8.1. Cập nhật tên hiển thị

`PATCH /api/me/profile`

Request:

```json
{
  "displayName": "Phong Vũ"
}
```

Response thành công:

```json
{
  "ok": true,
  "user": {
    "id": "...",
    "username": "raito",
    "displayName": "Phong Vũ"
  }
}
```

Yêu cầu repository:

- `UserRepository.updateDisplayName(userId, displayName)`.
- Update `display_name` và `updated_at`.
- Không cho client cập nhật `role`, `status`, `points_balance` hoặc username qua endpoint này.

### 8.2. Đổi mật khẩu

`POST /api/me/password`

Request:

```json
{
  "currentPassword": "old-password",
  "newPassword": "new-password"
}
```

Response thành công:

```json
{
  "ok": true,
  "message": "Đã đổi mật khẩu."
}
```

Yêu cầu repository:

- `UserRepository.updatePasswordHash(userId, passwordHash)`.
- Update `password_hash` và `updated_at`.
- Xóa session cũ và tạo session thay thế trong cùng luồng nghiệp vụ.

### 8.3. Lịch sử điểm có lọc

Mở rộng endpoint:

`GET /api/me/points/history?page=1&limit=20&direction=all|earned|spent`

- `all`: mọi delta.
- `earned`: `delta > 0`.
- `spent`: `delta < 0`.
- `total` phải áp dụng cùng điều kiện lọc.
- Giá trị `direction` không hợp lệ trả `400`, không âm thầm fallback.

### 8.4. Vote đang hoạt động

`GET /api/me/votes/active`

Mỗi phần tử cần tối thiểu:

```json
{
  "queueItemId": "...",
  "title": "Mưa vội phóng",
  "channel": "Wren Evans",
  "thumbnail": "https://...",
  "pointsSpent": 3,
  "voteScore": 5,
  "queuePosition": 2
}
```

Endpoint chỉ trả dữ liệu của user đang đăng nhập và các bài vẫn còn trong hàng đợi.

## 9. Thiết kế UI

### 9.1. Hướng hình ảnh

Kết quả tra cứu bằng `ui-ux-pro-max` được áp dụng theo hướng:

- Dark mode ưu tiên màn hình OLED và bối cảnh sự kiện thiếu sáng.
- Phân cấp bằng surface, khoảng cách và typography thay vì hiệu ứng glow nặng.
- Mật độ mức trung bình để desktop không trống nhưng mobile vẫn dễ chạm.
- Motion mức thấp, chỉ dùng để diễn đạt thay đổi trạng thái.

Điều chỉnh để phù hợp sản phẩm hiện có:

- Giữ palette tím mận, vàng và coral hiện có trong `guest.css`; không đưa palette xanh chung của công cụ vào dự án.
- Giữ `Noto Serif` và `Noto Sans`; không thêm font mới chỉ cho Account.
- Dùng semantic token hiện có và bổ sung token theo vai trò nếu thiếu; không hard-code màu riêng trong từng component.
- Giữ logo hiện có và dùng một họ SVG icon nhất quán, ưu tiên Lucide inline để không thêm dependency runtime.

### 9.2. Desktop

- Content container tối đa khoảng 1120px và căn giữa.
- Header, identity card, thống kê và active votes chiếm toàn chiều rộng.
- Nội dung chính dùng grid `minmax(0, 2fr) minmax(300px, 1fr)`.
- Lịch sử điểm nằm cột lớn.
- Điểm danh, thông tin cá nhân, bảo mật và logout nằm cột phụ.
- Không tạo vùng scroll lồng nhau; trang dùng scroll chính của trình duyệt.

### 9.3. Mobile

- Thiết kế từ viewport 375px trước.
- Chuyển về một cột, gutter tối thiểu 16px.
- Card số điểm chiếm toàn hàng; streak và trạng thái điểm danh chia hai card bên dưới để tránh ba ô bị quá hẹp.
- Lịch sử điểm đặt trước phần chỉnh sửa thông tin.
- Nội dung giao dịch được xuống dòng tự nhiên; số điểm nằm trong vùng cố định và không đè lên mô tả.
- Không có horizontal scroll.
- Nút và input cao tối thiểu 44px; khoảng cách giữa touch target tối thiểu 8px.

### 9.4. Typography và nội dung

- Body mobile tối thiểu 16px để tránh iOS tự zoom input.
- Text phụ không nhỏ hơn 13px và phải đạt tương phản tối thiểu 4.5:1.
- Tiêu đề ngắn, tiếng Việt tự nhiên, không dùng thuật ngữ kỹ thuật như ledger, delta hoặc session trên UI.
- Tên bài, tên người dùng và lý do dài được wrap; không cắt thông tin quan trọng bằng ellipsis nếu không có cách xem đầy đủ.

### 9.5. Motion và ổn định layout

- Chỉ animate `opacity` và `transform`; không animate width/height.
- Transition tương tác nhanh khoảng 150–220ms; nội dung xuất hiện khoảng 250–350ms nếu cần.
- Không chạy hiệu ứng entrance cho toàn bộ danh sách giao dịch.
- Tôn trọng `prefers-reduced-motion`.
- Spinner, success icon và label loading phải nằm trong cùng bounds của nút.
- Không thay text ngắn/dài theo cách làm nút đổi chiều rộng.

### 9.6. Accessibility

- Heading theo thứ tự `h1` → `h2` → `h3`.
- Mọi input có `<label for>` hiển thị.
- Focus ring rõ ràng 2–4px, không xóa outline mà không có thay thế.
- Icon trang trí có `aria-hidden="true"`.
- Icon-only button có `aria-label`; toggle mật khẩu thông báo đúng “Hiện mật khẩu”/“Ẩn mật khẩu”.
- Error liên kết với input bằng `aria-describedby`.
- Status và toast không giành focus; dùng `aria-live="polite"`.
- Form có nhiều lỗi dùng error summary có thể focus và link đến từng field, đồng thời vẫn giữ lỗi inline.
- Không dùng màu là tín hiệu duy nhất cho điểm cộng/trừ, thành công hoặc lỗi.
- Cho phép zoom trình duyệt và thao tác hoàn toàn bằng bàn phím.

## 10. Trạng thái giao diện bắt buộc

Mỗi phần tải dữ liệu phải có đủ:

1. Initial loading.
2. Loaded có dữ liệu.
3. Empty có hướng dẫn hoặc CTA phù hợp.
4. Error có nút thử lại.
5. Submitting với kích thước ổn định.
6. Success xác nhận rõ.
7. Unauthorized quay về auth gate.

Không dùng một màn hình trắng, card rỗng hoặc spinner nhấp nháy cho request hoàn thành rất nhanh.

## 11. Tiêu chí nghiệm thu

### Đăng ký

- [ ] Chế độ đăng ký có ô xác nhận mật khẩu; chế độ đăng nhập không có.
- [ ] Hai mật khẩu không khớp thì không gửi request.
- [ ] Paste, autofill và toggle hiện/ẩn hoạt động.
- [ ] Error hiển thị đúng trường và có thể đọc bằng screen reader.
- [ ] Nút đăng ký không thay đổi kích thước khi loading.

### Account

- [ ] `/account` hoạt động khi mở trực tiếp và có đường quay lại `/guest`.
- [ ] Người chưa đăng nhập thấy auth gate, không thấy dashboard giả/rỗng.
- [ ] Số dư, streak, điểm danh và point drop dùng dữ liệu server.
- [ ] Active votes phản ánh đúng số điểm user đã bỏ vào từng bài hiện còn queued.
- [ ] Lịch sử điểm phân trang đúng và lọc đúng trên toàn bộ dữ liệu.
- [ ] Empty và error là hai trạng thái khác nhau.
- [ ] Desktop không quá dàn ngang; mobile 375px không bị cắt hoặc scroll ngang.

### Hồ sơ và bảo mật

- [ ] Người dùng đổi được tên hiển thị 1–40 ký tự Unicode.
- [ ] Username chỉ đọc và không thể cập nhật qua API profile.
- [ ] Tên mới xuất hiện trên Account và profile badge sau khi lưu.
- [ ] Đổi password yêu cầu đúng mật khẩu hiện tại và xác nhận mật khẩu mới.
- [ ] Thành công hủy session cũ, giữ người dùng đăng nhập bằng session mới trên thiết bị hiện tại.
- [ ] Password và hash không xuất hiện trong response hoặc log.
- [ ] Rate limit bảo vệ thao tác đổi password.

### Chất lượng UI

- [ ] Tất cả touch target chính đạt tối thiểu 44×44 CSS px.
- [ ] Focus rõ ràng và tab order khớp thứ tự thị giác.
- [ ] Text thường đạt contrast tối thiểu 4.5:1.
- [ ] Không có layout shift khi số điểm, loading hoặc success state thay đổi.
- [ ] `prefers-reduced-motion` được hỗ trợ.
- [ ] Đã kiểm tra ở 375px, 768px, 1024px và 1440px.

## 12. Validation kỹ thuật tối thiểu khi triển khai

- Unit test repository cho update display name và password hash.
- API test cho unauthorized, validation, success và rate limit.
- Test đăng ký không gửi request khi password confirmation không khớp.
- Test đổi password sai mật khẩu hiện tại không thay hash/session.
- Test đổi password thành công làm token cũ mất hiệu lực và token mới hoạt động.
- Test lọc ledger có `total` đúng theo `direction`.
- Test active votes không lộ dữ liệu vote của user khác.
- Chạy `bun test`.
- Smoke test `/guest` và `/account` trên desktop và mobile 375px.

## 13. Thứ tự triển khai đề xuất

1. Repository và API cập nhật profile/password/ledger/active votes.
2. Test backend và session rotation.
3. Xác nhận mật khẩu trong auth modal hiện tại.
4. Tạo `account.html`, `account.css`, `account.js` và route `/account`.
5. Nối profile badge từ Guest sang Account.
6. Kết nối WebSocket, loading/empty/error states.
7. Responsive và accessibility QA.
8. Chạy test và smoke test cuối.
