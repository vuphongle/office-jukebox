// Single source of truth for resolving YouTube creator-uploaded captions.
// Enforces creator-only captions matching the song's original language,
// with content verification, quality thresholds, and unified probing.

const INNERTUBE_API_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const INNERTUBE_CLIENT_VERSION = "20.10.38";
const INNERTUBE_USER_AGENT = `com.google.android.youtube/${INNERTUBE_CLIENT_VERSION} (Linux; U; Android 14)`;
const WEB_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const ALLOWED_CAPTION_HOSTS = new Set([
  "www.youtube.com",
  "youtube.com",
  "googlevideo.com",
  "ytimg.com",
]);

const YT_VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;
export const CC_MIN_CHAR_TOTAL = 120;
export const CC_MIN_LINES = 6;

// In-memory cache for resolved captions & probe results
// videoId -> { expiresAt, fullResult, hasCcLyrics }
const resolverCache = new Map();
const RESOLVER_CACHE_TTL_MS = 30 * 60 * 1000; // 30 mins
const RESOLVER_CACHE_MAX = 500;

export function clearResolverCaches() {
  resolverCache.clear();
}

export function isAllowedCaptionUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("https://")) return false;
  try {
    const { hostname } = new URL(rawUrl);
    return [...ALLOWED_CAPTION_HOSTS].some(
      (h) => hostname === h || hostname.endsWith(`.${h}`)
    );
  } catch {
    return false;
  }
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

function cleanCaptionText(raw) {
  if (typeof raw !== "string" || !raw.trim()) return "";
  let text = raw.replace(/<br\s*\/?>/gi, " ");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeHtmlEntities(text);
  text = text.replace(/[ \t\f\v]+/g, " ").trim();
  return text;
}

export function parseYouTubeTimedText(xmlText) {
  if (typeof xmlText !== "string" || !xmlText.trim()) return [];

  const rawLines = [];
  const pRegex = /<p\s+[^>]*?t="(\d+)"(?:[^>]*?d="(\d+)")?[^>]*>(.*?)<\/p>/gis;
  const textRegex = /<text\s+[^>]*?start="([\d.]+)"(?:[^>]*?dur="([\d.]+)")?[^>]*>(.*?)<\/text>/gis;

  let match;
  while ((match = pRegex.exec(xmlText)) !== null) {
    const timeMs = parseInt(match[1], 10);
    const rawText = match[3];
    const text = cleanCaptionText(rawText);
    if (text) {
      rawLines.push({ time: Math.max(0, timeMs / 1000), text });
    }
  }

  if (rawLines.length === 0) {
    while ((match = textRegex.exec(xmlText)) !== null) {
      const timeSec = parseFloat(match[1]);
      const rawText = match[3];
      const text = cleanCaptionText(rawText);
      if (text && Number.isFinite(timeSec)) {
        rawLines.push({ time: Math.max(0, timeSec), text });
      }
    }
  }

  return rawLines.sort((a, b) => a.time - b.time);
}

export function cleanAndFilterLyricsLines(rawLines) {
  if (!Array.isArray(rawLines)) return [];
  // Filter out pure noise / sound effect markers
  const filtered = rawLines.filter((l) => {
    const t = (l?.text || "").trim();
    if (!t) return false;
    // Pure bracket notation e.g. [Music], [Âm nhạc], (Music), ♪, ♫
    if (/^[\[(]?(?:music|\u00e2m nh\u1ea1c|applause|cheering|ti\u1ebfng v\u1ed7 tay)[\])]?$/i.test(t)) return false;
    if (/^[♪♫♬♩\s\-_.]+$/.test(t)) return false;
    return true;
  });

  // Drop credit lines at the very end (last 1-2 lines)
  while (filtered.length > 0) {
    const last = filtered[filtered.length - 1].text.toLowerCase();
    if (
      /\b(?:subtitles by|ph\u1ee5 \u0111\u1ec1 b\u1edfi|vietsub by|trans by|translated by|synced by)\b/i.test(last) ||
      /\b(?:c\u1ea3m \u01a1n \u0111\u00e3 xem|thanks for watching|like \u0026 subscribe)\b/i.test(last)
    ) {
      filtered.pop();
    } else {
      break;
    }
  }

  return filtered;
}

