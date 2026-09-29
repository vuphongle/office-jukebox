// Lyrics service orchestrating multi-source lyrics (YouTube Creator Captions -> LRCLIB -> Zing MP3)

import { scoreLyricsCandidate, detectTrackVersionType } from "./lyricsMatcher.js";
import { parseArtistListFromString } from "./spotify.js";
import { fetchYouTubeCreatorCaptions } from "./providers/youtubeCaptions.js";
import { fetchZingMp3Lyrics } from "./providers/zingMp3Lyrics.js";

const LRCLIB_BASE = "https://lrclib.net/api";
const USER_AGENT = "OfficeJukebox/1.0 (https://github.com/laztar)";

// In-memory cache for fast repeat access
const lyricsCache = new Map();
const negativeCache = new Map();
const MAX_CACHE_SIZE = 150;
const MAX_NEGATIVE_CACHE_SIZE = 500; // Prevent unbounded growth on bulk miss storms
const NEGATIVE_CACHE_TTL_MS = 180_000; // 3 minutes

export function clearLyricsCache() {
  lyricsCache.clear();
  negativeCache.clear();
}

function setNegativeCache(key, entry) {
  // Evict oldest entry when at capacity (FIFO is fine here — TTL handles freshness)
  if (negativeCache.size >= MAX_NEGATIVE_CACHE_SIZE) {
    const firstKey = negativeCache.keys().next().value;
    negativeCache.delete(firstKey);
  }
  negativeCache.set(key, entry);
}

