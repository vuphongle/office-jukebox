// TikTok URL parsing, metadata extraction, and direct audio resolution.

const TIKTOK_HOSTS = new Set([
  "tiktok.com",
  "www.tiktok.com",
  "m.tiktok.com",
  "vt.tiktok.com",
  "vm.tiktok.com",
  "t.tiktok.com",
]);

export function isValidTikTokUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    if (!/^https?:$/.test(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    if (!TIKTOK_HOSTS.has(host) && !host.endsWith(".tiktok.com")) return false;

    // Mobile shortlinks: vt.tiktok.com/..., vm.tiktok.com/..., t.tiktok.com/...
    if (host === "vt.tiktok.com" || host === "vm.tiktok.com" || host === "t.tiktok.com") {
      const segments = url.pathname.split("/").filter(Boolean);
      return segments.length >= 1;
    }

    // Direct /t/:code shortlinks
    if (url.pathname.startsWith("/t/")) {
      const segments = url.pathname.split("/").filter(Boolean);
      return segments.length >= 2;
    }

    // Direct /v/:id or /v/:id.html
    if (url.pathname.startsWith("/v/")) {
      return true;
    }

    // Standard video: /@username/video/:id or /@username/photo/:id
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length >= 3 && (segments[1] === "video" || segments[1] === "photo") && /^\d+$/.test(segments[2])) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

export function parseTikTokUrl(value) {
  if (!isValidTikTokUrl(value)) return null;
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    // Strip trailing slash if any, keeping canonical path without query params
    const pathname = url.pathname.replace(/\/+$/, "");
    return `https://${host}${pathname || "/"}`;
  } catch {
    return null;
  }
}

export function formatDurationSeconds(rawSeconds) {
  const sec = Math.max(0, Math.floor(Number(rawSeconds) || 0));
  if (sec <= 0) return "0:30";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function cleanTikTokTitle(rawTitle = "", musicTitle = "", author = "") {
  let title = (rawTitle || "").trim();
  const music = (musicTitle || "").trim();

  // If music title exists and is not a generic "original sound" / "âm thanh gốc",
  // prioritize the real music title
  const isGenericSound = !music || /^(?:original sound|âm thanh gốc|nhạc nền|sonido original)/i.test(music);
  if (music && !isGenericSound) {
    return music;
  }

  // Strip common hashtags and mentions
  if (title) {
    title = title
      .replace(/#[\p{L}\p{N}_-]+/gu, "")
      .replace(/@[\p{L}\p{N}_.-]+/gu, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  if (title) {
    return title;
  }

  if (music) {
    return music;
  }

  if (author) {
    return `Âm thanh TikTok của ${author}`;
  }

  return "TikTok Sound";
}

// In-memory TTL cache for resolved metadata (1 hour)
const tiktokMetadataCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;

export function getCachedTikTokMetadata(canonicalUrl) {
  const cached = tiktokMetadataCache.get(canonicalUrl);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    tiktokMetadataCache.delete(canonicalUrl);
    return null;
  }
  return cached.data;
}

export function clearTikTokCache() {
  tiktokMetadataCache.clear();
}

export function setCachedTikTokMetadata(canonicalUrl, data) {
  tiktokMetadataCache.set(canonicalUrl, {
    data,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  // Prevent unbounded cache growth
  if (tiktokMetadataCache.size > 200) {
    const oldestKey = tiktokMetadataCache.keys().next().value;
    tiktokMetadataCache.delete(oldestKey);
  }
}

export async function fetchTikTokMetadata(
  videoUrl,
  { timeoutMs = 8000, fetchImpl = globalThis.fetch } = {}
) {
  const normalizedUrl = parseTikTokUrl(videoUrl);
  if (!normalizedUrl) return null;

  const cached = getCachedTikTokMetadata(normalizedUrl);
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(normalizedUrl)}`;
    const res = await fetchImpl(apiUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; OfficeJukebox/1.0)",
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (res.ok) {
      const json = await res.json();
      if (json && json.code === 0 && json.data) {
        const d = json.data;
        const channel = (d.music_info?.author || d.author?.nickname || d.author?.unique_id || "TikTok Creator").trim();
        const title = cleanTikTokTitle(d.title, d.music_info?.title, channel);
        const duration = formatDurationSeconds(d.duration);
        const thumbnail = d.cover || d.origin_cover || d.author?.avatar || null;
        const streamUrl = d.music || d.music_info?.play || d.play || "";

        const song = {
          videoId: normalizedUrl,
          title,
          channel,
          duration,
          thumbnail,
          provider: "tiktok",
          streamUrl,
        };

        setCachedTikTokMetadata(normalizedUrl, song);
        return song;
      }
    }
  } catch (err) {
    // If TikWM times out or fails, fall back to official oEmbed below
  } finally {
    clearTimeout(timer);
  }

  // Fallback: Official TikTok oEmbed (metadata without direct mp3)
  try {
    const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(normalizedUrl)}`;
    const oembedRes = await fetchImpl(oembedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        Accept: "application/json",
      },
    });
    if (oembedRes.ok) {
      const oembed = await oembedRes.json();
      if (oembed && oembed.title) {
        const channel = (oembed.author_name || "TikTok Creator").trim();
        const title = cleanTikTokTitle(oembed.title, "", channel);
        const song = {
          videoId: normalizedUrl,
          title,
          channel,
          duration: "0:30",
          thumbnail: oembed.thumbnail_url || null,
          provider: "tiktok",
          streamUrl: "",
        };
        setCachedTikTokMetadata(normalizedUrl, song);
        return song;
      }
    }
  } catch {}

  return null;
}
