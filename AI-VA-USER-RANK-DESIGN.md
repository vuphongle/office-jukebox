# Thiết kế nâng cấp AI và hệ thống Rank người dùng

> Trạng thái: phân tích và đề xuất để duyệt
>
> Phạm vi: tài liệu thiết kế; chưa thay đổi runtime, schema hoặc giao diện.

## 1. Mục tiêu

Nâng AI từ một bot tự quyết định trả lời chat thành trợ lý DJ có thể:

- hiểu kiến thức công ty và bối cảnh sự kiện;
- trả lời đúng các câu hỏi về hàng đợi, vote và hoạt động hiện tại;
- gợi ý bài hát dựa trên mood, lịch sử phát và xu hướng nghe;
- chỉ bình luận khi có giá trị, không spam sau mỗi bài;
- phân tích hàng đợi và góp ý của khách;
- hỗ trợ hệ thống hoạt động, rank và badge cho thành viên.

Nguyên tắc chung:

1. Dữ liệu thực tế do server tính; AI chỉ diễn đạt, phân loại hoặc đề xuất.
2. Hành động có tác động đến hàng đợi, điểm hoặc tài khoản không được tự động bật.
3. Rank XP là điểm danh tiếng/hoạt động, tách khỏi điểm ví dùng để vote.
4. Guest không được xem là danh tính bền vững nếu chưa đăng nhập.
5. AI lỗi hoặc provider hết quota không được làm gián đoạn chat, phát nhạc hoặc vote.

## 2. Phạm vi đã duyệt

Các mục người dùng đã duyệt: **1, 2, 3, 4, 5, 6, 7, 12** trong danh sách ý tưởng
trước đó. Những mục tương tự được gom thành nhóm hành vi để tránh tạo quá nhiều
toggle nhỏ.

Các quyết định đã chốt trong vòng trao đổi hiện tại:

- Context: phương án mở rộng có phân vùng và truy vấn theo nhu cầu.
- Knowledge: giữ một ô kiến thức/FAQ duy nhất như hiện tại.
- Gợi ý: dùng lịch sử phát toàn sự kiện và gu suy luận từ bài user thêm/vote.
- Announcement: chỉ nói theo ngữ cảnh, không spam sau mỗi bài.
- Feedback digest: chạy thủ công hoặc theo batch, chỉ dành cho Admin.
- Rank lâu dài: chỉ dành cho tài khoản có `user_id`.
- Rank scope: XP toàn hệ thống, có thể có leaderboard theo event.
- Bài được phát: `ended` tự nhiên luôn đủ điều kiện; `skipped` đủ điều kiện khi
  thời gian phát đạt `min(90 giây, max(30 giây, 30% duration))`.
- Vote XP: trao một lần khi item đủ điều kiện phát.
- Chat XP: giai đoạn đầu chỉ baseline deterministic, chưa bật AI bonus.
- Online XP: chưa triển khai trong MVP.
- Rank/badge: giữ tên placeholder hiện tại để dùng làm bản đầu.
- Không backfill XP cho dữ liệu cũ.
- Rank/badge hiển thị công khai ở chat, queue, account và Admin.
- Chat mobile: dùng bottom sheet khoảng 76–84dvh, không dùng full-screen.

### Nhóm A — Context và kiến thức có kiểm soát

Bao gồm:

- context lớn hơn;
- kiến thức công ty/phòng ban/FAQ;
- quy tắc và bối cảnh sự kiện;
- lịch sử chat, summary và memory.

AI cần phân biệt rõ nguồn nào là “kiến thức do admin xác nhận” và nguồn nào chỉ là
nội dung chat không đáng tin.

### Nhóm B — Trợ lý hỏi đáp theo ngữ cảnh

Gộp hỏi đáp về:

- thông tin công ty;
- bài đang phát và hàng đợi;
- vị trí, ETA, vote, người thêm bài;
- top vote và câu hỏi liên quan đến bình chọn.

AI chỉ nên chủ động trả lời khi người dùng hỏi hoặc khi câu trả lời thực sự giúp
cuộc trò chuyện. Không cần tách thành nhiều tính năng riêng.

### Nhóm C — Gợi ý bài hát có dữ liệu lịch sử

AI gợi ý dựa trên:

- bài đã phát gần đây của toàn sự kiện;
- bài và nghệ sĩ đang phổ biến trong sự kiện;
- bài người dùng đã thêm hoặc vote nếu có tài khoản;
- mood, thể loại, ngôn ngữ và độ đa dạng của hàng đợi.

