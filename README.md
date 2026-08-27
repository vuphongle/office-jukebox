<div align="center">

# 🎶 Hệ thống âm nhạc sự kiện

**Biến mọi máy chiếu thành một jukebox do cả đám đông điều khiển.**

Khách quét mã QR, tìm kiếm trên YouTube bằng điện thoại và xếp bài hát vào hàng
đợi. Nhạc phát trên màn hình lớn — với một DJ AI tùy chọn giúp các yêu cầu phù
hợp với từng dịp, bất kể đó là dịp gì.

[![Runtime: Bun](https://img.shields.io/badge/runtime-bun-f9f1e1?logo=bun&logoColor=black)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Không cần khóa API](https://img.shields.io/badge/YouTube%20API%20key-not%20needed-red)](#cách-hoạt-động)
[![Tự lưu trữ](https://img.shields.io/badge/self--hosted-Docker-blue?logo=docker&logoColor=white)](#chạy-trên-máy-chủ-gia-đình-docker--proxy-ngược)

<img src="docs/host-vi.png" alt="Màn hình máy chiếu — bài đang phát, mã QR và hàng đợi trực tiếp" width="100%" />

<em>Màn hình chính được chiếu: trình phát, mã QR để quét và hàng đợi trực tiếp kèm tên người yêu cầu.</em>

</div>

## Vì sao dự án này tồn tại

Danh sách nhạc trong tiệc thường thất bại theo một trong hai cách: một người
làm DJ suốt đêm, hoặc hàng đợi không được kiểm duyệt đầy những meme và những
thứ tệ hơn. Đây là giải pháp cân bằng — mọi khách có thể thêm bài hát từ điện
thoại của mình chỉ trong vài giây (không cần ứng dụng, không cần tài khoản),
trong khi người phụ trách vẫn có quyền kiểm soát vừa đủ: bỏ qua, xóa, giới hạn
tần suất và dùng bộ lọc LLM tùy chọn hiểu được sự khác biệt giữa *"đây là bữa
tối ở trường"* và *"đây là hộp đêm"* để đánh giá yêu cầu cho phù hợp.

Được xây dựng cho một bữa tối tốt nghiệp có thật ở Hồng Kông; được thiết kế để
dùng cho mọi sự kiện.

## Tính năng

- 📱 **Yêu cầu tức thì** — quét QR → tìm kiếm → chạm. Không cần ứng dụng, không
  cần đăng nhập.
- 🔑 **Không cần khóa API YouTube** — tìm kiếm đọc dữ liệu từ trang kết quả công
  khai; phát nhạc dùng trình phát nhúng tiêu chuẩn.
- 🎤 **Khám phá kiểu KTV** — các tab thể loại (K-pop, V-pop, nhạc trữ tình / bolero,
  nhạc phương Tây, nhạc tiệc, nhạc kinh điển Việt Nam) và các chip ca sĩ với kết
  quả thực tế, cập nhật theo thời gian thực — khách không biết chọn gì chỉ cần
  chạm.
- 🤖 **Bộ lọc nội dung AI (tùy chọn)** — mọi LLM tương thích với OpenAI sẽ đánh
  giá từng yêu cầu theo *sự kiện của bạn*, bổ sung danh mục YouTube, cờ an toàn
  cho gia đình và mô tả video. Ba chế độ được chuyển từ trang máy chiếu:
  **tắt / bật / nghiêm ngặt**. Khi gặp sự cố, hệ thống cho phép yêu cầu đi tiếp
  — việc kiểm duyệt không thể làm nhạc dừng.
- 🎛 **Điều khiển trực tiếp cho người phụ trách** — phát/tạm dừng/bỏ qua, âm
  lượng trong trình phát YouTube, xóa bài, thời gian chờ yêu cầu theo từng khách, chế độ lọc và mô tả
  sự kiện cung cấp cho AI — tất cả từ trang được chiếu, tất cả vẫn được lưu sau
  khi khởi động lại.
- 💬 **Góp ý từ khách** — khách có thể gửi ý tưởng hoặc báo lỗi ngay trên trang
  `/guest`; người phụ trách xem, xóa, bật/tắt tính năng và theo dõi thống kê tại
  `/feedback`.
- 🧠 **AI chat tự chủ (tùy chọn)** — AI đọc hội thoại theo ngân sách tối đa
  100.000 ký tự, tự quyết định lúc nên trả lời hoặc im lặng, duy trì rolling
  summary và memory sự kiện có thời hạn. Admin đặt tên, phong cách, kiến thức,
  mức chủ động, cooldown và quota tại `/admin`.
- 🔒 **Mật khẩu người phụ trách** — đăng nhập tùy chọn bảo vệ trang máy chiếu
  *và* các điều khiển WebSocket; khách không bị ảnh hưởng.
- 🛡 **Rào chắn hàng đợi** — từ chối bài trùng, thời gian chờ theo từng điện
  thoại (hoạt động sau NAT của địa điểm), giới hạn 50 bài, kiểm tra khả năng
  phát trước và bộ giám sát tự động bỏ qua video không bắt đầu được.
- ⚡ **Mọi thứ trực tiếp** — một lần phát WebSocket giữ máy chiếu và mọi điện
  thoại đồng bộ; khách nhìn thấy huy hiệu "Bạn" trên các bài hát của mình.
- 👤 **Tài khoản tùy chọn** — khách vãng lai vẫn dùng toàn bộ luồng chọn bài;
  thành viên có thể đăng ký, điểm danh hằng ngày và tích điểm theo streak.
- ❤️ **Vote bằng điểm** — mỗi lần vote tốn một điểm, có thể vote nhiều lần cho cùng bài; bài chỉ vượt nhóm khi có điểm cao hơn
  Host ghim → số vote → thứ tự thêm; điểm được hoàn khi bài bị xóa hoặc lỗi phát.
- 🎁 **Bảng điều khiển Admin** — quản lý thành viên, điều chỉnh điểm, phát airdrop
  trực tiếp hoặc quà chờ nhận, xem ledger và điều hành góp ý/chat tại `/admin`.

<div align="center">
<img src="docs/guest-vi.png" alt="Trang khách trên điện thoại — khám phá, tìm kiếm và xếp hàng" width="330" />

<em>Trang khách trên điện thoại: tên, tìm kiếm, chip ca sĩ và yêu cầu chỉ bằng một chạm.</em>
</div>

## Bắt đầu nhanh

```bash
git clone https://github.com/Hangton-Code/event-music-system.git
cd event-music-system
bun install
cp .env.example .env      # giá trị mặc định dùng được — bộ lọc AI đang tắt
# đặt ADMIN_PASSWORD mạnh trong .env nếu cần dùng /admin
bun start
```

Mở **http://localhost:45416/** trên máy, kéo cửa sổ sang máy chiếu và nhấn
**Bắt đầu** một lần để trình duyệt cho phép âm thanh. Khách quét mã QR trên màn
hình.

> Ứng dụng yêu cầu Bun vì SQLite dùng module tích hợp `bun:sqlite`.

## Cách hoạt động

```
   Máy chiếu (laptop / server)        Điện thoại khách
  ┌────────────────────┐             ┌──────────────┐
  │  ▶ Đang phát       │   quét QR   │  🔍 tìm kiếm │
  │  [ video YouTube ] │  ◀───────▶  │  + thêm bài  │
  │  ▣ QR   Sắp phát ▤▤│   Wi-Fi     │  hàng đợi    │
  └────────────────────┘             └──────────────┘
            │ âm thanh → hệ thống AV địa điểm
```

| Đường dẫn | Mục đích |
|------|---------|
| `/` | Trang người phụ trách/máy chiếu — trình phát, mã QR, hàng đợi, các điều khiển |
| `/guest` | Trang di động khách mở qua mã QR |
| `/feedback` | Chuyển tới tab góp ý trong bảng điều khiển `/admin` |
| `/admin` | Bảng điều khiển tài khoản, điểm, airdrop, ledger, góp ý và chat (cần tài khoản admin) |
| `GET /api/search?q=` | Đọc kết quả tìm kiếm YouTube (không cần khóa API) |
| `GET /api/browse?q=` | Tìm kiếm chỉ gồm đĩa đơn có bộ nhớ đệm, dùng cho các tab khám phá |
| `POST /api/request` | Rào chắn → kiểm tra khả năng phát → (bộ lọc AI tùy chọn) → thêm vào hàng đợi |
| `POST /api/feedback` | Lưu góp ý của khách khi tính năng đang bật |
| `GET/PATCH/DELETE /api/feedback` | Xem thống kê/danh sách, bật/tắt và xóa góp ý (host) |
| WebSocket `/` | Phát trạng thái hàng đợi; truyền các điều khiển của người phụ trách |

Tìm kiếm trực tiếp ưu tiên context Việt Nam giống YouTube Music web để các bài
nằm ở đầu kết quả gần với lúc người dùng tìm trên web. Nếu kết quả không đủ,
máy chủ bổ sung bằng truy vấn lọc "Songs"; các tab khám phá vẫn chỉ dùng truy
vấn "Songs" và không dùng cookie đăng nhập của người dùng.

**Máy chủ quản lý hàng đợi** (`src/state.js`). Trang máy chiếu chỉ là trình
phát: khi một bài kết thúc hoặc gặp lỗi, trang báo cho máy chủ, máy chủ đưa bài
tiếp theo lên và phát trạng thái mới cho mọi người. Tài khoản, điểm, vote và
hàng đợi được lưu trong `data/jukebox.db`; các thiết lập trên trang máy chiếu
(chế độ lọc, thời gian chờ, bối cảnh sự kiện) vẫn nằm trong
`data/settings.json`.

Luồng yêu cầu: kiểm soát tràn → kiểm tra trùng/giới hạn → kiểm tra khả năng phát
bằng oEmbed → phán quyết LLM tùy chọn → thêm vào hàng đợi. Các video bị tắt nhúng
hoặc khóa theo khu vực nhưng vẫn lọt qua sẽ được trình phát tự động bỏ qua (mã
lỗi iframe + bộ giám sát 20 giây nếu video chưa bao giờ bắt đầu).

## Bộ lọc AI

Mặc định bộ lọc tắt; có thể chuyển chế độ từ trang máy chiếu (nút 🛡 **Bộ lọc**):
**tắt → bật → nghiêm ngặt**. Bộ lọc hoạt động với mọi API trò chuyện tương
thích OpenAI — OpenRouter, Kimi/Moonshot, DeepSeek, GLM… Đổi nhà cung cấp bằng
cách thay đổi ba giá trị `.env`, không cần sửa mã:

```ini
LLM_API_KEY=sk-...
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=deepseek/deepseek-v4-flash
```

Xác minh khóa và liệt kê các mô hình bằng `bun run check-llm`.

**Hiểu ngữ cảnh, không máy móc.** Hãy cho biết sự kiện là gì (nút **Bối cảnh**
trên trang máy chiếu — ví dụ *"một tiệc cưới"*, *"một bữa tiệc ở hộp đêm"*) để
hệ thống đặt tiêu chuẩn phù hợp: những bài phổ biến có nội dung nhạy cảm có thể
được phát ở hộp đêm nhưng không phù hợp với bữa tối ở trường; quốc ca và các
bài hát phản kháng sẽ bị phát hiện trong những sự kiện xã hội thông thường. Chế
độ **Nghiêm ngặt** bỏ qua địa điểm và chỉ cho phép nhạc phù hợp với gia đình.

### Cơ chế xử lý lỗi cần biết:

- **Cho phép tiếp tục** khi có sự cố hạ tầng (không có khóa, lỗi HTTP, hết thời
  gian chờ) — sự cố không bao giờ làm bữa tiệc dừng lại.
- **Từ chối** khi mô hình trả lời nhưng né tránh câu hỏi (bộ lọc nội dung của
  nhà cung cấp hoặc không có phán quyết có cấu trúc) — né tránh được xem là
  từ chối.

> Bộ lọc đọc tiêu đề, kênh, danh mục và mô tả — không đọc âm thanh. Theo mặc
> định, nó phát hiện nội dung không phải âm nhạc và siêu dữ liệu nhạy cảm, nhưng
> không phát hiện lời bài hát nhạy cảm ẩn sau tiêu đề sạch. Trên OpenRouter, đặt
> `LLM_WEB_SEARCH=true` để khắc phục khoảng trống này: mô hình sẽ tìm kiếm từng
> bài trên web và đánh giá lời bài hát thực tế (~$0.005 cho mỗi yêu cầu được
> kiểm duyệt, chậm hơn vài giây).

## AI tự chủ trong phòng chat

AI chat mặc định tắt và được quản lý tại tab **Góp ý & Chat** trong `/admin`.
Khi bật, AI đánh giá hội thoại sau mỗi nhóm tin nhắn mà không cần người dùng tag
hay gọi tên. Tin nhắn người dùng vẫn được phát ngay; request AI chạy nền, lỗi
provider chỉ được ghi trạng thái cho admin và không làm gián đoạn chat.

Chat được lưu trong SQLite và giữ tối đa khoảng 5.000 tin gần nhất cho mỗi sự
kiện. Client chỉ nhận 40 tin gần nhất để giữ UI nhẹ, còn AI có thể lấy lịch sử
theo ngân sách ký tự do admin đặt (8.000–100.000). Phần cũ được rolling summary;
các fact/preference/decision/topic ổn định có thể được lưu thành memory có nguồn,
confidence và thời hạn. Admin có thể xem, ghim, xóa hoặc reset memory. AI không
được tự thêm/xóa bài, chỉnh điểm hay dùng quyền admin.

Chat AI dùng cấu hình provider riêng; nếu `CHAT_AI_API_KEY` trống thì fallback về
`LLM_*` của bộ lọc:

```ini
CHAT_AI_API_KEY=sk-...
CHAT_AI_BASE_URL=https://flowgiare.com/v1
CHAT_AI_MODEL=antigravity/gemini-3.7-flash-high
```

API key chỉ được đặt trong `.env` của máy chạy. Khi AI bật, nội dung chat và phần
ngữ cảnh liên quan có thể được gửi tới provider đã cấu hình; giao diện khách hiển
thị thông báo này ngay trong panel chat.

## Chạy trên máy chủ gia đình (Docker + proxy ngược)

Máy chủ tự xây dựng image từ mã nguồn — không cần registry, không cần đăng nhập:

```bash
git clone https://github.com/Hangton-Code/event-music-system.git
cd event-music-system
cp .env.example .env          # đặt PUBLIC_URL là domain của bạn, cùng HOST_PASSWORD
docker compose up -d --build
```

Container tham gia mạng Docker bên ngoài `reverseproxy` và mở cổng `45416`. Trỏ
proxy ngược tới `event-music:45416`, đặt `PUBLIC_URL` thành tên miền của bạn
(mã QR khách quét sẽ dùng địa chỉ này) và bảo đảm proxy chuyển tiếp
**nâng cấp WebSocket**. Các thiết lập trên trang máy chiếu được lưu trong
`./data`.

> Mạng `reverseproxy` phải tồn tại từ trước (mạng này đã có nếu proxy của bạn
> tạo ra). Nếu chưa có: `docker network create reverseproxy`.

### Cập nhật hệ thống

**Đẩy mã để triển khai (khuyến nghị)** — một runner GitHub Actions tự lưu trữ
xây dựng lại sau mỗi lần đẩy lên `main` (`.github/workflows/deploy.yml`). Thiết
lập một lần:

1. **Đăng ký runner** — kho mã → **Settings → Actions → Runners → New
   self-hosted runner**, chọn Linux, chạy các lệnh được hiển thị trên máy chủ
   gia đình bằng tài khoản sở hữu bản sao repo, rồi chạy `sudo ./svc.sh install <youruser> &&
   sudo ./svc.sh start`.
2. **Quyền truy cập Docker** — chạy `sudo usermod -aG docker <youruser>` (đăng
   nhập lại sau đó).
3. **Vị trí bản sao mã** — quy trình triển khai tới `~/event-music-system` theo
   mặc định; đặt biến repo `DEPLOY_DIR` nếu bản sao của bạn nằm ở nơi khác.

**Thủ công** — chạy `git pull && docker compose up -d --build` bất cứ khi nào
muốn.
**Cron** — `update.sh` chỉ kéo mã và xây dựng lại khi có thay đổi (dùng runner
*hoặc* cron, không dùng cả hai).

> **Lưu ý bảo mật:** runner tự lưu trữ và kho mã công khai cần được quản lý cẩn
> thận. Quy trình này chỉ chạy khi đẩy trực tiếp lên `main` hoặc kích hoạt thủ
> công — không bao giờ chạy trên `pull_request` — nên các bản fork không thể
> thực thi mã trên runner của bạn. Hãy giữ nguyên như vậy.

## ⚠️ Điều số một thường làm sự kiện gặp sự cố: mạng

Điện thoại của khách phải truy cập được máy chủ. Nhiều **mạng Wi-Fi của địa điểm
hoặc khách chặn lưu lượng giữa các thiết bị** ("cô lập máy khách"), khiến mã QR
không tải được gì dù mọi thứ đã được cấu hình đúng.

Các cách khắc phục đáng tin cậy (chọn một):

- **Đưa lên Internet** phía sau một tên miền (theo thiết lập Docker ở trên) —
  điện thoại dùng dữ liệu riêng; không cần xử lý sự cố tại địa điểm.
- **Tạo điểm phát sóng riêng** và cho khách kết nối vào đó.
- **Mang theo bộ định tuyến du lịch** và đưa mọi người vào mạng của thiết bị.

Máy chủ sự kiện luôn cần Internet để phát YouTube.

## Cấu hình

Mọi cấu hình nằm trong `.env` (xem [`.env.example`](.env.example) để biết
danh sách đầy đủ kèm chú thích). Các mục chính:

| Biến | Chức năng |
|----------|--------------|
| `PUBLIC_URL` | Địa chỉ công khai mà mã QR trỏ tới (phía sau proxy ngược) |
| `HOST_PASSWORD` | Khóa trang máy chiếu và các điều khiển (khuyến nghị khi công khai) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Tạo tài khoản admin đầu tiên; cần đặt trước lần khởi động đầu |
| `APP_TIMEZONE` | Múi giờ tính ngày điểm danh (mặc định `Asia/Ho_Chi_Minh`) |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | Bất kỳ nhà cung cấp nào tương thích OpenAI cho bộ lọc |
| `CHAT_AI_API_KEY` / `CHAT_AI_BASE_URL` / `CHAT_AI_MODEL` | Provider tương thích OpenAI cho AI chat; fallback về `LLM_*` nếu key riêng trống |
| `EVENT_CONTEXT` | Mô tả ban đầu về sự kiện cho AI (có thể sửa trực tiếp) |
| `PORT` | Cổng lắng nghe (mặc định `45416`) |

Trạng thái bộ lọc, chế độ kiểm duyệt, thời gian chờ, bối cảnh sự kiện và cấu hình
hành vi AI chat đều có thể sửa khi đang chạy và được lưu trong
`data/settings.json`. Provider/key/model vẫn chỉ nằm ở `.env`; lịch sử chat,
summary và memory nằm trong `data/jukebox.db`.

## Bố cục dự án

```
server.js                  Express + WebSocket server, request pipeline, settings
src/youtube.js             Tìm kiếm không cần khóa, kiểm tra oEmbed, metadata trang xem
src/moderation.js          Bộ lọc nội dung LLM (tương thích OpenAI, fail-open)
src/state.js               Hàng đợi trong bộ nhớ có thẩm quyền
src/net.js                 Phát hiện IP LAN
public/host.*              Trang máy chiếu (trình phát, QR, điều khiển)
public/guest.*             Trang di động (tìm kiếm, khám phá, hàng đợi trực tiếp)
scripts/check-llm.mjs      Xác minh khóa LLM và liệt kê model
Dockerfile                 Image dựa trên Bun
docker-compose.yml         Triển khai máy chủ gia đình (xây dựng cục bộ)
update.sh                  Cách khác dùng Cron: kéo mã và xây dựng lại nếu có thay đổi
```

Không dùng framework, không có bước build, chỉ có ba dependency
(`express`, `ws`, `qrcode`). Toàn bộ dự án chỉ khoảng 1.200 dòng, có thể đọc
xong trong một buổi chiều.

## Giấy phép

[MIT](LICENSE) — hãy sử dụng có trách nhiệm khi tổ chức tiệc. 🎉
