// Xác minh nhà cung cấp kiểm duyệt LLM (mặc định là Kimi) và chạy bài kiểm tra
// kiểm duyệt nhanh. Chạy bằng: bun run check-llm
//
// Đọc LLM_API_KEY / LLM_BASE_URL / LLM_MODEL từ .env.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { moderate } from "../src/moderation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const key = process.env.LLM_API_KEY;
const baseUrl = (process.env.LLM_BASE_URL || "https://api.moonshot.ai/v1").replace(/\/+$/, "");
const model = process.env.LLM_MODEL || "kimi-k2.6";

if (!key) {
  console.error("Không có LLM_API_KEY trong .env — kiểm duyệt sẽ chấp thuận mọi thứ dù bộ lọc đang BẬT.");
  process.exit(1);
}

console.log(`URL cơ sở provider: ${baseUrl}`);
console.log(`Model:              ${model}\n`);

// Phần lớn nhà cung cấp tương thích OpenAI có GET /v1/models.
try {
  const res = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (res.ok) {
    const { data = [] } = await res.json();
    console.log("Các model khả dụng:");
    for (const m of data) console.log("  -", m.id);
    console.log();
  } else {
    console.log(`(GET /models trả về ${res.status} — provider có thể không hỗ trợ liệt kê; tiếp tục.)\n`);
  }
} catch (e) {
  console.log(`(Không thể liệt kê model: ${e.message}; tiếp tục.)\n`);
}

console.log("Kiểm tra kiểm duyệt (chỉ tiêu đề + kênh):");
for (const song of [
  { title: "BTS (방탄소년단) 'Dynamite' Official MV", channel: "HYBE LABELS" },
  { title: "How to file your taxes 2024 — full tutorial", channel: "TaxTips" },
  { title: "God Save the King — British National Anthem", channel: "Royal Anthems" },
  // Các model do Trung Quốc lưu trữ từ chối thẳng chủ đề này (finish_reason
  // content_filter) — phải trả về 🚫 qua nhánh fail-closed.
  { title: "香港國歌《願榮光歸香港》管弦樂團及合唱團版 Hong Kong National Anthem", channel: "Malechan Chen" },
]) {
  const v = await moderate(song);
  console.log(`  ${v.approved ? "✅" : "🚫"}  ${song.title}  →  ${v.reason}`);
}
