// Provider for fetching creator-uploaded (human) YouTube captions
// Refactored to delegate to youtubeLyricsResolver.js as the single source of truth.

import {
  resolveYouTubeCreatorLyrics,
  parseYouTubeTimedText as parseXmlTimedText,
  decodeHtmlEntities as decodeEntities,
  isAllowedCaptionUrl,
  scoreScriptCharacters,
  resolveDominantLanguage,
} from "./youtubeLyricsResolver.js";

export function detectOriginalLanguage(title = "", artist = "") {
  const text = `${title} ${artist}`.trim();
  const dominant = resolveDominantLanguage(scoreScriptCharacters(text), 1);
  return dominant || "en";
}

export function selectOriginalCreatorTrack(captionTracks, originalLang) {
  if (!Array.isArray(captionTracks) || captionTracks.length === 0) {
    return null;
  }

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

  const exactMatch = creatorTracks.find((t) => {
    const code = (t.languageCode || "").toLowerCase();
    const vss = (t.vssId || "").toLowerCase();
    return code === targetLang || vss === `.${targetLang}` || vss.startsWith(`.${targetLang}.`);
  });

  if (exactMatch) {
    return exactMatch;
  }

  const prefixMatch = creatorTracks.find((t) => {
    const code = (t.languageCode || "").toLowerCase();
    return code.startsWith(targetLang);
  });

  if (prefixMatch) {
    return prefixMatch;
  }

  if (targetLang !== "en") {
    return null;
  }

  return creatorTracks[0] || null;
}

export const decodeHtmlEntities = decodeEntities;
export const parseYouTubeTimedText = parseXmlTimedText;

export async function fetchYouTubeCreatorCaptions(
  videoId,
  { title = "", artist = "", fetchImpl = globalThis.fetch, timeoutMs = 6000 } = {}
) {
  return resolveYouTubeCreatorLyrics(videoId, {
    title,
    artist,
    fetchImpl,
    timeoutMs,
    mode: "full",
  });
}

export async function probeYouTubeCcLyrics(
  videoId,
  { fetchImpl = globalThis.fetch, timeoutMs = 2500 } = {}
) {
  const result = await resolveYouTubeCreatorLyrics(videoId, {
    fetchImpl,
    timeoutMs,
    mode: "probe",
  });
  return { hasCcLyrics: Boolean(result?.hasCcLyrics) };
}
