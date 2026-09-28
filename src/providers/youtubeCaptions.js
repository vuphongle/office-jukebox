// Provider for fetching creator-uploaded (human) YouTube captions
// Excludes auto-generated ASR captions and enforces original language matching.

const INNERTUBE_API_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const INNERTUBE_CLIENT_VERSION = "20.10.38";
const INNERTUBE_USER_AGENT = `com.google.android.youtube/${INNERTUBE_CLIENT_VERSION} (Linux; U; Android 14)`;

// SSRF protection: only allow fetching from these YouTube-controlled domains
const ALLOWED_CAPTION_HOSTS = new Set([
  "www.youtube.com",
  "youtube.com",
  "googlevideo.com",
  "ytimg.com",
]);

// Valid YouTube video IDs: 11 chars, alphanumeric + hyphen + underscore
const YT_VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;

export function detectOriginalLanguage(title = "", artist = "") {
  const text = `${title} ${artist}`;

  // Vietnamese with diacritics
  if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(text)) {
    return "vi";
  }

  // Korean Hangul
  if (/[\uac00-\ud7af\u1100-\u11ff]/.test(text)) {
    return "ko";
  }

  // Japanese Hiragana & Katakana
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(text)) {
    return "ja";
  }

  // Chinese Hanzi
  if (/[\u4e00-\u9fff]/.test(text)) {
    return "zh";
  }

  // Default to English / Latin
  return "en";
}

export function selectOriginalCreatorTrack(captionTracks, originalLang) {
  if (!Array.isArray(captionTracks) || captionTracks.length === 0) {
    return null;
  }

  // 1. Strictly filter to creator-uploaded tracks:
  // - No kind: "asr" (Auto Speech Recognition)
  // - No vssId starting with "a." (auto-generated)
  // - No translation markers
  const creatorTracks = captionTracks.filter((t) => {
    if (!t || typeof t !== "object") return false;
    if (t.kind === "asr") return false;
    if (typeof t.vssId === "string" && t.vssId.startsWith("a.")) return false;
    if (typeof t.vssId === "string" && t.vssId.includes(".translate")) return false;
    return t.baseUrl === undefined || Boolean(t.baseUrl);
  });

  if (creatorTracks.length === 0) {
    return null;
  }

  const targetLang = (originalLang || "en").toLowerCase();

  // 2. Find track exactly matching the detected original language
  const exactMatch = creatorTracks.find((t) => {
    const code = (t.languageCode || "").toLowerCase();
    const vss = (t.vssId || "").toLowerCase();
    return code === targetLang || vss === `.${targetLang}` || vss.startsWith(`.${targetLang}.`);
  });

  if (exactMatch) {
    return exactMatch;
  }

  // 3. Prefix match for regional variants (e.g. "zh-Hans" -> "zh", "en-US" -> "en")
  const prefixMatch = creatorTracks.find((t) => {
    const code = (t.languageCode || "").toLowerCase();
    return code.startsWith(targetLang);
  });

  if (prefixMatch) {
    return prefixMatch;
  }

  // If the original language was detected as a specific non-English language (e.g. Vietnamese, Korean, Japanese)
  // and no creator track exists for that language, do NOT return an English translated track!
  // Return null so the pipeline falls back to LRCLIB / Zing MP3 in the native language.
  if (targetLang !== "en") {
    return null;
  }

  // For English songs, if no exact "en" track found, check the first creator track
  return creatorTracks[0] || null;
}

const HTML_ENTITY_MAP = {
  "&amp;": "&",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": " ",
  "&ndash;": "–",
  "&mdash;": "—",
  "&hellip;": "…",
  "&lsquo;": "‘",
  "&rsquo;": "’",
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&bull;": "•",
  "&copy;": "©",
  "&trade;": "™",
  "&reg;": "®",
};