Giai đoạn đầu chỉ đưa ra đề xuất, không tự thêm bài.

### Nhóm D — Bình luận như DJ nhưng có chọn lọc

AI có thể giới thiệu bài mới, nhắc vote hoặc nhận xét mood, nhưng phải qua bộ lọc
ngữ cảnh và cooldown. Không gửi một tin nhắn sau mỗi lần chuyển bài.

### Nhóm E — Phân tích và huấn luyện hàng đợi

AI phát hiện trùng nghệ sĩ, mood lệch, hàng đợi mất cân bằng, bài bị bỏ quên hoặc
vote đang cạnh tranh sát nhau. Mặc định chỉ đưa nhận xét/đề xuất, không tự reorder.

### Nhóm F — Tóm tắt góp ý cho Admin

AI phân loại và tóm tắt feedback thành lỗi, ý tưởng, khiếu nại, khen ngợi và mức
ưu tiên. Kết quả chỉ hiển thị cho Admin, không tự trả lời khách.

## 3. Hiện trạng kỹ thuật cần giữ

- `src/chatAi.js` hiện đưa `nowPlaying` và tối đa 10 bài đầu vào context; AI chỉ
  trả `reply` hoặc `stay_silent` cùng memory updates.
- Hàng đợi có trạng thái SQLite và được điều phối qua `JukeboxState`; không được
  cho model ghi trực tiếp vào database.
- `queue_items` đã có `added_by_user_id`, `status`, `started_at`, `finished_at`,
  `video_id`, `vote_score`.
- `queue_votes` đã có user, số điểm vote, thời điểm và cờ hoàn điểm.
- `chat_messages` đã có `user_id`, `created_at`, nội dung và cờ AI/admin.
- Guest có thể chat/thêm bài không cần tài khoản; `name` và `clientId` không đủ
  tin cậy để làm rank lâu dài.
- `chatAiSettings` đang được lưu trong `data/settings.json`; lịch sử, queue,
  vote và user nằm trong SQLite.

## 4. Thiết kế Context mở rộng

### 4.1. Không chỉ tăng một con số context

Context hiện có thể cấu hình 8.000–200.000 ký tự (mặc định 100.000). Có thể mở rộng giới hạn này
theo provider, nhưng nên chia thành các vùng có thứ tự ưu tiên:

1. Quy tắc an toàn và format output.
2. Kiến thức admin xác nhận.
3. Dữ liệu hàng đợi được truy vấn chính xác.
4. Bài đã phát gần đây và thống kê xu hướng.
5. Summary và memory dài hạn.
6. Chat gần đây.

Không nên nạp toàn bộ lịch sử chat và toàn bộ queue vào mọi request. Dữ liệu chi
tiết nên được truy vấn theo câu hỏi; summary dùng cho phần cũ.

### 4.2. Cấu hình đề xuất

```json
{
  "extendedContext": true,
  "contextCharBudget": 100000,
  "knowledgeCharBudget": 20000,
  "recentChatMessages": 100,
  "recentPlayedSongs": 50,
  "queueDetailMode": "on_demand"
}
```

Tên và giá trị là baseline triển khai. Giới hạn thực tế vẫn phải bị chặn bởi
provider đang dùng, không được gửi request vượt giới hạn token; Admin có thể
giảm budget nếu provider hoặc chi phí thực tế yêu cầu.

### 4.3. Blocker và khuyến nghị

- Context lớn làm tăng chi phí và độ trễ; cần hiển thị ước lượng hoặc trạng thái
  provider cho Admin.
- Nội dung chat có thể chứa dữ liệu riêng tư và prompt injection; không đưa API
  key, session, cookie, `requesterId` hoặc thông tin nội bộ không cần thiết vào
  context.
- Kiến thức công ty nên có nhãn `authoritative`, ngày cập nhật và hướng dẫn “nếu
  không chắc thì nói chưa biết”.
- Nên có nút xem/xóa context hoặc reset memory như hiện tại; không tự lưu mọi
  thông tin cá nhân từ chat.

## 5. Hành vi AI đã gom nhóm

### 5.1. Trợ lý hỏi đáp

Khi người dùng hỏi, server tạo một payload sự thật tối thiểu cho AI:

