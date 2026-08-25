// Kiểm duyệt bài hát bằng LLM thông qua bất kỳ API chat tương thích OpenAI nào.
//
// Nhà cung cấp mặc định là Kimi (Moonshot). Đổi sang DeepSeek / GLM / ... bằng cách
// thay đổi LLM_BASE_URL + LLM_MODEL + LLM_API_KEY trong .env — không cần sửa code.
//
// Ghi chú thiết kế:
//  - Không phụ thuộc vào `response_format: json_object` (mức hỗ trợ khác nhau
//    giữa các nhà cung cấp). Thay vào đó, yêu cầu JSON trong prompt và chủ động
//    trích xuất block {...} đầu tiên từ câu trả lời.
//  - Không đặt `temperature` (kimi-k2.x từ chối các giá trị tùy ý); mặc định của
//    API được sử dụng trừ khi đặt rõ LLM_TEMPERATURE.
//  - Chỉ FAIL-OPEN khi lỗi hạ tầng (thiếu key, lỗi HTTP, lỗi mạng): sự cố kiểm
//    duyệt không bao giờ dừng buổi tiệc và không ném lỗi vào luồng request.
//  - FAIL-CLOSED khi hết thời gian chờ, với lý do cho phép khách thử lại:
//    các phán quyết chậm thường tập trung ở đúng những bài hát cần bộ lọc,
//    nên không được phát bài hát đã hết thời gian chờ mà chưa kiểm duyệt.
//  - FAIL-CLOSED khi model trả lời nhưng không đưa ra phán quyết: provider che
//    nội dung bằng content_filter hoặc trả lời không có JSON {"approved": ...}
//    hợp lệ đều có nghĩa model né câu hỏi — từ chối bài hát.
//  - LLM_WEB_SEARCH=true (chỉ OpenRouter) gắn web plugin của OpenRouter để model
//    thấy kết quả tìm kiếm trực tiếp — thường là lời bài hát thực tế — thay vì
//    chỉ phán đoán theo tiêu đề. Chi phí khoảng ~$0.005 cho mỗi request kiểm
//    duyệt (tìm kiếm Exa), cộng thêm token; nhà cung cấp khác sẽ từ chối field
//    bổ sung nên tính năng này phải được bật chủ động.

function config(opts = {}) {
  return {
    apiKey: opts.apiKey ?? process.env.LLM_API_KEY ?? "",
    baseUrl: (opts.baseUrl ?? process.env.LLM_BASE_URL ?? "https://api.moonshot.ai/v1").replace(/\/+$/, ""),
    model: opts.model ?? process.env.LLM_MODEL ?? "kimi-k2.6",
    strict: opts.strict ?? (process.env.MODERATION_MODE || "").toLowerCase() === "strict",
    eventContext:
      opts.eventContext ??
      (process.env.EVENT_CONTEXT ||
        "một buổi tiệc tối mừng lễ tốt nghiệp trung học (giống dạ tiệc) ở Hồng Kông"),
    temperature: opts.temperature ?? process.env.LLM_TEMPERATURE, // undefined = dùng mặc định của API
    webSearch: opts.webSearch ?? (process.env.LLM_WEB_SEARCH || "").toLowerCase() === "true",
    timeoutMs: opts.timeoutMs, // xử lý bên dưới — web search cần thêm thời gian
  };
}

export function moderationConfigured() {
  return !!(process.env.LLM_API_KEY);
}

