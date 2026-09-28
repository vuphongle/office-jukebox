(function attachJukeboxLyrics(global) {
  function cleanLyricsQuery(rawTitle, rawArtist) {
    let title = (rawTitle || "").trim();
    let artist = (rawArtist || "").trim();
    if (title.includes(" - ")) {
      const parts = title.split(" - ");
      if (!artist) {
        artist = parts[0].trim();
        title = parts.slice(1).join(" - ").trim();
      } else if (parts[0].trim().toLowerCase() === artist.toLowerCase()) {
        title = parts.slice(1).join(" - ").trim();
      }
    }
    title = title
      .replace(/\[[^\]]*\]/g, "")
      .replace(/\([^)]*(?:official|video|audio|mv|prod\.|feat\.|ft\.)[^)]*\)/gi, "")
      .replace(/\s*[\-–—|/l•]\s*(?:official|music\s*video|mv|audio|lyric\s*video|video\s*lyric|live\s*session).*$/gi, "")
      .replace(/\|.*$/g, "")
      .replace(/\s*(?:-\s*)?(?:feat\.|ft\.).*$/gi, "")
      .trim();
    artist = artist.replace(/\s*-\s*Topic$/i, "").trim();
    return { title, artist };
  }

  function parseLrc(lrcText) {
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

  async function fetchLyricsClient({
    title: rawTitle,
    artist: rawArtist = "",
    artists = [],
    durationSec = null,
    platform = "",
    videoId = "",
    fetchImpl = global.fetch || fetch,
    timeoutMs = 6000,
  } = {}) {
    const { title, artist } = cleanLyricsQuery(rawTitle, rawArtist);
    if (!title) return null;

    // 1. Try local backend /api/lyrics first
    try {
      const params = new URLSearchParams({ title, artist });
      if (Array.isArray(artists) && artists.length > 0) {
        params.set("artists", JSON.stringify(artists));
      }
      if (durationSec && Number.isFinite(durationSec)) {
        params.set("duration", Math.round(durationSec));
      }
      if (platform) {
        params.set("platform", platform);
      }
      if (videoId) {
        params.set("videoId", videoId);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetchImpl(`/api/lyrics?${params.toString()}`, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const json = await res.json();
        if (json.ok && Array.isArray(json.lines) && json.lines.length > 0) {
          return json;
        }
      }
    } catch {}

    // 2. Direct browser fallback to LRCLIB API with smart queries
    try {
      const isYt = platform === "youtube" || platform === "yt";
      if (isYt) {
        const isMv = /\b(?:official\s*(?:music\s*)?video|official\s*mv|\bmv\b|\bm\/v\b|music\s*video|video\s*clip|phim\s*ca\s*nh\u1ea1c|short\s*film)\b/i.test(rawTitle);
        const isSpecialPerformance = /\b(?:live\s*(?:session|at|performance|acoustic)?|concert|performance\s*video|acoustic|remix|cover|dance\s*practice|speed\s*up|slowed)\b/i.test(rawTitle);
        if (isMv || isSpecialPerformance) {
          // Do not fall back to studio album lyrics for YouTube MVs/Live that lack CC
          return null;
        }
      }

      const targetArtists = Array.isArray(artists) && artists.length > 0
        ? artists
        : (artist ? [artist.split(/[,;]/)[0].trim()] : []);
      const primaryArtist = targetArtists[0] || (artist ? artist.split(/[,;]/)[0].replace(/["']/g, "").trim() : "");
      const featuredStr = targetArtists.slice(1).join(" ");
      const searchQueries = [
        primaryArtist && featuredStr ? `${primaryArtist} ${featuredStr} ${title}` : null,
        primaryArtist ? `${primaryArtist} ${title}` : (artist ? `${artist} ${title}` : null),
        artist && artist !== primaryArtist ? `${artist} ${title}` : null,
        title,
      ].filter(Boolean);

      let lrclibData = null;
      for (const q of searchQueries) {
        if (lrclibData && lrclibData.syncedLyrics) break;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        const res = await fetchImpl(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.ok) {
          const list = await res.json();
          if (Array.isArray(list) && list.length > 0) {
            // Find candidate that matches primary artist and doesn't mismatch duration
            const valid = list.filter((it) => {
              if (!it) return false;
              const text = `${it.trackName || ""} ${it.artistName || ""}`.toLowerCase();
              const normText = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d");
              const normArtist = (primaryArtist || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d");
              if (primaryArtist && !text.includes(primaryArtist.toLowerCase()) && !normText.includes(normArtist)) return false;
              if (durationSec && Number.isFinite(durationSec) && it.duration) {
                if (Math.abs(it.duration - durationSec) > 4) return false;
              }
              if (text.includes("cover") && !title.toLowerCase().includes("cover")) return false;
              return true;
            });

            const found = valid.find((it) => Boolean(it.syncedLyrics)) || valid[0];
            if (found) {
              lrclibData = found;
              break;
            }
          }
        }
      }

      if (lrclibData && lrclibData.syncedLyrics) {
        const lines = parseLrc(lrclibData.syncedLyrics);
        if (lines.length > 0) {
          return { ok: true, synced: true, lines };
        }
      }
    } catch {}

    return null;
  }

  global.JukeboxLyrics = Object.freeze({
    cleanLyricsQuery,
    parseLrc,
    fetchLyricsClient,
  });
})(typeof window !== "undefined" ? window : globalThis);