```json
{
  "nowPlaying": {},
  "queue": [],
  "queueCount": 0,
  "topVotes": [],
  "recentPlayed": [],
  "companyKnowledge": "..."
}
```

Server phải tính `queueCount`, vị trí, ETA và vote; AI không tự đếm từ đoạn text
bị cắt. Nếu không có dữ liệu thì AI nói rõ là chưa biết.

### 5.2. Gợi ý bài hát và lịch sử nghe

Nên phân biệt ba loại dữ liệu:

- **Lịch sử phát toàn sự kiện:** các bài đã có trạng thái đủ điều kiện phát,
  sắp theo `finished_at`.
- **Xu hướng sự kiện:** số lần một `video_id` được phát, số người khác nhau đã
  vote/thêm, nghệ sĩ/thể loại phổ biến.
- **Gu của user:** chỉ suy luận từ bài user đã thêm hoặc vote khi có
  `added_by_user_id`/`user_id` đáng tin cậy.

Hiện hệ thống chưa biết chắc một user thực sự “nghe” bài nào, vì nhạc phát chung
trên máy chiếu. Vì vậy không nên gọi dữ liệu suy luận là lịch sử nghe cá nhân nếu
chưa có telemetry xác nhận.

Đề xuất giai đoạn đầu:

- lưu và truy vấn lịch sử bài đã phát gần đây ở cấp sự kiện;
- tính bảng xếp hạng bài/nghệ sĩ theo 7 ngày, 30 ngày và toàn sự kiện;
- suy luận gu cá nhân từ bài đã thêm/vote của tài khoản;
- giữ đề xuất ở chế độ chỉ gợi ý, có lý do ngắn gọn (“đang hợp mood”, “ít trùng
  nghệ sĩ”, “đang được yêu thích”).

Không nên trao thưởng rank dựa trên việc “đã nghe” nếu server chưa xác định được
user nào thực sự nghe.

### 5.3. Bình luận khi chuyển bài — chống spam

AI chỉ được xem xét gửi bình luận khi ít nhất một điều kiện đúng:

- mood thay đổi rõ rệt;
- có một bài đang cạnh tranh vote;
- sau một khoảng im lặng đủ dài;
- đạt milestone của sự kiện;
- người dùng vừa hỏi hoặc nhắc đến bài/nghệ sĩ;
- có thông tin hữu ích từ knowledge/FAQ cần giới thiệu.

Các rào chắn bắt buộc:

- cooldown riêng, đề xuất ban đầu 8–15 phút;
- giới hạn số announcement mỗi giờ;
- không announcement liên tiếp cùng một template hoặc cùng nghệ sĩ;
- im lặng khi chat đang sôi nổi hoặc có nhiều tin nhắn nối tiếp;
- confidence thấp thì `stay_silent`;
- Admin có thể chọn `off`, `only_when_asked`, `contextual`, `milestone_only`.

Nên có pre-filter rẻ và deterministic trước khi gọi LLM. Nhiều lần chuyển bài
không đủ điều kiện thì không gọi provider.

### 5.4. Phân tích hàng đợi và vote

Mặc định AI đưa nhận xét chứ không hành động:

- “Ba bài liên tiếp cùng nghệ sĩ.”
- “Hàng đợi đang nghiêng mạnh về một thể loại.”
- “Hai bài đang có số vote gần bằng nhau.”
- “Có bài đã chờ lâu nhưng chưa được vote.”

Kết quả nên có phạm vi người xem: công khai trong chat, chỉ Admin, hoặc chỉ trả lời
khi được hỏi. Giai đoạn này không bao gồm skip, xóa, ghim, reorder hay tự thêm bài.

### 5.5. Tóm tắt góp ý

Feedback digest nên chạy theo batch/manual, không chạy sau từng feedback. Kết quả
gồm:

- nhóm chủ đề;
- số lượng và xu hướng;
- ví dụ message ID để Admin kiểm tra lại;
- mức ưu tiên do AI đề xuất;
- cờ “cần người xem xét”, không tự đóng/xóa feedback.

## 6. Cấu hình Admin AI đề xuất

Gom theo hành vi, không tạo một toggle cho từng câu trả lời nhỏ:

```text
AI tự chủ

[ ] Context mở rộng
[ ] Trợ lý thông tin công ty và hàng đợi
[ ] Gợi ý bài hát dựa trên lịch sử/xu hướng
[ ] Bình luận DJ theo ngữ cảnh
[ ] Phân tích hàng đợi và vote
[ ] Tóm tắt góp ý cho Admin
```