export function getTrackNameString(track) {
  if (!track) return "";
  if (typeof track.name === "string") return track.name;
  if (track.name?.simpleText) return track.name.simpleText;
  if (Array.isArray(track.name?.runs) && track.name.runs[0]?.text) {
    return track.name.runs.map((r) => r.text || "").join("");
  }
  return "";
}

/**
 * Filter out auto-generated captions, translated captions, and romanized tracks.
 */
export function filterCreatorTracks(captionTracks) {
  if (!Array.isArray(captionTracks) || captionTracks.length === 0) {
    return [];
  }

  return captionTracks.filter((t) => {
    if (!t || typeof t !== "object") return false;
    if (t.kind === "asr") return false;
    if (typeof t.vssId === "string" && t.vssId.startsWith("a.")) return false;
    if (typeof t.vssId === "string" && t.vssId.includes(".translate")) return false;

    // Check baseUrl
    if (typeof t.baseUrl === "string") {
      if (t.baseUrl.includes("tlang=")) return false;
      if (!isAllowedCaptionUrl(t.baseUrl)) return false;
    } else {
      return false;
    }

    const langCode = (t.languageCode || "").toLowerCase();
    if (langCode.endsWith("-latn") || langCode.includes("-latn")) return false;

    const trackName = getTrackNameString(t).toLowerCase();
    if (/\b(?:romaji|romanized|romanization|phi\u00ean \u00e2m)\b/i.test(trackName)) {
      return false;
    }

    return true;
  });
}

export function scoreScriptCharacters(text = "") {
  let kana = 0;
  let hangul = 0;
  let thai = 0;
  let hanzi = 0;
  let viDiacritics = 0;

  for (const ch of text) {
    if (/[\u3040-\u309f\u30a0-\u30ff]/.test(ch)) kana++;
    else if (/[\uac00-\ud7af\u1100-\u11ff]/.test(ch)) hangul++;
    else if (/[\u0e00-\u0e7f]/.test(ch)) thai++;
    else if (/[\u4e00-\u9fff]/.test(ch)) hanzi++;
    else if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(ch)) viDiacritics++;
  }

  return { kana, hangul, thai, hanzi, viDiacritics };
}

export function resolveDominantLanguage(counts, minThreshold = 1) {
  const candidates = [
    { lang: "ja", count: counts.kana > 0 ? counts.kana + counts.hanzi : 0 },
    { lang: "ko", count: counts.hangul },
    { lang: "vi", count: counts.viDiacritics },
    { lang: "th", count: counts.thai },
    { lang: "zh", count: counts.kana === 0 ? counts.hanzi : 0 },
  ];

  candidates.sort((a, b) => b.count - a.count);
  if (candidates[0].count >= minThreshold) {
    return candidates[0].lang;
  }
  return null;
}

/**
 * Detect the song's original language using metadata and heuristics.
 */
