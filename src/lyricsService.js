// Lyrics service using LRCLIB API for synchronized time-stamped lyrics.

const LRCLIB_BASE = "https://lrclib.net/api";
const USER_AGENT = "OfficeJukebox/1.0 (https://github.com/laztar)";

// In-memory cache for fast repeat access
const lyricsCache = new Map();
const MAX_CACHE_SIZE = 100;

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
    .trim();

  // Strip artist noise like " - Topic"
  artist = artist.replace(/\s*-\s*Topic$/i, "").trim();

  return { title, artist };
}

export function parseLrc(lrcText) {
  if (typeof lrcText !== "string" || !lrcText.trim()) return [];
  const lines = lrcText.split("\n");
  const result = [];
  const regex = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\](.*)/;

  for (const line of lines) {
    const match = line.match(regex);
    if (match) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const ms = match[3] ? parseInt(match[3].padEnd(3, "0").slice(0, 3), 10) : 0;
      const time = min * 60 + sec + ms / 1000;
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
  { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}
) {
  const { title, artist } = cleanLyricsQuery(rawTitle, rawArtist);
  if (!title) return { ok: false, error: "empty_title" };

  const cacheKey = `${artist.toLowerCase()}:::${title.toLowerCase()}`;
  if (lyricsCache.has(cacheKey)) {
    return lyricsCache.get(cacheKey);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let data = null;

    // 1. Try exact match first if we have both title and artist
    if (artist) {
      const params = new URLSearchParams({
        track_name: title,
        artist_name: artist,
      });
      if (durationSec && Number.isFinite(durationSec)) {
        params.set("duration", Math.round(durationSec));
      }

      const res = await fetchImpl(`${LRCLIB_BASE}/get?${params.toString()}`, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: controller.signal,
      });

      if (res.ok) {
        data = await res.json();
      }
    }

    // 2. If exact match didn't yield synced lyrics, try fuzzy search
    if (!data || (!data.syncedLyrics && !data.plainLyrics)) {
      const query = artist ? `${artist} ${title}` : title;
      const searchRes = await fetchImpl(`${LRCLIB_BASE}/search?q=${encodeURIComponent(query)}`, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: controller.signal,
      });

      if (searchRes.ok) {
        const results = await searchRes.json();
        if (Array.isArray(results) && results.length > 0) {
          // Find first result with synced lyrics, or fallback to first result
          data = results.find((item) => Boolean(item.syncedLyrics)) || results[0];
        }
      }
    }

    if (!data) {
      const notFoundResult = { ok: false, error: "not_found" };
      return notFoundResult;
    }

    let parsedLines = [];
    let isSynced = false;

    if (data.syncedLyrics) {
      parsedLines = parseLrc(data.syncedLyrics);
      isSynced = parsedLines.length > 0;
    }

    if (!isSynced && data.plainLyrics) {
      // Fallback: split plain lyrics lines without timestamps
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
      trackName: data.trackName || title,
      artistName: data.artistName || artist,
      lines: parsedLines,
      plain: data.plainLyrics || null,
    };

    if (lyricsCache.size >= MAX_CACHE_SIZE) {
      const firstKey = lyricsCache.keys().next().value;
      lyricsCache.delete(firstKey);
    }
    lyricsCache.set(cacheKey, payload);

    return payload;
  } catch (err) {
    return { ok: false, error: err.name === "AbortError" ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}