Các điều khiển chung:

- trigger: sau message / khi queue đổi / idle / manual;
- cooldown và quota theo nhóm;
- phạm vi hiển thị: chat công khai hoặc Admin;
- privacy: có cho phép dùng chat để suy luận mood hay không;
- provider/context budget;
- nút “Khuấy động ngay” vẫn là trigger thủ công.

## 7. Thiết kế hệ thống Activity, Rank và Badge

### 7.1. Mục tiêu và ranh giới

Rank phản ánh đóng góp bền vững cho sự kiện/cộng đồng, không phải số dư ví. Rank
XP không dùng để vote, không đổi trực tiếp thành tiền/điểm ví và không được cộng
chỉ vì user gửi một request vào server.

Các nguồn hoạt động đã nêu:

1. Bài user thêm vào và thực sự được phát.
2. Vote hợp lệ.
3. Chat có chất lượng trong một khoảng thời gian.
4. Thời gian online có kiểm soát.

### 7.2. Nguyên tắc tính điểm

- Không cộng khi chỉ thêm bài vào queue.
- Không cộng khi bài bị xóa trước khi phát.
- Không cộng cho bài lỗi phát.
- Một queue item chỉ trao thưởng một lần cho người thêm.
- Vote phải có giới hạn/diminishing return; không thưởng tuyến tính vô hạn cho
  multi-vote cùng một bài.
- Chat tính theo các khoảng thời gian hoạt động và chất lượng, không tính theo
  tổng số message.
- Online chỉ là nguồn điểm nhỏ, không thể đứng một chỗ để farm rank.
- Mỗi nguồn có cap ngày/sự kiện; tổng điểm cũng có cap.

### 7.3. Bài được phát — quy tắc cần chốt

Hiện `queue_items.status = 'played'` có thể xảy ra khi bài kết thúc tự nhiên hoặc
host bấm skip, còn schema chưa lưu rõ lý do kết thúc và thời lượng đã phát. Đây là
blocker P0 cho việc tính rank chính xác.

Khuyến nghị:

- thêm `finish_reason`: `ended`, `skipped`, `removed`, `error`;
- thêm hoặc suy ra `played_seconds` đáng tin cậy;
- `ended` tự nhiên được xem là đủ điều kiện;
- `skipped` chỉ đủ điều kiện nếu đã phát tối thiểu ngưỡng cấu hình, ví dụ 30–90
  giây hoặc một tỷ lệ phần trăm duration;
- `removed`/`error` trước ngưỡng không được XP;
- lưu một activity event idempotent theo `queue_item_id`.

Không nên dùng riêng `status = 'played'` cho đến khi phân biệt được các trường hợp
trên, nếu không user có thể farm bằng cách thêm bài rồi nhờ host skip.

### 7.4. Vote — khuyến nghị an toàn

Phương án nên dùng cho MVP:

- một user chỉ nhận **vote participation XP một lần cho mỗi queue item**;
- trao XP khi item kết thúc đủ điều kiện, không phải mỗi lần bấm vote;
- vote cho item bị xóa/lỗi không nhận XP;
- multi-vote vẫn tiêu điểm ví theo luật hiện tại nhưng không nhân rank vô hạn;
- có cap vote XP theo ngày/event.

Phương án này làm XP đến chậm hơn một chút nhưng tránh vòng lặp vote → xóa → hoàn
điểm → vote lại để farm rank.

### 7.5. Chat — AI chỉ đánh giá, server mới tính XP

Đề xuất chia chat thành cửa sổ 15 phút cho từng user tài khoản:

- số message khác nhau sau khi dedupe;
- số bucket hoạt động khác nhau, ví dụ bucket 2 phút;
- tỷ lệ message lặp/spam;
- độ dài và mức liên quan tối thiểu;
- số lần user tham gia các khoảng khác nhau, thay vì một burst ngắn.

Server tính baseline và cap trước. AI chỉ được trả một đánh giá bounded như:

```json
{
  "quality": 0.0,
  "labels": ["on_topic", "helpful"],
  "sourceMessageIds": ["..."],
  "confidence": 0.0
}
```

AI không được trả thẳng số XP. Server áp dụng công thức/cap, ví dụ:

```text
windowXp = min(windowCap,
  baselineFromUniqueTimeBuckets + boundedQualityBonus)
```