export function detectSongLanguage({
  title = "",
  artist = "",
  videoDetails = null,
  audioTracks = [],
  creatorTracks = [],
} = {}) {
  // 1. Audio tracks metadata if available
  if (Array.isArray(audioTracks) && audioTracks.length > 0) {
    const defaultAudio = audioTracks.find((a) => a?.audioIsDefault) || audioTracks[0];
    const audioId = (defaultAudio?.id || "").toLowerCase();
    if (audioId.startsWith("vi")) return "vi";
    if (audioId.startsWith("ko")) return "ko";
    if (audioId.startsWith("ja")) return "ja";
    if (audioId.startsWith("zh")) return "zh";
    if (audioId.startsWith("th")) return "th";
    if (audioId.startsWith("en")) return "en";

    if (Number.isInteger(defaultAudio?.defaultCaptionTrackIndex)) {
      const defTrack = creatorTracks[defaultAudio.defaultCaptionTrackIndex];
      if (defTrack?.languageCode) {
        const c = defTrack.languageCode.split("-")[0].toLowerCase();
        if (["vi", "ko", "ja", "zh", "th", "en"].includes(c)) return c;
      }
    }
  }

  const descSnippet = typeof videoDetails?.shortDescription === "string"
    ? videoDetails.shortDescription.slice(0, 300)
    : "";
  const keywordsStr = Array.isArray(videoDetails?.keywords)
    ? videoDetails.keywords.join(" ")
    : "";
  const ytTitle = videoDetails?.title || "";
  const ytAuthor = videoDetails?.author || "";

  // 2. Primary text: Title, Artist, Video Title, Channel Author
  const primaryText = `${title} ${artist} ${ytTitle} ${ytAuthor}`.trim();
  const primaryLang = resolveDominantLanguage(scoreScriptCharacters(primaryText), 1);
  if (primaryLang) {
    return primaryLang;
  }

  // 3. Secondary metadata: Keywords and Description snippet (dominant script count)
  const secondaryText = `${keywordsStr} ${descSnippet}`.trim();
  const secondaryLang = resolveDominantLanguage(scoreScriptCharacters(secondaryText), 3);
  if (secondaryLang) {
    return secondaryLang;
  }

  // 4. Unaccented Vietnamese heuristic when context strongly suggests Vietnamese song
  const vietnameseKeywords = /\b(anh|em|yeu|nguoi|khong|mot|minh|cho|ngay|chieu|dem|nang|mua|thuong|nho|ve|tim|con|duong)\b/i;
  const vietnameseContext = `${ytAuthor} ${descSnippet} ${keywordsStr}`.toLowerCase();
  const hasVietnameseContext =
    /(\bv-pop|\bvpop|nh\u1ea1c|ca s\u0129|s\u01a1n t\u00f9ng|vietnam|vi\u1ec7t nam)\b/i.test(vietnameseContext) ||
    /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(vietnameseContext);

  if (hasVietnameseContext && vietnameseKeywords.test(`${title} ${artist}`)) {
    return "vi";
  }

  return null;
}

/**
 * Detect language of caption text lines by character distribution.
 */
export function detectTextLanguage(lines = []) {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const sampleText = lines.slice(0, 30).map((l) => l.text || "").join(" ");
  if (!sampleText.trim()) return null;

  let hangul = 0;
  let kana = 0;
  let hanzi = 0;
  let thai = 0;
  let viDiacritics = 0;
  let latin = 0;

  for (const ch of sampleText) {
    if (/[\uac00-\ud7af\u1100-\u11ff]/.test(ch)) hangul++;
    else if (/[\u3040-\u309f\u30a0-\u30ff]/.test(ch)) kana++;
    else if (/[\u4e00-\u9fff]/.test(ch)) hanzi++;
    else if (/[\u0e00-\u0e7f]/.test(ch)) thai++;
    else if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(ch)) viDiacritics++;
    else if (/[a-zA-Z]/.test(ch)) latin++;
  }

  if (hangul >= 10 || (hangul > 0 && hangul > latin * 0.15)) return "ko";
  if (kana >= 10 || (kana > 0 && kana > latin * 0.15)) return "ja";
  if (thai >= 10 || (thai > 0 && thai > latin * 0.15)) return "th";
  if (hanzi >= 10 && kana === 0) return "zh";
  if (viDiacritics >= 5 || (viDiacritics > 0 && viDiacritics >= latin * 0.05)) return "vi";
  if (latin > 0) return "en";

  return null;
}