function buildMessages(song, details, { strict, eventContext, webSearch }) {
  // Prompt được ghép theo THỨ TỰ RA QUYẾT ĐỊNH: từ chối ngay trước (quy tắc 1 —
  // không điều gì phía sau được ghi đè), sau đó là tiêu chuẩn của chế độ, các
  // quy tắc theo tình huống và cuối cùng là định dạng đầu ra. Quốc ca được nêu
  // rõ trong quy tắc 1 vì model thường suy luận "yêu nước = an toàn cho gia đình
  // = chấp thuận"; ngoại lệ cho Beyond là chính sách có chủ đích của host — một
  // ca khúc kinh điển chỉ tình cờ có liên hệ chính trị không phải là bài hát
  // chính trị. 'Stay' xuất hiện như ví dụ hiệu chỉnh ở cả hai nhánh với phán
  // quyết trái ngược về mục đích: mỗi lần chỉ gửi một nhánh, qua đó xác định
  // chính xác ngưỡng nghiêm ngặt/mặc định.
  const rules = [
    `Bạn kiểm duyệt các yêu cầu bài hát cho hàng đợi âm nhạc công khai tại ${eventContext}. ` +
      "Hãy quyết định theo thứ tự này: quy tắc 1 trước, sau đó là tiêu chuẩn ở quy tắc 2, rồi các quy tắc còn lại. " +
      "Quy tắc 1 là tuyệt đối — không quy tắc sau, siêu dữ liệu video hay độ phổ biến của bài hát " +
      "được phép ghi đè quy tắc này.",

    "QUY TẮC 1 — TỪ CHỐI NGAY (mọi chế độ, mọi sự kiện, không ngoại lệ): " +
      "(a) không phải âm nhạc: podcast, gameplay, bài hướng dẫn, bài nói chuyện, tin tức, ASMR, hiệu ứng âm thanh. " +
      "(b) Quốc ca của BẤT KỲ quốc gia nào — có lời, không lời hoặc bản trình diễn chính thức. Quốc ca " +
      "là tác phẩm nghi lễ cấp nhà nước, không bao giờ phù hợp với hàng đợi tiệc, dù lời có trong sáng đến đâu " +
      "hay cờ an toàn cho gia đình của YouTube có vẻ phù hợp đến đâu. " +
      "(c) bài hát có mục đích cốt lõi là chính trị: nhạc phản kháng, thông điệp chính trị, tuyên truyền. " +
      "Làm rõ: một ca khúc pop/rock phổ biến chỉ TÌNH CỜ có liên hệ chính trị theo thời gian " +
      "(ví dụ 海闊天空 hoặc 光輝歲月 của Beyond, đều thường được phát trong lễ tốt nghiệp) KHÔNG phải là " +
      "bài hát chính trị — hãy đánh giá nội dung của chính bài hát, không phải cách nó từng được sử dụng. " +
      "(d) bài hát dựa trên thù ghét: lời kích động thù ghét, lời miệt thị, hạ thấp một nhóm người. " +
      "(e) lời bài hát chứa quá nhiều lời tục nặng.",

    strict
      ? "QUY TẮC 2 — TIÊU CHUẨN CHẾ ĐỘ NGHIÊM NGẶT: chỉ chấp thuận âm nhạc rõ ràng an toàn cho gia đình, bất kể " +
        "địa điểm. TUYỆT ĐỐI KHÔNG có lời tục — ngay cả một vài từ chửi thông thường trong lời bài hát cũng phải từ chối " +
        "(ví dụ 'Stay' của The Kid LAROI & Justin Bieber là TỪ CHỐI trong chế độ nghiêm ngặt). Đồng thời từ chối " +
        "nội dung tình dục, bạo lực hoặc nội dung người lớn khác. Nhạc pop trong sáng, bài hát tình yêu và nhạc nhảy " +
        "thông thường được chấp thuận — độ nghiêm ngặt phụ thuộc vào nội dung, không phải thể loại. Khi thực sự không chắc " +
        "bài hát có an toàn cho gia đình hay không, hãy từ chối."
      : "QUY TẮC 2 — TIÊU CHUẨN SỰ KIỆN: hãy để tính chất của sự kiện quyết định ngưỡng — điều phù hợp với hộp đêm " +
        "có thể khác với bữa tiệc tối ở trường. Hãy từ chối những gì một host hợp lý của sự kiện NÀY sẽ không chấp nhận " +
        "(ví dụ bài hát có nội dung tình dục rõ ràng tại sự kiện trường học hoặc gia đình). Một chút lời tục thông thường trong " +
        "một bài hát phổ biến nhìn chung lành mạnh vẫn được chấp nhận (ví dụ 'Stay' của The Kid LAROI & Justin Bieber " +
        "được CHẤP THUẬN ở đây). Tại địa điểm dành cho người lớn (hộp đêm, quán bar, tiệc người lớn), nhạc phổ biến " +
        "có lời rõ ràng hoặc chủ đề gợi dục ĐƯỢC chấp nhận — isFamilySafe=false của YouTube tự nó KHÔNG phải là lý do để từ chối. " +
        "Khi không chắc về một bài pop/tiệc/tình yêu thông thường, hãy chấp thuận.",

    "QUY TẮC 3 — NHẠC TÔN GIÁO: thánh ca, nhạc ca ngợi & thờ phượng và các tác phẩm nghi lễ tôn giáo không " +
      "phù hợp với hàng đợi tiệc — hãy từ chối, trừ khi sự kiện được mô tả ở trên chính là một dịp tôn giáo.",

    "QUY TẮC 4 — BẢN TRONG SẠCH: nếu tiêu đề cho biết video là bản trong sạch/đã kiểm duyệt ('clean', " +
      "'clean version', 'radio edit'), hãy đánh giá bản ĐÓ, không phải bản gốc — lời tục và lời miệt thị " +
      "đã được che tiếng. Chấp thuận bản trong sạch của các bài hát phổ biến ngay cả trong chế độ nghiêm ngặt; chỉ từ chối " +
      "khi bài hát vẫn rõ ràng không phù hợp vì chủ đề cốt lõi vẫn mô tả tình dục hoặc bạo lực quá trực diện. Bản trong sạch " +
      "không bao giờ cứu được bài hát thuộc quy tắc 1.",

    // Quy tắc của host: bài hát không thể kiểm tra lời thì không được phát. Quy tắc này
    // cố ý ghi đè xu hướng chấp thuận khi không chắc ở quy tắc 2.
    webSearch
      ? "QUY TẮC 5 — có thể đính kèm KẾT QUẢ TÌM KIẾM WEB về bài hát. Hãy dùng chúng để đánh giá nội dung và ý nghĩa " +
        "THỰC TẾ của lời bài hát, không chỉ tiêu đề; bỏ qua kết quả nói về bài hát khác. Tiêu đề nghe có vẻ trong sáng nhưng " +
        "lời không phù hợp thì phải từ chối (trừ khi đó là bản trong sạch, quy tắc 4). Nếu hoàn toàn không thể xác định nội dung " +
        "lời bài hát thực tế — kết quả tìm kiếm KHÔNG có lời bài hát VÀ bạn cũng không biết chắc bài hát — hãy TỪ CHỐI: " +
        "không được phát lời bài hát không thể kiểm chứng, ngay cả khi tiêu đề có vẻ vô hại. Quy tắc này ghi đè xu hướng " +
        "khi không chắc ở quy tắc 2. Các bản nhạc hoàn toàn không lời được miễn kiểm tra lời (nhưng không được miễn quy tắc 1)."
      : null,

    'ĐẦU RA: chỉ trả về JSON theo dạng {"approved": boolean, "reason": string}. ' +
      "reason được hiển thị cho khách yêu cầu bài hát: viết bằng tiếng Việt, ngắn gọn và thân thiện, không chứa URL hoặc trích dẫn.",
  ];

  const policy = rules.filter(Boolean).join("\n\n");

  const ctx = [
    // Web plugin lấy truy vấn tìm kiếm từ message này (không có field query riêng),
    // nên khi bật tìm kiếm, đặt một dòng giống truy vấn lời bài hát ở đầu để hướng
    // plugin tới trang lời bài hát thay vì trang đánh giá/video.
    // "歌詞" giúp tìm các trang lời tiếng Hoa cho yêu cầu Cantopop/Mandopop.
    webSearch ? `Tìm lời bài hát này: ${song.title} lyrics 歌詞` : null,
    `Tiêu đề: ${song.title}`,
    `Kênh: ${song.channel || details?.author || "không rõ"}`,
    details?.category ? `Danh mục YouTube: ${details.category}` : null,
    details?.isFamilySafe !== undefined ? `Cờ isFamilySafe của YouTube: ${details.isFamilySafe}` : null,
    details?.description ? `Mô tả (đã rút gọn): ${details.description}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return [
    { role: "system", content: policy },
    { role: "user", content: ctx },
  ];
}

// Trích xuất object JSON {...} cân bằng tương đối đầu tiên trong câu trả lời LLM,
// cho phép có markdown fence và phần văn bản bao quanh.
function extractJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

const APPROVED = { approved: true, reason: "Đã thêm!", moderated: false };

export async function moderate(song, details = null, opts = {}) {
  const c = config(opts);
  if (!c.apiKey) return APPROVED;

  const body = { model: c.model, messages: buildMessages(song, details, c) };
  if (c.temperature !== undefined) body.temperature = Number(c.temperature);
  // Web plugin của OpenRouter: tìm kiếm bài hát trên web (user message là nguồn
  // truy vấn) rồi chèn kết quả — thường là trang lời bài hát — trước khi model
  // trả lời. https://openrouter.ai/docs/guides/features/plugins/web-search
  if (c.webSearch) body.plugins = [{ id: "web", max_results: 5 }];

  // Vòng tìm kiếm cần thêm thời gian: model thường trả lời trong 6-14 giây khi
  // bật tìm kiếm, nhưng có thể suy xét lâu hơn nhiều với các bài nhạy cảm.
  const timeoutMs = c.timeoutMs ?? (c.webSearch ? 35000 : 8000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${c.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.warn(`[moderation] HTTP ${res.status} — cho phép khi lỗi. ${t.slice(0, 200)}`);
      return APPROVED;
    }
    const data = await res.json();
    const choice = data?.choices?.[0];
    const text = choice?.message?.content || "";
    // Ghi lại citation của web plugin để log máy chủ cho biết mỗi phán quyết
    // thực sự dựa trên trang nào (tốt nhất là các trang lời bài hát).
    const sources = (choice?.message?.annotations || [])
      .map((a) => a?.url_citation?.url)
      .filter(Boolean);
    if (sources.length) {
      console.log(`[moderation] "${song.title}" nguồn web: ${sources.slice(0, 5).join(" ")}`);
    }
    // Nếu lớp an toàn của provider tự che câu trả lời (finish_reason
    // "content_filter"), chủ đề quá nhạy cảm để model
    // thảo luận — ví dụ bài phản kháng bị cấm với model do Trung Quốc lưu trữ.
    // Đây là TỪ CHỐI, không phải lỗi nhất thời: fail-closed ở đây, khác với lỗi mạng.
    if (choice?.finish_reason === "content_filter") {
      console.warn(`[moderation] provider content_filter — từ chối. ${text.slice(0, 150)}`);
      return { approved: false, reason: "Bài hát này không phù hợp với dịp này.", moderated: true };
    }
    // Không có phán quyết có cấu trúc (văn bản từ chối, JSON thiếu/không hợp lệ):
    // model đã né câu hỏi — từ chối. Chỉ lỗi hạ tầng mới fail-open.
    const parsed = extractJson(text);
    if (!parsed || typeof parsed.approved !== "boolean") {
      console.warn(`[moderation] không có phán quyết có cấu trúc — từ chối. ${text.slice(0, 150)}`);
      return { approved: false, reason: "Bài hát này không phù hợp với dịp này.", moderated: true };
    }
    // Web plugin có thể khiến model thêm link citation markdown ("[youtube.com](https://…)");
    // reason được hiển thị nguyên văn cho khách nên cần loại bỏ chúng.
    const reason = String(parsed.reason || (parsed.approved ? "Đã thêm!" : "Bài hát này không phù hợp với dịp này."))
      .replace(/\s*\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\s*\b(?:see|source|sources|xem(?:\s+(?:nguồn|nguon))?|nguồn|nguon)\s*[:.]?\s*$/iu, "") // phần còn lại sau khi bỏ citation cuối dòng
      .trim();
    return {
      approved: parsed.approved,
      reason: reason || (parsed.approved ? "Đã thêm!" : "Bài hát này không phù hợp với dịp này."),
      moderated: true,
    };
  } catch (err) {
    // Hết thời gian chờ là fail-CLOSED với thông báo cho phép thử lại: các phán
    // quyết chậm thường tập trung ở đúng những bài hát cần bộ lọc (từng có bài
    // phản kháng bị cấm lọt qua theo cách này), nên không được phát bài đã hết
    // thời gian chờ mà chưa kiểm duyệt. Khách chỉ cần chạm lại; nếu provider
    // thực sự ngừng hoạt động, host có thể tắt bộ lọc trực tiếp. Lỗi mạng bên
    // dưới vẫn fail-open.
    if (err?.name === "AbortError") {
      console.warn(`[moderation] hết thời gian chờ sau ${timeoutMs}ms — từ chối (khách có thể thử lại).`);
      return { approved: false, reason: "Hệ thống đang bận, vui lòng thử lại.", moderated: false };
    }
    console.warn(`[moderation] lỗi — cho phép khi lỗi. ${err?.message || ""}`);
    return APPROVED;
  } finally {
    clearTimeout(timer);
  }
}