Rào chắn:

- một user gửi 30 message trong cùng một bucket không được nhận 30 lần XP;
- message trùng nội dung hoặc bị gắn cờ spam không nhận XP;
- mỗi cửa sổ chỉ có tối đa một AI quality bonus;
- AI lỗi thì vẫn có thể dùng baseline thấp hoặc bỏ bonus, không block chat;
- không tính message do AI gửi;
- nội dung xúc phạm/quấy rối không nhận XP và có thể chuyển sang cảnh báo Admin;
- chỉ user có `user_id` mới nhận rank bền vững; guest không dùng tên/clientId để
  tích lũy rank lâu dài.

### 7.6. Thời gian online

WebSocket đang phản ánh kết nối nhưng chưa phản ánh chắc chắn người dùng đang
nhìn màn hình. Vì vậy online XP nên có trọng số thấp.

Khuyến nghị MVP:

- chỉ tính cho user tài khoản;
- theo dõi session và heartbeat định kỳ;
- gom nhiều thiết bị của cùng user thành một khoảng thời gian;
- chỉ tính khi có heartbeat hợp lệ và/hoặc có hoạt động foreground gần đó;
- cap theo ngày, ví dụ tối đa 1–2 giờ được tính;
- không tính tab host/admin vào rank thành viên;
- guest chỉ có hoạt động tạm thời trong phiên, không lưu rank lâu dài.

Nếu cần xác định foreground chính xác, client phải gửi signal visibility; signal này
vẫn cần xem là không đáng tin tuyệt đối và phải có cap.

### 7.7. Công thức XP MVP đề xuất

Các con số cần được Admin chỉnh sau khi quan sát dữ liệu thật; đây là baseline để
tránh một nguồn áp đảo:

| Hoạt động | XP đề xuất | Điều kiện/cap |
|---|---:|---|
| Bài được phát đủ điều kiện do user thêm | +10 | Một lần/queue item; cap theo ngày/event |
| Vote participation cho item đã phát | +2 | Một lần/user/item; không tính item lỗi/xóa |
| Chat quality window | 0–8 | Một lần/15 phút; cap ngày; AI chỉ cấp quality bounded |
| Online activity | +1/10 phút | Cap ngày; trọng số thấp |

Tổng XP ngày nên có cap, ví dụ 100 XP, và mỗi nguồn không nên chiếm quá 60% tổng
XP nếu mục tiêu là khuyến khích hoạt động đa dạng.

### 7.8. Rank và badge

Đề xuất 6 bậc ban đầu, tên chỉ là placeholder để duyệt:

| Bậc | XP tích lũy | Tên hiển thị | Badge gợi ý |
|---:|---:|---|---|
| 1 | 0 | Người mới bắt nhịp | tai nghe xanh |
| 2 | 100 | Bắt nhịp | nhịp sáng |
| 3 | 300 | Tạo vibe | ngọn lửa |
| 4 | 700 | DJ cộng đồng | bàn xoay |
| 5 | 1.500 | Headliner | ngôi sao sân khấu |
| 6 | 3.000 | Huyền thoại | vương miện neon |

Badge cần có icon, màu, label text và trạng thái accessibility; không phụ thuộc
chỉ vào emoji. Nên hiển thị ở chat, tên người thêm queue, trang tài khoản và Admin.

Rank tăng theo XP, không tụt chỉ vì ít hoạt động. Nếu cần decay theo mùa/sự kiện,
đó phải là quyết định riêng, không ngầm thêm vào MVP.

## 8. Data model đề xuất

Không nên dùng `point_ledger` hiện tại cho rank XP vì đó là nền kinh tế vote/airdrop.
Nên thêm các bảng riêng:

### `user_rank_profiles`

- `user_id` primary key;
- `xp_total`, `rank_level`, `updated_at`;
- có thể thêm `season_id` nếu rank theo mùa.

### `rank_activity_ledger`

- `id`, `user_id`, `event_id`;
- `activity_type`, `delta_xp`, `source_id`, `metadata_json`;
- `created_at`;
- unique idempotency key theo loại hoạt động và nguồn.

Ví dụ `source_id`: queue item ID, vote settlement ID, chat window ID hoặc presence
session ID. Ledger phải append-only; sửa sai dùng adjustment event có actor/reason.

### `rank_chat_windows`

