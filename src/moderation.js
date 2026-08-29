// Moderate songs with an LLM through any OpenAI-compatible chat API.
//
// The default provider is Kimi (Moonshot). Switch to DeepSeek, GLM, or another
// provider by changing LLM_BASE_URL, LLM_MODEL, and LLM_API_KEY in .env.
//
// Design notes:
//  - Do not depend on response_format: json_object because provider support
//    differs. Instead, request JSON in the prompt and extract the first object.
//  - Do not set temperature (kimi-k2.x rejects arbitrary values); use the API
//    default unless LLM_TEMPERATURE is explicitly configured.
//  - FAIL-OPEN only for infrastructure failures (missing key, HTTP error, or
//    network error); moderation must never stop the party or throw in the request flow.
//  - FAIL-CLOSED on timeout with a retryable reason. Slow decisions often cluster
//    around songs that need filtering, so a timed-out song must not play unchecked.
//  - FAIL-CLOSED when the model responds without a verdict. A provider
//    content_filter or invalid/missing {"approved": ...} JSON means evasion.
//  - LLM_WEB_SEARCH=true (OpenRouter only) enables its web plugin so the model can
//    inspect live results, often actual lyrics, instead of relying only on titles.
//    It costs about $0.005 per moderated request plus tokens; other providers may
//    reject the extra field, so the feature must remain opt-in.

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
    temperature: opts.temperature ?? process.env.LLM_TEMPERATURE, // undefined = use the API default
    webSearch: opts.webSearch ?? (process.env.LLM_WEB_SEARCH || "").toLowerCase() === "true",
    timeoutMs: opts.timeoutMs, // handled below; web search needs more time
  };
}

export function moderationConfigured() {
  return !!(process.env.LLM_API_KEY);
}

function buildMessages(song, details, { strict, eventContext, webSearch }) {
  // Build the prompt in DECISION ORDER: the immediate rejection rule first (rule
  // 1 cannot be overridden), then the mode standard, contextual rules, and the
  // output format. Anthems are explicit in rule 1 because models often infer
  // "patriotic = family-safe = approved". The Beyond exception is intentional:
  // a classic song with incidental political associations is not a political
  // song. 'Stay' calibrates both branches with opposite decisions; only one
  // branch is sent at a time to define the strict/default threshold precisely.
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

    // Host rule: a song whose lyrics cannot be checked must not play. This
    // intentionally overrides the uncertainty-approval tendency in rule 2.
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
    // The web plugin takes its search query from this message (there is no
    // separate query field). When search is enabled, put a lyrics-like query
    // first so it targets lyric pages rather than reviews or video pages.
    // The "歌詞" token helps find Chinese-language lyric pages for Cantopop/Mandopop.
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

// Extract the first roughly balanced JSON object from the LLM response, allowing
// Markdown fences and surrounding prose.
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
  // OpenRouter web plugin: search the web for the song (the user message is the
  // query source) and inject results, usually lyric pages, before the response.
  // https://openrouter.ai/docs/guides/features/plugins/web-search
  if (c.webSearch) body.plugins = [{ id: "web", max_results: 5 }];

  // Web search needs more time: models often answer in 6–14 seconds with search
  // enabled, but sensitive songs can take considerably longer.
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
      console.warn(`[moderation] HTTP ${res.status} — allowing on infrastructure failure. ${t.slice(0, 200)}`);
      return APPROVED;
    }
    const data = await res.json();
    const choice = data?.choices?.[0];
    const text = choice?.message?.content || "";
    // Record web-plugin citations so server logs show which pages informed each
    // verdict, preferably lyric pages.
    const sources = (choice?.message?.annotations || [])
      .map((a) => a?.url_citation?.url)
      .filter(Boolean);
    if (sources.length) {
      console.log(`[moderation] "${song.title}" web sources: ${sources.slice(0, 5).join(" ")}`);
    }
    // If the provider safety layer masks the response (finish_reason
    // "content_filter"), the topic is too sensitive for the model to discuss.
    // This is a rejection, not a transient failure: fail-closed here, unlike a
    // network error.
    if (choice?.finish_reason === "content_filter") {
      console.warn(`[moderation] provider content_filter — rejecting. ${text.slice(0, 150)}`);
      return { approved: false, reason: "Bài hát này không phù hợp với dịp này.", moderated: true };
    }
    // No structured verdict (a refusal, missing JSON, or invalid JSON) means the
    // model avoided the question and must be rejected. Only infrastructure
    // failures fail open.
    const parsed = extractJson(text);
    if (!parsed || typeof parsed.approved !== "boolean") {
      console.warn(`[moderation] no structured verdict — rejecting. ${text.slice(0, 150)}`);
      return { approved: false, reason: "Bài hát này không phù hợp với dịp này.", moderated: true };
    }
    // The web plugin can make the model add Markdown citation links
    // ("[youtube.com](https://…)"). The reason is shown verbatim to guests, so
    // remove those links.
    const reason = String(parsed.reason || (parsed.approved ? "Đã thêm!" : "Bài hát này không phù hợp với dịp này."))
      .replace(/\s*\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\s*\b(?:see|source|sources|xem(?:\s+(?:nguồn|nguon))?|nguồn|nguon)\s*[:.]?\s*$/iu, "") // trailing text after removing a final citation
      .trim();
    return {
      approved: parsed.approved,
      reason: reason || (parsed.approved ? "Đã thêm!" : "Bài hát này không phù hợp với dịp này."),
      moderated: true,
    };
  } catch (err) {
    // A timeout is fail-CLOSED with a retryable message: slow decisions often
    // cluster around songs that need filtering, so a timed-out song must not play
    // unchecked. Guests can tap again; if the provider is actually down, the host
    // can disable the filter directly. Lower-level network failures still fail open.
    if (err?.name === "AbortError") {
      console.warn(`[moderation] timed out after ${timeoutMs}ms — rejecting (guest can retry).`);
      return { approved: false, reason: "Hệ thống đang bận, vui lòng thử lại.", moderated: false };
    }
    console.warn(`[moderation] error — allowing on infrastructure failure. ${err?.message || ""}`);
    return APPROVED;
  } finally {
    clearTimeout(timer);
  }
}