export function decodeHtmlEntities(str = "") {
  if (typeof str !== "string") return "";
  return str
    .replace(/&(?:amp|quot|apos|#39|lt|gt|nbsp|ndash|mdash|hellip|lsquo|rsquo|ldquo|rdquo|bull|copy|trade|reg);/gi, (m) => HTML_ENTITY_MAP[m.toLowerCase()] || m)
    .replace(/&#(\d+);/g, (_, code) => {
      const n = parseInt(code, 10);
      return Number.isFinite(n) && n > 0 ? String.fromCharCode(n) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const n = parseInt(hex, 16);
      return Number.isFinite(n) && n > 0 ? String.fromCharCode(n) : "";
    });
}

export function parseYouTubeTimedText(xmlText) {
  if (typeof xmlText !== "string" || !xmlText.trim()) return [];

  const lines = [];
  // Match both <p t="ms" d="ms">text</p> and <text start="s" dur="s">text</text>
  const pRegex = /<p\s+[^>]*?t="(\d+)"(?:[^>]*?d="(\d+)")?[^>]*>(.*?)<\/p>/gis;
  const textRegex = /<text\s+[^>]*?start="([\d.]+)"(?:[^>]*?dur="([\d.]+)")?[^>]*>(.*?)<\/text>/gis;

  let match;
  while ((match = pRegex.exec(xmlText)) !== null) {
    const timeMs = parseInt(match[1], 10);
    const rawText = match[3];
    const text = cleanCaptionText(rawText);
    if (text) {
      lines.push({ time: Math.max(0, timeMs / 1000), text });
    }
  }

  if (lines.length === 0) {
    while ((match = textRegex.exec(xmlText)) !== null) {
      const timeSec = parseFloat(match[1]);
      const rawText = match[3];
      const text = cleanCaptionText(rawText);
      if (text && Number.isFinite(timeSec)) {
        lines.push({ time: Math.max(0, timeSec), text });
      }
    }
  }

  return lines.sort((a, b) => a.time - b.time);
}

function cleanCaptionText(raw) {
  if (typeof raw !== "string" || !raw.trim()) return "";
  // 1. Replace line break tags with space
  let text = raw.replace(/<br\s*\/?>/gi, " ");
  // 2. Remove XML/HTML tags (like <font ...>, <s>, <span>, etc.) BEFORE decoding entities
  // to avoid accidentally stripping emoticons like <3
  text = text.replace(/<[^>]+>/g, "");
  // 3. Decode HTML entities so creator special characters (♪, quotes, <3, etc.) are properly restored
  text = decodeHtmlEntities(text);
  // 4. Normalize whitespace (collapse tabs/multiple spaces into single space)
  // Strictly preserve all creator-authored special characters (♪, ♫, #, quotes, punctuation, brackets, emoticons)
  text = text.replace(/[ \t\f\v]+/g, " ").trim();

  return text;
}

/**
 * Returns true if a URL's hostname is in the YouTube-controlled domain allow-list.
 * Used to prevent SSRF when the player API returns a baseUrl that could point to
 * an attacker-controlled server.
 * @param {string} rawUrl
 */
function isAllowedCaptionUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("https://")) return false;
  try {
    const { hostname } = new URL(rawUrl);
    // Accept exact match or any subdomain of an allowed host
    return [...ALLOWED_CAPTION_HOSTS].some(
      (h) => hostname === h || hostname.endsWith(`.${h}`)
    );
  } catch {
    return false;
  }
}

export async function fetchYouTubeCreatorCaptions(
  videoId,
  { title = "", artist = "", fetchImpl = globalThis.fetch, timeoutMs = 3500 } = {}
) {
  if (!videoId || typeof videoId !== "string" || !YT_VIDEO_ID_RE.test(videoId.trim())) {
    return { ok: false, error: "invalid_video_id" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const playerRes = await fetchImpl(INNERTUBE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": INNERTUBE_USER_AGENT,
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: INNERTUBE_CLIENT_VERSION,
          },
        },
      }),
      signal: controller.signal,
    });

    if (!playerRes.ok) {
      return { ok: false, error: "player_api_error" };
    }

    const playerData = await playerRes.json();
    const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (!Array.isArray(tracks) || tracks.length === 0) {
      return { ok: false, error: "no_creator_captions" };
    }

    const ytTitle = playerData?.videoDetails?.title || "";
    const ytAuthor = playerData?.videoDetails?.author || "";
    let originalLang = detectOriginalLanguage(title, artist);
    if (originalLang === "en" && (ytTitle || ytAuthor)) {
      const fallbackLang = detectOriginalLanguage(ytTitle, ytAuthor);
      if (fallbackLang !== "en") {
        originalLang = fallbackLang;
      }
    }
    const selectedTrack = selectOriginalCreatorTrack(tracks, originalLang);

    if (!selectedTrack || !selectedTrack.baseUrl) {
      return { ok: false, error: "no_creator_captions" };
    }

    // SSRF guard: reject caption URLs that don't point to YouTube's own infrastructure
    if (!isAllowedCaptionUrl(selectedTrack.baseUrl)) {
      return { ok: false, error: "invalid_caption_url" };
    }

    // Fetch the timedtext XML from the baseUrl
    const captionRes = await fetchImpl(selectedTrack.baseUrl, {
      headers: { "User-Agent": INNERTUBE_USER_AGENT },
      signal: controller.signal,
    });

    if (!captionRes.ok) {
      return { ok: false, error: "caption_download_failed" };
    }

    const xml = await captionRes.text();
    const lines = parseYouTubeTimedText(xml);

    if (lines.length === 0) {
      return { ok: false, error: "empty_captions" };
    }

    return {
      ok: true,
      synced: true,
      source: "youtube_captions",
      language: selectedTrack.languageCode || originalLang,
      lines,
    };
  } catch (err) {
    return {
      ok: false,
      error: err.name === "AbortError" ? "timeout" : "network_error",
    };
  } finally {
    clearTimeout(timer);
  }
}