- `user_id`, `event_id`, `window_start`, `window_end`;
- counts đã dedupe, active buckets, spam score, AI quality/confidence;
- `xp_awarded`, `evaluated_at`;
- unique `(user_id, event_id, window_start)`.

### `user_presence_sessions`

- `user_id`, `event_id`, `started_at`, `last_seen_at`, `ended_at`;
- `active_seconds`, `device/session key` đã hash hoặc nội bộ;
- index theo user và thời gian.

### Queue migration

Thêm thông tin kết thúc/đủ điều kiện vào `queue_items` hoặc bảng playback event:

- `finish_reason`;
- `played_seconds` hoặc `qualified_play_at`;
- cờ/event ID đã trao rank.

Các index chính:

- `queue_items(event_id, status, finished_at)`;
- `queue_items(added_by_user_id, status, finished_at)`;
- `queue_votes(user_id, created_at)`;
- `chat_messages(event_id, user_id, created_at)`;
- `rank_activity_ledger(user_id, event_id, created_at)`.

## 9. Blocker và quyết định cần chốt

### P0 — cần giải quyết trước khi triển khai

1. **Danh tính guest hay account:** rank lâu dài chỉ dành cho account hay guest có
   rank tạm thời?
2. **Định nghĩa “bài đã được phát”:** chỉ `ended` tự nhiên hay skip sau ngưỡng
   thời gian cũng được tính?
3. **Phạm vi rank:** toàn công ty/toàn hệ thống, theo event, hay theo mùa?
4. **Có tính XP ngược cho dữ liệu cũ không?** Khuyến nghị chỉ tính từ thời điểm
   phát hành để tránh backfill không công bằng.
5. **Privacy/retention:** lưu chat activity và presence trong bao lâu, ai được
   xem chi tiết?
6. **Ngân sách AI:** context mở rộng và đánh giá chat mỗi cửa sổ có giới hạn
   provider/cost nào?

### P1 — cần thiết kế trước khi mở rộng

1. Cơ chế Admin điều chỉnh threshold, multiplier và cap nhưng vẫn ghi audit.
2. Reset rank theo event/mùa mà không xóa lịch sử ledger.
3. Badge achievement riêng hay chỉ badge theo rank.
4. Xử lý nhiều thiết bị và reconnect.
5. Dashboard để quan sát phân bố XP, spam và outlier trước khi cho badge công khai.
6. Chính sách khi user bị block, đổi tên hoặc tài khoản bị xóa.

### Khuyến nghị không làm trong MVP

- AI tự skip/xóa/reorder/ghim/thêm bài.
- AI tự cộng rank XP không qua server formula và ledger.
- Rank bền vững cho guest dựa trên tên hoặc `clientId`.
- Dùng số lượng message thô làm điểm.
- Dùng thời gian WebSocket kết nối thuần túy làm thời gian online.
- Tự suy luận “lịch sử nghe cá nhân” khi chỉ có dữ liệu phát chung.

## 10. Acceptance criteria đề xuất

### AI

- Hỏi số bài/ETA/vote nhận số liệu từ server, không phụ thuộc AI tự đếm.
- Gợi ý có thể nêu bài đã phát gần đây và xu hướng, không bịa lịch sử cá nhân.
- Chuyển bài liên tục không tạo announcement liên tục.
- Khi chat đang sôi nổi, AI ưu tiên im lặng.
- Feedback digest chỉ xuất hiện ở Admin.
- Provider lỗi không block chat/queue/vote.
- Context không chứa secret hoặc thông tin định danh nội bộ không cần thiết.

### Rank

- Thêm bài rồi xóa: 0 XP.
- Thêm bài rồi lỗi phát: 0 XP.
- Bài đủ điều kiện phát: trao đúng một lần.
- Vote nhiều lần cùng item: không nhân XP vô hạn.
- Spam nhiều message trong một khoảng ngắn: không được XP tuyến tính.
- AI quality bonus bị giới hạn bởi server cap.
- Reconnect/multiple devices không nhân đôi online XP.
- Mọi XP đều truy được về activity ledger và source ID.
- Guest không thể giả mạo tên để chiếm rank của account.

## 11. Rollout đề xuất

### Phase 0 — chốt rule

- Chốt 6 quyết định P0.
- Chốt tên rank, màu badge, phạm vi hiển thị.
- Chốt provider budget/context budget.

### Phase 1 — nền tảng dữ liệu