export function cleanLyricsQuery(rawTitle, rawArtist) {
  let title = (rawTitle || "").trim();
  let artist = (rawArtist || "").trim();

  // Handle pipe '|' separated YouTube video titles (e.g. "PHƯƠNG MỸ CHI x DTAP | 'THIÊN ĐƯỜNG VỚI NGƯỜI THƯƠNG' | OFFICIAL MUSIC")
  if (title.includes("|")) {
    const segments = title.split("|").map((s) => s.trim()).filter(Boolean);
    const noiseRegex = /^(?:official\s*(?:music\s*)?video|official\s*mv|official\s*audio|mv|audio|lyric\s*video|video\s*lyric|live\s*session|official\s*music|music\s*video|official)$/i;
    const cleanSegments = segments.filter((s) => !noiseRegex.test(s));

    if (cleanSegments.length >= 2) {
      // 1. Check if a segment is wrapped in quotes like 'Title' or "Title"
      const quoted = cleanSegments.find((s) => /^['"“‘].*['"”’]$/.test(s.trim()));
      if (quoted) {
        title = quoted.replace(/^['"“‘]\s*|\s*['"”’]$/g, "").trim();
        const other = cleanSegments.find((s) => s !== quoted);
        if (other && !artist) {
          artist = other;
        }
      } else {
        // 2. If first segment matches artist name, remaining is title
        if (artist && cleanSegments[0].toLowerCase().includes(artist.toLowerCase())) {
          title = cleanSegments.slice(1).join(" ");
        } else {
          title = cleanSegments[0];
        }
      }
    } else if (cleanSegments.length === 1) {
      title = cleanSegments[0];
    }
  }

  // If title is in format "Artist - Title", split it or strip matching artist prefix
  if (title.includes(" - ")) {
    const parts = title.split(" - ");
    if (!artist) {
      artist = parts[0].trim();
      title = parts.slice(1).join(" - ").trim();
    } else if (parts[0].trim().toLowerCase() === artist.toLowerCase()) {
      title = parts.slice(1).join(" - ").trim();
    }
  }

  // Strip noise patterns: [MV], (Official Audio), (prod. by...), quotes, etc.
  title = title
    .replace(/^['"“‘]\s*|\s*['"”’]$/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\([^)]*(?:official|video|audio|mv|prod\.|feat\.|ft\.)[^)]*\)/gi, "")
    .replace(/\s*[\-–—|/l•]\s*(?:official|music\s*video|mv|audio|lyric\s*video|video\s*lyric|live\s*session).*$/gi, "")
    .replace(/\s*(?:-\s*)?(?:feat\.|ft\.).*$/gi, "")
    .replace(/^['"“‘]\s*|\s*['"”’]$/g, "")
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
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = 6000,
    artists = [],
    platform = "",
    videoId = "",
  } = {}
) {
  const { title, artist } = cleanLyricsQuery(rawTitle, rawArtist);
  if (!title) return { ok: false, error: "empty_title" };

  const targetArtists = Array.isArray(artists) && artists.length > 0
    ? artists.map((a) => (typeof a === "string" ? a.trim() : "")).filter(Boolean)
    : parseArtistListFromString(artist);

  const artistKey = targetArtists.length > 0 ? targetArtists.join(",").toLowerCase() : artist.toLowerCase();
  const cacheKey = `${artistKey}:::${title.toLowerCase()}`;

  if (lyricsCache.has(cacheKey)) {
    // LRU: move to end so recently-accessed entries survive eviction longer
    const cached = lyricsCache.get(cacheKey);
    lyricsCache.delete(cacheKey);
    lyricsCache.set(cacheKey, cached);
    return cached;
  }

  const now = Date.now();
  if (negativeCache.has(cacheKey)) {
    const neg = negativeCache.get(cacheKey);
    if (now < neg.expiresAt) {
      return { ok: false, error: neg.error };
    }
    negativeCache.delete(cacheKey);
  }

  const versionInfo = detectTrackVersionType(rawTitle, rawArtist);

  // 1. YouTube Creator Captions (only for YouTube platform when videoId is provided)
  if ((platform === "youtube" || platform === "yt") && videoId) {
    try {
      const ytResult = await fetchYouTubeCreatorCaptions(videoId, {
        title,
        artist,
        fetchImpl,
        timeoutMs: Math.min(timeoutMs, 3500),
      });
      if (ytResult?.ok && Array.isArray(ytResult.lines) && ytResult.lines.length > 0) {
        const payload = {
          ok: true,
          synced: true,
          source: "youtube_captions",
          trackName: title,
          artistName: artist || targetArtists[0] || "",
          lines: ytResult.lines,
          language: ytResult.language,
        };
        cachePayload(cacheKey, payload);
        return payload;
      }
    } catch {}

    // YouTube video has no creator captions (or they were rejected).
    // For MV / Live / Special Performance without CC: studio LRC from LRCLIB or Zing MP3
    // is only safe if duration matches within 2 s AND artist matches — both already enforced
    // by isStrictDuration + scoreLyricsCandidate below. Fall through to attempt LRCLIB first.
  }

  // 2. LRCLIB (Primary synced lyrics source)
  const primaryArtist = targetArtists[0] || (artist ? artist.split(/[,;&]/)[0].replace(/["']/g, "").trim() : "");
  let lrclibBest = null;

  // For YouTube audio tracks falling back to studio LRC, enforce strict duration matching (<= 2s)
  const isStrictDuration = (platform === "youtube" || platform === "yt");

  try {
    lrclibBest = await queryLrclib(title, artist, primaryArtist, targetArtists, durationSec, fetchImpl, timeoutMs, {
      isStrictDuration,
      maxDurationDiff: 2,
    });
  } catch {}

  if (lrclibBest) {
    return saveAndReturnLyrics(cacheKey, lrclibBest, title, artist || primaryArtist, "lrclib");
  }

  // 3. Fallback to Zing MP3 API (Secondary source, rich in Vietnamese/regional songs)
  try {
    const zingResult = await fetchZingMp3Lyrics(title, artist, durationSec, {
      fetchImpl,
      timeoutMs: Math.min(timeoutMs, 3500),
      artists: targetArtists,
      maxDurationDiff: 2,
    });
    if (zingResult?.ok && Array.isArray(zingResult.lines) && zingResult.lines.length > 0) {
      const payload = {
        ok: true,
        synced: true,
        source: "zingmp3",
        trackName: zingResult.trackName || title,
        artistName: zingResult.artistName || artist || primaryArtist,
        lines: zingResult.lines,
      };
      cachePayload(cacheKey, payload);
      return payload;
    }
  } catch {}

  // 4. Neither provider had an acceptable matching version
  setNegativeCache(cacheKey, { error: "no_matching_version", expiresAt: now + NEGATIVE_CACHE_TTL_MS });
  return { ok: false, error: "no_matching_version" };
}

async function queryLrclib(
  title,
  artist,
  primaryArtist,
  targetArtists,
  durationSec,
  fetchImpl,
  timeoutMs,
  { isStrictDuration = false, maxDurationDiff = 2 } = {}
) {
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
          isStrictDuration,
          maxDurationDiff,
        });
        if (scored.isAcceptable && scored.allArtistsMatched) {
          return exactFull;
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
          isStrictDuration,
          maxDurationDiff,
        });
        if (scored.isAcceptable && scored.allArtistsMatched) {
          return exactPrimary;
        }
      }
    }

    // 3. Fuzzy search queries
    const featuredArtists = targetArtists.slice(1).join(" ");
    const searchQueries = [
      primaryArtist && featuredArtists ? `${primaryArtist} ${featuredArtists} ${title}` : null,
      primaryArtist ? `${primaryArtist} ${title}` : (artist ? `${artist} ${title}` : null),
      title,
    ].filter(Boolean);

    for (const q of searchQueries) {
      await trySearchQuery(q);
      const candidates = Array.from(candidateMap.values());
      const hasPerfectMatch = candidates.some((cand) => {
        if (!cand.syncedLyrics) return false;
        const s = scoreLyricsCandidate(cand, {
          targetTitle: title,
          targetArtists,
          targetDurationSec: durationSec,
          isStrictDuration,
          maxDurationDiff,
        });
        return s.isAcceptable && s.allArtistsMatched;
      });
      if (hasPerfectMatch) break;
    }

    const allCandidates = Array.from(candidateMap.values());
    if (allCandidates.length === 0) {
      return null;
    }

    const scoredList = allCandidates
      .map((candidate) => ({
        candidate,
        result: scoreLyricsCandidate(candidate, {
          targetTitle: title,
          targetArtists,
          targetDurationSec: durationSec,
          isStrictDuration,
          maxDurationDiff,
        }),
      }))
      .filter((item) => item.result.isAcceptable)
      .sort((a, b) => b.result.score - a.result.score);

    if (scoredList.length === 0) {
      return null;
    }

    return scoredList[0].candidate;
  } finally {
    clearTimeout(timer);
  }
}

function cachePayload(cacheKey, payload) {
  if (lyricsCache.size >= MAX_CACHE_SIZE) {
    const firstKey = lyricsCache.keys().next().value;
    lyricsCache.delete(firstKey);
  }
  lyricsCache.set(cacheKey, payload);
}

function saveAndReturnLyrics(cacheKey, data, defaultTitle, defaultArtist, source = "lrclib") {
  let parsedLines = [];
  let isSynced = false;

  if (data.syncedLyrics) {
    parsedLines = parseLrc(data.syncedLyrics);
    isSynced = parsedLines.length > 0;
  }

  // Never assign fake 5s timestamps to plain lyrics.
  // Real synchronized lyrics are required for karaoke sync.
  if (!isSynced || parsedLines.length === 0) {
    return { ok: false, error: "no_synced_lyrics", plain: data.plainLyrics || null };
  }

  const payload = {
    ok: true,
    synced: isSynced,
    source,
    trackName: data.trackName || defaultTitle,
    artistName: data.artistName || defaultArtist,
    lines: parsedLines,
    plain: data.plainLyrics || null,
  };

  cachePayload(cacheKey, payload);
  return payload;
}

export async function prefetchLyricsForTrack({
  title,
  artist = "",
  artists = [],
  durationSec = null,
  trackId = "",
  platform = "",
  videoId = "",
  fetchImpl = globalThis.fetch,
} = {}) {
  try {
    return await fetchLyrics(title, artist, durationSec, {
      artists,
      platform,
      videoId: videoId || (platform === "youtube" ? trackId : ""),
      fetchImpl,
      timeoutMs: 8000,
    });
  } catch (err) {
    return { ok: false, error: err?.message || "prefetch_error" };
  }
}