function rankCreatorTracks(creatorTracks, detectedLang) {
  return [...creatorTracks].sort((a, b) => {
    const aLang = (a.languageCode || "").toLowerCase();
    const bLang = (b.languageCode || "").toLowerCase();
    const aName = getTrackNameString(a).toLowerCase();
    const bName = getTrackNameString(b).toLowerCase();

    // 1. Language match score
    let aScore = 0;
    let bScore = 0;

    if (detectedLang) {
      if (aLang === detectedLang || aLang.startsWith(`${detectedLang}-`)) aScore += 100;
      if (bLang === detectedLang || bLang.startsWith(`${detectedLang}-`)) bScore += 100;
    }

    // 2. Lyrics vs Translation markers
    if (/\b(?:lyrics|l\u1eddi|gasa|\uac00\uc0ac|\u6b4c\u8a5e)\b/i.test(aName)) aScore += 20;
    if (/\b(?:lyrics|l\u1eddi|gasa|\uac00\uc0ac|\u6b4c\u8a5e)\b/i.test(bName)) bScore += 20;

    if (/\b(?:translation|d\u1ecbch|english sub|sub eng|eng sub|vietsub|b\u1ea3n d\u1ecbch|\ubc88\uc5ed)\b/i.test(aName)) aScore -= 50;
    if (/\b(?:translation|d\u1ecbch|english sub|sub eng|eng sub|vietsub|b\u1ea3n d\u1ecbch|\ubc88\uc5ed)\b/i.test(bName)) bScore -= 50;

    return bScore - aScore;
  });
}

/**
 * Unified YouTube creator caption resolver for both playback and probe badges.
 *
 * @param {string} videoId
 * @param {object} options
 * @returns {Promise<{ ok: boolean, hasCcLyrics?: boolean, lines?: Array, language?: string, trackName?: string, source?: string, error?: string }>}
 */
