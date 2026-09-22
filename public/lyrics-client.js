(function attachJukeboxLyrics(global) {
  function cleanLyricsQuery(rawTitle, rawArtist) {
    let title = (rawTitle || "").trim();
    let artist = (rawArtist || "").trim();
    if (!artist && title.includes(" - ")) {
      const parts = title.split(" - ");
      artist = parts[0].trim();
      title = parts.slice(1).join(" - ").trim();
    }
    title = title
      .replace(/\[[^\]]*\]/g, "")
      .replace(/\([^)]*(?:official|video|audio|mv|prod\.|feat\.|ft\.)[^)]*\)/gi, "")
      .replace(/\|.*$/g, "")
      .replace(/-.*(?:official|mv|audio).*$/gi, "")
      .replace(/\s*(?:-\s*)?(?:feat\.|ft\.).*$/gi, "")
      .trim();
    artist = artist.replace(/\s*-\s*Topic$/i, "").trim();
    return { title, artist };
  }

  function parseLrc(lrcText) {
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

  async function fetchLyricsClient({
    title: rawTitle,
    artist: rawArtist = "",
    durationSec = null,
    fetchImpl = global.fetch || fetch,
    timeoutMs = 6000,
  } = {}) {
    const { title, artist } = cleanLyricsQuery(rawTitle, rawArtist);
    if (!title) return null;

    // 1. Try local backend /api/lyrics first
    try {
      const params = new URLSearchParams({ title, artist });
      if (durationSec && Number.isFinite(durationSec)) {
        params.set("duration", Math.round(durationSec));
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
      const primaryArtist = artist ? artist.split(/[,;]/)[0].replace(/["']/g, "").trim() : "";
      const searchQueries = [
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
            const found = list.find((it) => Boolean(it.syncedLyrics));
            if (found) {
              lrclibData = found;
              break;
            } else if (!lrclibData) {
              lrclibData = list[0];
            }
          }
        }
      }

      if (lrclibData) {
        let lines = [];
        let isSynced = false;
        if (lrclibData.syncedLyrics) {
          lines = parseLrc(lrclibData.syncedLyrics);
          isSynced = lines.length > 0;
        }
        if (!isSynced && lrclibData.plainLyrics) {
          lines = lrclibData.plainLyrics
            .split("\n")
            .map((t) => t.trim())
            .filter(Boolean)
            .map((text, idx) => ({ time: idx * 5, text }));
        }
        if (lines.length > 0) {
          return { ok: true, synced: isSynced, lines };
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
