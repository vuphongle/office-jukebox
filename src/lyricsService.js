// Lyrics service using LRCLIB API for synchronized time-stamped lyrics.

import { scoreLyricsCandidate, detectTargetLanguage, analyzeScripts } from "./lyricsMatcher.js";
import { parseArtistListFromString } from "./spotify.js";

const LRCLIB_BASE = "https://lrclib.net/api";
const USER_AGENT = "OfficeJukebox/1.0 (https://github.com/laztar)";

// In-memory cache for fast repeat access
const lyricsCache = new Map();
const negativeCache = new Map();
const MAX_CACHE_SIZE = 150;
const NEGATIVE_CACHE_TTL_MS = 180_000; // 3 minutes

export function clearLyricsCache() {
  lyricsCache.clear();
  negativeCache.clear();
}

export function cleanLyricsQuery(rawTitle, rawArtist) {
  let title = (rawTitle || "").trim();
  let artist = (rawArtist || "").trim();

  // If title is in format "Artist - Title", split it
  if (!artist && title.includes(" - ")) {
    const parts = title.split(" - ");
    artist = parts[0].trim();
    title = parts.slice(1).join(" - ").trim();
  }

  // Strip noise patterns: [MV], (Official Audio), (prod. by...), etc.
  title = title
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\([^)]*(?:official|video|audio|mv|prod\.|feat\.|ft\.)[^)]*\)/gi, "")
    .replace(/\|.*$/g, "")
    .replace(/-.*(?:official|mv|audio).*$/gi, "")
    .replace(/\s*(?:-\s*)?(?:feat\.|ft\.).*$/gi, "")
    .trim();

  // Strip artist noise like " - Topic"
  artist = artist.replace(/\s*-\s*Topic$/i, "").trim();

  return { title, artist };
}

export function parseLrc(lrcText) {
  if (typeof lrcText !== "string" || !lrcText.trim()) return [];
  const lines = lrcText.split("\n");
  const result = [];
  let offsetMs = 0;
  const timeRegex = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\](.*)/;
  const offsetRegex = /^\[offset:\s*([+-]?\d+)\s*\]/i;

  for (const line of lines) {
    const offsetMatch = line.match(offsetRegex);
    if (offsetMatch) {
      offsetMs = parseInt(offsetMatch[1], 10) || 0;
      continue;
    }
    const match = line.match(timeRegex);
    if (match) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const ms = match[3] ? parseInt(match[3].padEnd(3, "0").slice(0, 3), 10) : 0;
      const time = Math.max(0, min * 60 + sec + (ms + offsetMs) / 1000);
      const text = match[4].trim();
      if (text) {
        result.push({ time, text });
      }
    }
  }

  return result.sort((a, b) => a.time - b.time);
}