export async function resolveYouTubeCreatorLyrics(
  videoId,
  {
    title = "",
    artist = "",
    fetchImpl = globalThis.fetch,
    timeoutMs = 6000,
    mode = "full", // "full" | "probe"
  } = {}
) {
  if (!videoId || typeof videoId !== "string" || !YT_VIDEO_ID_RE.test(videoId.trim())) {
    return { ok: false, hasCcLyrics: false, error: "invalid_video_id" };
  }

  const cleanId = videoId.trim();

  // Check cache first
  const cached = resolverCache.get(cleanId);
  if (cached && Date.now() < cached.expiresAt) {
    if (mode === "probe") {
      return { ok: cached.hasCcLyrics, hasCcLyrics: cached.hasCcLyrics };
    }
    if (cached.fullResult) {
      return cached.fullResult;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // 1. Fetch player endpoint (Client: ANDROID)
    let playerRes = await fetchImpl(INNERTUBE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": INNERTUBE_USER_AGENT,
      },
      body: JSON.stringify({
        videoId: cleanId,
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: INNERTUBE_CLIENT_VERSION,
          },
        },
      }),
      signal: controller.signal,
    });

    let playerData = null;
    if (playerRes.ok) {
      try {
        playerData = await playerRes.json();
      } catch {}
    }

    let rawTracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    // Fallback to WEB client if ANDROID returned 200 but had no caption tracks
    if ((!Array.isArray(rawTracks) || rawTracks.length === 0) && playerRes.ok) {
      try {
        const webRes = await fetchImpl(INNERTUBE_API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": WEB_USER_AGENT,
          },
          body: JSON.stringify({
            videoId: cleanId,
            context: {
              client: {
                clientName: "WEB",
                clientVersion: "2.20240101.00.00",
              },
            },
          }),
          signal: controller.signal,
        });
        if (webRes.ok) {
          const webData = await webRes.json();
          const webTracks = webData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          if (Array.isArray(webTracks) && webTracks.length > 0) {
            playerData = webData;
            rawTracks = webTracks;
          }
        }
      } catch {}
    }

    if (!Array.isArray(rawTracks) || rawTracks.length === 0) {
      _saveResolverCache(cleanId, false, { ok: false, error: "no_creator_captions" });
      return { ok: false, hasCcLyrics: false, error: "no_creator_captions" };
    }

    const creatorTracks = filterCreatorTracks(rawTracks);
    if (creatorTracks.length === 0) {
      // Check if non-ASR human tracks were rejected due to invalid baseUrl (SSRF)
      const nonAsrTracks = rawTracks.filter((t) => t && t.kind !== "asr" && !(typeof t.vssId === "string" && t.vssId.startsWith("a.")));
      const hasSsrfTrack = nonAsrTracks.some((t) => typeof t?.baseUrl === "string" && !isAllowedCaptionUrl(t.baseUrl));
      const err = hasSsrfTrack ? "invalid_caption_url" : "no_creator_captions";
      _saveResolverCache(cleanId, false, { ok: false, error: err });
      return { ok: false, hasCcLyrics: false, error: err };
    }

    const videoDetails = playerData?.videoDetails || null;
    const audioTracks = playerData?.audioTracks || [];

    const detectedSongLang = detectSongLanguage({
      title,
      artist,
      videoDetails,
      audioTracks,
      creatorTracks,
    });

    const rankedTracks = rankCreatorTracks(creatorTracks, detectedSongLang);
    const candidateTracks = rankedTracks.slice(0, 3);

    let chosenResult = null;

    for (const track of candidateTracks) {
      if (!track.baseUrl || !isAllowedCaptionUrl(track.baseUrl)) {
        continue;
      }

      let captionRes;
      try {
        captionRes = await fetchImpl(track.baseUrl, {
          headers: { "User-Agent": INNERTUBE_USER_AGENT },
          signal: controller.signal,
        });
      } catch {
        continue;
      }

      if (!captionRes || !captionRes.ok) continue;

      const xml = await captionRes.text();
      const rawParsedLines = parseYouTubeTimedText(xml);
      const lines = cleanAndFilterLyricsLines(rawParsedLines);
      if (!lines || lines.length < CC_MIN_LINES) continue;

      const totalChars = lines.reduce((sum, l) => sum + (l.text ? l.text.length : 0), 0);
      if (totalChars < CC_MIN_CHAR_TOTAL) continue;

      const textLang = detectTextLanguage(lines);

      // Verify content language against detected song language
      if (detectedSongLang) {
        if (textLang !== detectedSongLang) {
          // Content language does not match the original song language
          continue;
        }
      } else {
        // Song language is ambiguous (Latin-only title etc.)
        // If track is labeled "en" or content is English, but title has non-Latin chars, skip
        const titleHasNonLatin = /[^\u0000-\u007F]/.test(`${title} ${artist}`);
        if (titleHasNonLatin && textLang === "en") {
          continue;
        }
      }

      chosenResult = {
        ok: true,
        synced: true,
        source: "youtube_captions",
        language: textLang || track.languageCode || detectedSongLang || "unknown",
        trackName: getTrackNameString(track),
        lines,
      };
      break;
    }

    if (!chosenResult) {
      _saveResolverCache(cleanId, false, { ok: false, error: "no_creator_captions" });
      return { ok: false, hasCcLyrics: false, error: "no_creator_captions" };
    }

    _saveResolverCache(cleanId, true, chosenResult);

    if (mode === "probe") {
      return {
        ok: true,
        hasCcLyrics: true,
        language: chosenResult.language,
        lines: chosenResult.lines,
      };
    }

    return chosenResult;
  } catch (err) {
    return {
      ok: false,
      hasCcLyrics: false,
      error: err.name === "AbortError" ? "timeout" : "network_error",
    };
  } finally {
    clearTimeout(timer);
  }
}

function _saveResolverCache(videoId, hasCcLyrics, fullResult) {
  if (resolverCache.size >= RESOLVER_CACHE_MAX) {
    resolverCache.delete(resolverCache.keys().next().value);
  }
  resolverCache.set(videoId, {
    hasCcLyrics,
    fullResult,
    expiresAt: Date.now() + RESOLVER_CACHE_TTL_MS,
  });
}
