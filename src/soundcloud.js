// SoundCloud URL parsing and oEmbed metadata extraction.

const SOUNDCLOUD_HOSTS = new Set(["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com", "on.soundcloud.com"]);

export function isValidSoundCloudUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    if (!/^https?:$/.test(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    if (!SOUNDCLOUD_HOSTS.has(host)) return false;

    // on.soundcloud.com short links need at least one path segment
    if (host === "on.soundcloud.com") {
      return url.pathname.split("/").filter(Boolean).length >= 1;
    }

    // soundcloud.com needs at least /artist/track (2 segments)
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return false;

    // Disallow reserved top-level paths
    const reserved = new Set(["discover", "stream", "upload", "search", "you", "settings", "messages", "stations", "charts"]);
    if (reserved.has(segments[0].toLowerCase())) return false;

    return true;
  } catch {
    return false;
  }
}

export function parseSoundCloudUrl(value) {
  if (!isValidSoundCloudUrl(value)) return null;
  const url = new URL(value.trim());
  const host = url.hostname.toLowerCase();
  // Retain query only for shortlinks if present; standard links strip tracking queries (?si=..., ?utm_source=...)
  if (host === "on.soundcloud.com") {
    return `${url.protocol}//${host}${url.pathname}${url.search}`;
  }
  return `${url.protocol}//${host}${url.pathname}`;
}

export function cleanSoundCloudTitle(rawTitle, authorName = "") {
  if (typeof rawTitle !== "string") return "";
  let title = rawTitle.trim();
  const author = typeof authorName === "string" ? authorName.trim() : "";

  // Strip leading artist prefix if already part of title (e.g., "Artist - Title")
  if (author && title.toLowerCase().startsWith(author.toLowerCase())) {
    const remainder = title.slice(author.length).trim();
    if (/^[-:–—|]\s*/.test(remainder)) {
      title = remainder.replace(/^[-:–—|]\s*/, "").trim();
    }
  }

  // Remove common promotional suffixes
  title = title.replace(/\s*[[(](?:free\s+download|out\s+now|official\s+audio|premiere)[\])]/gi, "").trim();
  return title || rawTitle.trim();
}

export async function fetchSoundCloudMetadata(
  trackUrl,
  { timeoutMs = 6000, fetchImpl = globalThis.fetch } = {}
) {
  const normalizedUrl = parseSoundCloudUrl(trackUrl);
  if (!normalizedUrl) return null;

  const oEmbedUrl = `https://soundcloud.com/oembed?url=${encodeURIComponent(normalizedUrl)}&format=json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(oEmbedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; OfficeJukebox/1.0)",
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!res.ok) return null;
    const data = await res.json();
    const rawTitle = typeof data.title === "string" ? data.title.trim() : "";
    const author = typeof data.author_name === "string" ? data.author_name.trim() : "SoundCloud Artist";
    if (!rawTitle) return null;

    const title = cleanSoundCloudTitle(rawTitle, author);

    return {
      videoId: normalizedUrl,
      title,
      channel: author,
      duration: "3:30",
      thumbnail: typeof data.thumbnail_url === "string" ? data.thumbnail_url : null,
      provider: "soundcloud",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