export async function fetchLyrics(
  rawTitle,
  rawArtist = "",
  durationSec = null,
  { fetchImpl = globalThis.fetch, timeoutMs = 6000, artists = [] } = {}
) {
  const { title, artist } = cleanLyricsQuery(rawTitle, rawArtist);
  if (!title) return { ok: false, error: "empty_title" };

  const targetArtists = Array.isArray(artists) && artists.length > 0
    ? artists.map((a) => (typeof a === "string" ? a.trim() : "")).filter(Boolean)
    : parseArtistListFromString(artist);

  const artistKey = targetArtists.length > 0 ? targetArtists.join(",").toLowerCase() : artist.toLowerCase();
  const cacheKey = `${artistKey}:::${title.toLowerCase()}`;

  if (lyricsCache.has(cacheKey)) {
    return lyricsCache.get(cacheKey);
  }

  const now = Date.now();
  if (negativeCache.has(cacheKey)) {
    const neg = negativeCache.get(cacheKey);
    if (now < neg.expiresAt) {
      return { ok: false, error: neg.error };
    }
    negativeCache.delete(cacheKey);
  }

  const primaryArtist = targetArtists[0] || (artist ? artist.split(/[,;&]/)[0].replace(/["']/g, "").trim() : "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const candidateMap = new Map();

    const addCandidate = (cand) => {
      if (!cand || typeof cand !== "object") return;
      const idKey = cand.id != null ? `id_${cand.id}` : `${cand.artistName || ""}:::${cand.trackName || ""}`;
      if (!candidateMap.has(idKey)) {
        candidateMap.set(idKey, cand);
      }
    };

    // Helper for /api/get
    const tryExactGet = async (artistParam) => {
      if (!artistParam) return null;
      try {
        const params = new URLSearchParams({
          track_name: title,
          artist_name: artistParam,
        });
        if (durationSec && Number.isFinite(durationSec)) {
          params.set("duration", Math.round(durationSec));
        }
        const res = await fetchImpl(`${LRCLIB_BASE}/get?${params.toString()}`, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
          signal: controller.signal,
        });
        if (res.ok) {
          const json = await res.json();
          if (json && (json.syncedLyrics || json.plainLyrics)) {
            addCandidate(json);
            return json;
          }
        }
      } catch {}
      return null;
    };

    // Helper for /api/search
    const trySearchQuery = async (queryStr) => {
      if (!queryStr || !queryStr.trim()) return;
      try {
        const res = await fetchImpl(`${LRCLIB_BASE}/search?q=${encodeURIComponent(queryStr.trim())}`, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
          signal: controller.signal,
        });
        if (res.ok) {
          const list = await res.json();
          if (Array.isArray(list)) {
            for (const item of list) {
              addCandidate(item);
            }
          }
        }
      } catch {}
    };

    // 1. Try exact match with all artists joined
    if (targetArtists.length > 0) {
      const fullArtistsStr = targetArtists.join(", ");
      const exactFull = await tryExactGet(fullArtistsStr);
      if (exactFull?.syncedLyrics) {
        const scored = scoreLyricsCandidate(exactFull, {
          targetTitle: title,
          targetArtists,
          targetDurationSec: durationSec,
        });
        if (scored.isAcceptable && scored.allArtistsMatched && scored.score >= 100) {
          const targetLang = detectTargetLanguage({ targetTitle: title, targetArtists });
          const scripts = analyzeScripts(exactFull.syncedLyrics);
          const needsScriptCheck = targetLang === "korean" || targetLang === "vietnamese" || targetLang === "japanese";
          const hasNativeScript =
            targetLang === "korean" ? scripts.hangul > 10 :
            targetLang === "vietnamese" ? scripts.vietnamese > 5 :
            targetLang === "japanese" ? scripts.kana > 10 : true;

          if (!needsScriptCheck || hasNativeScript) {
            // Early return on perfect exact multi-artist match with authentic script
            return saveAndReturnLyrics(cacheKey, exactFull, title, fullArtistsStr);
          }
        }
      }
    }

    // 2. Try exact match with primary artist
    if (primaryArtist && primaryArtist !== targetArtists.join(", ")) {
      const exactPrimary = await tryExactGet(primaryArtist);
      if (exactPrimary?.syncedLyrics) {
        const scored = scoreLyricsCandidate(exactPrimary, {
          targetTitle: title,
          targetArtists,
          targetDurationSec: durationSec,
        });
        if (scored.isAcceptable && scored.allArtistsMatched && scored.score >= 100) {
          const targetLang = detectTargetLanguage({ targetTitle: title, targetArtists });
          const scripts = analyzeScripts(exactPrimary.syncedLyrics);
          const needsScriptCheck = targetLang === "korean" || targetLang === "vietnamese" || targetLang === "japanese";
          const hasNativeScript =
            targetLang === "korean" ? scripts.hangul > 10 :
            targetLang === "vietnamese" ? scripts.vietnamese > 5 :
            targetLang === "japanese" ? scripts.kana > 10 : true;

          if (!needsScriptCheck || hasNativeScript) {
            return saveAndReturnLyrics(cacheKey, exactPrimary, title, primaryArtist);
          }
        }
      }
    }

    // 3. Fuzzy search queries in descending specificity
    const featuredArtists = targetArtists.slice(1).join(" ");
    const searchQueries = [
      primaryArtist && featuredArtists ? `${primaryArtist} ${featuredArtists} ${title}` : null,
      primaryArtist ? `${primaryArtist} ${title}` : (artist ? `${artist} ${title}` : null),
      title,
    ].filter(Boolean);

    for (const q of searchQueries) {
      await trySearchQuery(q);
      // If we already found a high-confidence candidate with all artists matched and synced lyrics, stop searching
      const candidates = Array.from(candidateMap.values());
      const hasPerfectMatch = candidates.some((cand) => {
        if (!cand.syncedLyrics) return false;
        const s = scoreLyricsCandidate(cand, {
          targetTitle: title,
          targetArtists,
          targetDurationSec: durationSec,
          candidateHints: candidates,
        });
        return s.isAcceptable && s.allArtistsMatched && s.score >= 120;
      });
      if (hasPerfectMatch) break;
    }

    // 4. Score and rank all collected candidates
    const allCandidates = Array.from(candidateMap.values());
    if (allCandidates.length === 0) {
      negativeCache.set(cacheKey, { error: "not_found", expiresAt: now + NEGATIVE_CACHE_TTL_MS });
      return { ok: false, error: "not_found" };
    }

    const scoredList = allCandidates
      .map((candidate) => ({
        candidate,
        result: scoreLyricsCandidate(candidate, {
          targetTitle: title,
          targetArtists,
          targetDurationSec: durationSec,
          candidateHints: allCandidates,
        }),
      }))
      .filter((item) => item.result.isAcceptable)
      .sort((a, b) => b.result.score - a.result.score);

    if (scoredList.length === 0) {
      // Candidates were found on LRCLIB, but all were disqualified (wrong cover, remix duration mismatch, etc.)
      negativeCache.set(cacheKey, { error: "no_matching_version", expiresAt: now + NEGATIVE_CACHE_TTL_MS });
      return { ok: false, error: "no_matching_version" };
    }

    const best = scoredList[0].candidate;
    return saveAndReturnLyrics(cacheKey, best, title, artist || primaryArtist);
  } catch (err) {
    return { ok: false, error: err.name === "AbortError" ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

function saveAndReturnLyrics(cacheKey, data, defaultTitle, defaultArtist) {
  let parsedLines = [];
  let isSynced = false;

  if (data.syncedLyrics) {
    parsedLines = parseLrc(data.syncedLyrics);
    isSynced = parsedLines.length > 0;
  }

  if (!isSynced && data.plainLyrics) {
    parsedLines = data.plainLyrics
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean)
      .map((text, idx) => ({ time: idx * 5, text }));
  }

  if (parsedLines.length === 0) {
    return { ok: false, error: "no_lyrics_content" };
  }

  const payload = {
    ok: true,
    synced: isSynced,
    trackName: data.trackName || defaultTitle,
    artistName: data.artistName || defaultArtist,
    lines: parsedLines,
    plain: data.plainLyrics || null,
  };

  if (lyricsCache.size >= MAX_CACHE_SIZE) {
    const firstKey = lyricsCache.keys().next().value;
    lyricsCache.delete(firstKey);
  }
  lyricsCache.set(cacheKey, payload);

  return payload;
}

export async function prefetchLyricsForTrack({
  title,
  artist = "",
  artists = [],
  durationSec = null,
  trackId = "",
  fetchImpl = globalThis.fetch,
} = {}) {
  try {
    return await fetchLyrics(title, artist, durationSec, {
      artists,
      fetchImpl,
      timeoutMs: 8000,
    });
  } catch (err) {
    return { ok: false, error: err?.message || "prefetch_error" };
  }
}