- Migration activity ledger/rank profile.
- Finish reason và qualified play cho queue.
- Deterministic aggregation cho queue, vote, chat window và presence.
- Chưa bật AI scoring, chưa hiển thị badge công khai.

### Phase 2 — AI context và trợ lý

- Context mở rộng có budget.
- Hỏi đáp công ty/hàng đợi/vote.
- Lịch sử phát và ranking bài/nghệ sĩ.
- Gợi ý bài hát ở chế độ không tự thêm.

### Phase 3 — trải nghiệm DJ

- Announcement theo ngữ cảnh và cooldown.
- Queue/vote insights.
- Admin feedback digest.

### Phase 4 — rank và badge

- Tính XP từ activity ledger.
- Hiển thị rank/badge ở account, chat và queue.
- Dashboard phân bố XP và abuse review.

### Phase 5 — AI chat quality

- AI đánh giá từng chat window với bounded quality score.
- So sánh baseline không AI với quality bonus.
- Chỉ bật bonus sau khi có dữ liệu và kiểm tra spam.

## 12. Quyết định đã chốt để triển khai

Các lựa chọn còn lại đã được chốt theo phương án khuyến nghị:

1. **Ngưỡng skip:** bài tự nhiên kết thúc luôn đủ điều kiện; bài bị skip chỉ đủ
   điều kiện khi đã phát `min(90 giây, max(30 giây, 30% duration))`.
2. **Tên/badge:** giữ 6 tên placeholder hiện tại trong MVP:
   Người mới bắt nhịp, Bắt nhịp, Tạo vibe, DJ cộng đồng, Headliner, Huyền thoại.
3. **Chat mobile:** dùng bottom sheet 76–84dvh; desktop/tablet giữ popover rộng hơn.
4. **AI chat quality bonus:** chưa bật trong MVP; chỉ xem xét sau khi có baseline
   deterministic và dữ liệu chống spam.

Tài liệu này đã đủ quyết định để tách implementation plan. Các con số XP, cap,
context budget và ngưỡng quota vẫn là cấu hình ban đầu có thể tinh chỉnh sau khi
quan sát dữ liệu thật, không thay đổi nguyên tắc chống lạm dụng.

## 13. Phạm vi bổ sung — cải thiện Chat trên Guest

### 13.1. Vấn đề hiện tại

Markup và CSS hiện tại dùng một popover cố định ở góc phải dưới, rộng tối đa
360px, vùng message cao tối đa khoảng 320px, bubble tối đa 88% chiều rộng và
text 13px. Trên màn hình điện thoại điều này làm khung chat có cảm giác hẹp,
thấp và khó đọc; launcher cũng chỉ cao 48px nên dễ bấm hụt. Client hiện không
giữ `createdAt` khi đưa message vào state hiển thị, vì vậy chưa thể hiển thị
thời gian gửi.

### 13.2. Hướng thiết kế được đề xuất

#### Mobile — bottom sheet dễ đọc

- Launcher tối thiểu 52×52px, cách mép dưới theo safe-area và không bị toast/queue
  che.
- Khi mở, chat dùng gần toàn chiều rộng màn hình, cao khoảng 76–84dvh, thay vì
  popover 360px.
- Bo góc lớn ở hai góc trên; header và composer cố định, message list chiếm phần
  còn lại và cuộn độc lập.
- Chừa `env(safe-area-inset-bottom)` cho iPhone và dùng `dvh` để tránh lỗi khi
  bàn phím mở.
- Có thể dùng backdrop mờ nhẹ để người dùng nhận biết chat đang là lớp tương tác
  hiện tại; đóng bằng nút X, Escape hoặc thao tác back của trình duyệt.

#### Desktop/tablet — popover rộng hơn

- Giữ hành vi nổi ở góc phải dưới để không thay đổi layout chọn bài.
- Tăng chiều rộng khoảng 400–440px và chiều cao tối đa khoảng 560–640px.
- Không để panel che nút hành động chính hoặc queue quan trọng.

#### Message dễ đọc

- Tăng text lên khoảng 14–15px, line-height 1.5–1.6.
- Bubble dài dùng tối đa khoảng 94% chiều rộng ở mobile và wrap tự nhiên; không
  cắt nội dung bằng CSS.
- Giữ màu riêng cho own/admin/AI nhưng không dùng màu làm tín hiệu duy nhất.
- Hiển thị tên, badge và thời gian theo thứ bậc thị giác rõ ràng.
- Không đổi giới hạn backend 280 ký tự ở phase này; chỉ làm phần hiển thị và đọc
  dễ hơn.

