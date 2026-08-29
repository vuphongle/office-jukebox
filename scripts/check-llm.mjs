// Verify the LLM moderation provider (Kimi by default) and run a quick
// moderation check. Run with: bun run check-llm
//
// Reads LLM_API_KEY, LLM_BASE_URL, and LLM_MODEL from .env.

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
  console.error("LLM_API_KEY is missing from .env — moderation will approve everything even when the filter is enabled.");
  process.exit(1);
}

console.log(`Provider base URL: ${baseUrl}`);
console.log(`Model:              ${model}\n`);

// Most OpenAI-compatible providers expose GET /v1/models.
try {
  const res = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (res.ok) {
    const { data = [] } = await res.json();
    console.log("Available models:");
    for (const m of data) console.log("  -", m.id);
    console.log();
  } else {
    console.log(`(GET /models returned ${res.status} — the provider may not support listing; continuing.)\n`);
  }
} catch (e) {
  console.log(`(Could not list models: ${e.message}; continuing.)\n`);
}

console.log("Moderation check (title and channel only):");
for (const song of [
  { title: "BTS (방탄소년단) 'Dynamite' Official MV", channel: "HYBE LABELS" },
  { title: "How to file your taxes 2024 — full tutorial", channel: "TaxTips" },
  { title: "God Save the King — British National Anthem", channel: "Royal Anthems" },
  // Some China-hosted models reject this topic directly (finish_reason
  // content_filter); it should return 🚫 through the fail-closed branch.
  { title: "香港國歌《願榮光歸香港》管弦樂團及合唱團版 Hong Kong National Anthem", channel: "Malechan Chen" },
]) {
  const v = await moderate(song);
  console.log(`  ${v.approved ? "✅" : "🚫"}  ${song.title}  →  ${v.reason}`);
}