#### Composer phù hợp bàn phím điện thoại

- Đổi input một dòng thành textarea tự co giãn 1–4 dòng, vẫn giữ `maxlength=280`.
- Nút gửi tối thiểu 44–48px, luôn nằm trong footer cố định.
- Khi bàn phím mở, composer không bị bàn phím che; message list tự cuộn đến message
  mới nhất.
- Có thể thêm bộ đếm ký tự nhẹ nếu vẫn giữ layout gọn.

### 13.3. Thời gian gửi tin nhắn

Server đã gửi `createdAt` trong message payload nhưng client hiện loại trường này
khi lưu state hiển thị. Cần giữ lại `id` và `createdAt`, sau đó render:

- tin trong ngày: giờ/phút, ví dụ `14:32`;
- tin ngày trước: ngày + giờ;
- `title` và accessible label chứa timestamp đầy đủ theo locale `vi-VN`;
- có thể dùng relative label như “vừa xong”, “2 phút trước” nhưng phải có giờ
  tuyệt đối khi hover/focus.

Không cần gọi thêm API; không thay đổi WebSocket contract. Timestamp phải được
render an toàn bằng DOM/text node như nội dung message hiện tại.

### 13.4. Hành vi khi mở/đóng

- Mở chat bằng một lần chạm rõ ràng; launcher có hit area tối thiểu 44px.
- Khi mở, focus vào composer như hiện tại; khi đóng, trả focus về launcher.
- Giữ unread badge và không đánh dấu đã đọc nếu panel chưa thực sự mở.
- Không tự mở chat chỉ vì AI gửi message.
- Khi có message mới lúc panel đóng, chỉ tăng unread count; không che nội dung
  người dùng đang thao tác.

### 13.5. Acceptance criteria UI/UX

- Ở viewport khoảng 390×844, launcher không bị che và bấm chính xác bằng một tay.
- Panel mobile dùng được bằng ngón tay, không tạo horizontal overflow.
- Một message đủ 280 ký tự vẫn đọc được qua nhiều dòng và cuộn bình thường.
- Composer vẫn nhìn thấy khi keyboard của iOS Safari/Android mở.
- Mỗi message có timestamp hiển thị và accessible label đầy đủ.
- Chat history, AI badge, Admin badge, unread count và WebSocket behavior không đổi.
- Desktop không bị biến thành full-screen và layout chọn bài/queue không bị phá.
- Không dùng `innerHTML` với tên/nội dung/timestamp do người dùng gửi.

### 13.6. Blocker và khuyến nghị

1. Cần chốt mobile là **bottom sheet 76–84dvh** hay full-screen; khuyến nghị
   bottom sheet để vẫn giữ cảm giác đang ở trang chọn bài.
2. Cần kiểm tra thực tế trên iOS Safari và Android Chrome vì `dvh`, safe-area và
   keyboard thường khác emulator/desktop.
3. Cần giữ nguyên giới hạn 280 ký tự ở phase UI; tăng giới hạn message là quyết
   định riêng vì ảnh hưởng moderation, context và chống spam.
4. Timestamp nên dùng `createdAt` từ server, không dùng giờ local lúc client nhận
   message.
5. Phần UI này không nên phụ thuộc AI; chat thường phải dễ dùng ngay cả khi AI tắt
   hoặc provider lỗi.

## 14. Trạng thái triển khai trên branch feature

- Đã triển khai SQLite schema/migration cho rank profile, activity ledger, chat
  windows và metadata playback; XP rank tách khỏi điểm vote.
- Đã nối XP cho bài phát đủ điều kiện, vote tham gia một lần trên mỗi bài và
  chat window deterministic có chống lặp/cap theo ngày.
- Đã thêm API rank cho member/Admin, badge trong chat/queue/account và rank trong
  danh sách thành viên Admin.
- Đã mở rộng AI context/knowledge, thêm nhóm feature toggle, queue-change
  announcement có cooldown và digest góp ý thủ công phía Admin.
- Đã cải thiện guest chat mobile thành bottom sheet, textarea nhiều dòng,
  timestamp server và hiển thị badge.
- Chưa bao gồm XP online/presence, AI quality bonus hoặc backfill dữ liệu cũ;
  đây là các phần được chốt để triển khai sau khi có baseline vận hành.
