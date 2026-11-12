// Keyless YouTube access:
//  - searchYouTube(): call YouTube Music's internal search API (InnerTube, the
//    same JSON endpoint used by music.youtube.com). Direct search prioritizes
//    web-like context, then supplements results with the "Songs" filter.
//    Discovery tabs use only the "Songs" filter.
//  - checkPlayable(): use the oEmbed endpoint to reject deleted/private videos
//    before queueing. Embed-disabled videos still return 200 here, so the host
//    player also skips iframe error codes 101/150.

import { formatSecondsToDuration } from "./duration.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const SEARCH_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

// SOCS/CONSENT cookies avoid the EU "before continuing" consent screen, which
// would replace ytInitialData with an interstitial page.
const COMMON_HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "en-US,en;q=0.9",
  Cookie: "SOCS=CAI;CONSENT=YES+1",
};

const SEARCH_HEADERS = {
  ...COMMON_HEADERS,
  "User-Agent": SEARCH_UA,
  "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
  "Content-Type": "application/json",
  Origin: "https://music.youtube.com",
  Referer: "https://music.youtube.com/",
};

const SEARCH_CLIENT = {
  clientName: "WEB_REMIX",
  clientVersion: "1.20260818.08.00",
  hl: "vi",
  gl: "VN",
};

function pickThumbnail(thumbs) {
  if (!Array.isArray(thumbs) || thumbs.length === 0) return null;
  // YT Music returns small album art (60/120px), but the size is encoded in the
  // URL suffix; request a larger square image.
  return thumbs[thumbs.length - 1].url.replace(/=w\d+-h\d+/, "=w320-h320");
}

// InnerTube search filter for the "Songs" category (the value used by ytmusicapi).
export const SONGS_FILTER = "EgWKAQIIAWoMEA4QChADEAQQCRAF";

export function buildSearchBody(query, { mode = "web" } = {}) {
  const body = {
    context: { client: { ...SEARCH_CLIENT } },
    query,
  };
  if (mode === "songs") body.params = SONGS_FILTER;
  return body;
}

function walkMusicItems(value, visit) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkMusicItems(item, visit);
    return;
  }
  if (value.musicResponsiveListItemRenderer) visit(value.musicResponsiveListItemRenderer);
  for (const child of Object.values(value)) walkMusicItems(child, visit);
}

function walkSongsItems(data, visit) {
  const sections =
    data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content
      ?.sectionListRenderer?.contents || [];
  for (const section of sections) {
    for (const item of section?.musicShelfRenderer?.contents || []) {
      if (item?.musicResponsiveListItemRenderer) visit(item.musicResponsiveListItemRenderer);
    }
  }
}

function musicVideoType(renderer) {
  return renderer?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
    ?.playNavigationEndpoint?.watchEndpoint?.watchEndpointMusicSupportedConfigs
    ?.watchEndpointMusicConfig?.musicVideoType;
}

function accessibilityArtist(renderer, title) {
  const label =
    renderer?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
      ?.accessibilityPlayData?.accessibilityData?.label || "";
  const prefix = `${title} - `;
  const index = label.lastIndexOf(prefix);
  return index >= 0 ? label.slice(index + prefix.length).trim() : "";
}

function isWebMusicResult(renderer, byline) {
  // The web search mixes songs, official music videos, UGC, podcasts, timers,
  // and other media in the same shelf. Keep songs and official music videos;
  // this recovers web-ranked tracks without filling the queue with podcasts.
  const kind = byline
    .map((run) => String(run.text || "").trim())
    .find((text, index) => text && text !== "•" && !byline[index]?.navigationEndpoint);
  return /^(bài hát|song)$/i.test(kind || "") || musicVideoType(renderer) === "MUSIC_VIDEO_TYPE_OMV";
}

export function parseSearchResults(data, { limit = 12, offset = 0, webLike = false } = {}) {
  const results = [];
  const seen = new Set();
  let skipped = 0;
  const skipCount = Math.max(0, parseInt(offset, 10) || 0);

  const visit = (renderer) => {
    if (results.length >= limit) return;
    const videoId =
      renderer.playlistItemData?.videoId ||
      renderer.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
        ?.playNavigationEndpoint?.watchEndpoint?.videoId;
    if (!videoId || seen.has(videoId)) return;

    const cols = (renderer.flexColumns || []).map(
      (column) => column.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []
    );
    const byline = cols[1] || [];
    if (webLike && !isWebMusicResult(renderer, byline)) return;

    const fixedDuration =
      renderer.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs
        ?.map((run) => run.text)
        .find((text) => /^\d+:\d\d/.test(text || ""));
    const duration =
      byline.map((run) => run.text).filter((text) => /^\d+:\d\d/.test(text)).pop() ||
      fixedDuration ||
      "";
    const artistRun = byline.find((run) => run.navigationEndpoint?.browseEndpoint);
    const title = cols[0]?.map((run) => run.text).join("") || "(không có tiêu đề)";
    const channel = artistRun?.text || accessibilityArtist(renderer, title) || byline[0]?.text;
    seen.add(videoId);
    if (skipped < skipCount) {
      skipped++;
      return;
    }
    results.push({
      videoId,
      title,
      channel: channel || "Không rõ",
      duration: duration || "",
      thumbnail: pickThumbnail(renderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails),
    });
  };
  if (webLike) walkMusicItems(data, visit);
  else walkSongsItems(data, visit);
  return results;
}

export function mergeSearchResults(primary, fallback, limit = 12) {
  const merged = [];
  const seen = new Set();
  for (const result of [...primary, ...fallback]) {
    if (!result?.videoId || seen.has(result.videoId)) continue;
    seen.add(result.videoId);
    merged.push(result);
    if (merged.length >= limit) break;
  }
  return merged;
}

function parseInitialData(html) {
  const marker = "ytInitialData";
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) throw new Error("YouTube Web không trả về dữ liệu tìm kiếm.");
  const start = html.indexOf("{", markerIndex + marker.length);
  if (start < 0) throw new Error("YouTube Web trả về dữ liệu không hợp lệ.");

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return JSON.parse(html.slice(start, index + 1));
  }
  throw new Error("YouTube Web trả về dữ liệu chưa hoàn chỉnh.");
}

function textValue(value) {
  return value?.runs?.map((run) => run.text || "").join("") || value?.simpleText || "";
}

export function parseYouTubeWebResults(data, { limit = 12, offset = 0 } = {}) {
  const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
    ?.sectionListRenderer?.contents || [];
  const results = [];
  const seen = new Set();
  let skipped = 0;
  const skipCount = Math.max(0, parseInt(offset, 10) || 0);

  const pushRenderer = (renderer) => {
    if (!renderer || results.length >= limit) return;
    const videoId = renderer?.videoId;
    if (!isValidYouTubeVideoId(videoId) || seen.has(videoId)) return;
    seen.add(videoId);
    if (skipped < skipCount) {
      skipped++;
      return;
    }
    results.push({
      videoId,
      title: textValue(renderer.title) || "(không có tiêu đề)",
      channel: textValue(renderer.ownerText) || textValue(renderer.longBylineText) || textValue(renderer.shortBylineText) || "Không rõ",
      duration: textValue(renderer.lengthText),
      thumbnail: sanitizeThumbnail(renderer.thumbnail?.thumbnails?.at(-1)?.url) || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    });
  };

  for (const section of sections) {
    for (const item of section?.itemSectionRenderer?.contents || []) {
      const renderer = item?.videoRenderer || item?.richItemRenderer?.content?.videoRenderer;
      pushRenderer(renderer);
      if (results.length >= limit) return results;
    }
  }

  if (results.length === 0 && data && typeof data === "object") {
    const walkVideos = (node) => {
      if (!node || typeof node !== "object" || results.length >= limit) return;
      if (Array.isArray(node)) {
        for (const item of node) walkVideos(item);
        return;
      }
      if (node.videoRenderer) pushRenderer(node.videoRenderer);
      for (const child of Object.values(node)) walkVideos(child);
    };
    walkVideos(data);
  }

  return results;
}

export async function searchYouTubeInnerTubeWeb(
  query,
  { limit = 12, offset = 0, timeoutMs = 8000, fetchImpl = globalThis.fetch } = {}
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl("https://www.youtube.com/youtubei/v1/search?prettyPrint=false", {
      method: "POST",
      headers: {
        ...COMMON_HEADERS,
        "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
        "Content-Type": "application/json",
        Origin: "https://www.youtube.com",
        Referer: "https://www.youtube.com/",
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "WEB",
            clientVersion: "2.20250101.00.00",
            hl: "vi",
            gl: "VN",
          },
        },
        query,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`YouTube InnerTube Web phản hồi ${res.status}`);
    const data = await res.json();
    return parseYouTubeWebResults(data, { limit, offset });
  } finally {
    clearTimeout(timer);
  }
}

const PIPED_SEARCH_ENDPOINTS = [
  "https://pipedapi.kavin.rocks/search",
  "https://api.piped.private.coffee/search",
];

export async function searchYouTubePipedFallback(
  query,
  { limit = 12, offset = 0, timeoutMs = 5000, fetchImpl = globalThis.fetch } = {}
) {
  const skipCount = Math.max(0, parseInt(offset, 10) || 0);
  for (const endpoint of PIPED_SEARCH_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const params = new URLSearchParams({ q: query, filter: "music_songs" });
      const res = await fetchImpl(`${endpoint}?${params}`, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) continue;
      const data = await res.json();
      const items = Array.isArray(data?.items) ? data.items : [];
      const results = [];
      const seen = new Set();
      let skipped = 0;
      for (const item of items) {
        const rawUrl = String(item?.url || "");
        const idMatch = rawUrl.match(/[?&]v=([A-Za-z0-9_-]{11})/) || rawUrl.match(/\/([A-Za-z0-9_-]{11})$/);
        const videoId = idMatch?.[1] || "";
        if (!isValidYouTubeVideoId(videoId) || seen.has(videoId)) continue;
        seen.add(videoId);
        if (skipped < skipCount) {
          skipped++;
          continue;
        }
        const durSec = Number(item?.duration);
        results.push({
          videoId,
          title: String(item?.title || "").trim() || "(không có tiêu đề)",
          channel: String(item?.uploaderName || "").trim() || "Không rõ",
          duration: Number.isFinite(durSec) && durSec > 0 ? formatSecondsToDuration(durSec) : "",
          thumbnail: sanitizeThumbnail(item?.thumbnail) || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        });
        if (results.length >= limit) break;
      }
      if (results.length > 0) return results;
    } catch {
      // try next endpoint
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
}

export async function searchYouTubeWeb(
  query,
  { limit = 12, offset = 0, timeoutMs = 8000, fetchImpl = globalThis.fetch } = {}
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const params = new URLSearchParams({ search_query: query, hl: "vi", gl: "VN" });
    const res = await fetchImpl(`https://www.youtube.com/results?${params}`, {
      headers: {
        ...COMMON_HEADERS,
        "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`YouTube Web phản hồi ${res.status}`);
    const parsed = parseYouTubeWebResults(parseInitialData(await res.text()), { limit, offset });
    if (parsed.length > 0 || fetchImpl !== globalThis.fetch) return parsed;
  } catch (err) {
    if (fetchImpl !== globalThis.fetch) throw err;
  } finally {
    clearTimeout(timer);
  }

  try {
    const innerTubeResults = await searchYouTubeInnerTubeWeb(query, {
      limit,
      offset,
      timeoutMs: Math.min(timeoutMs, 4000),
      fetchImpl,
    });
    if (innerTubeResults.length > 0) return innerTubeResults;
  } catch {}

  try {
    const pipedResults = await searchYouTubePipedFallback(query, {
      limit,
      offset,
      timeoutMs: Math.min(timeoutMs, 3000),
      fetchImpl,
    });
    if (pipedResults.length > 0) return pipedResults;
  } catch {}

  return [];
}

export async function searchYouTubeByMode(
  query,
  {
    mode = "youtube-web",
    limit = 12,
    offset = 0,
    timeoutMs = 8000,
    webSearch = searchYouTubeWeb,
    legacySearch = searchYouTube,
  } = {}
) {
  if (mode === "youtube-music") return legacySearch(query, { limit, offset, timeoutMs });
  try {
    const results = await webSearch(query, { limit, offset, timeoutMs });
    if (results.length) return results;
  } catch {}
  return legacySearch(query, { limit, offset, timeoutMs });
}

// Accept only common YouTube video-link formats. Search, channel, and playlist
// URLs are not song links because the queue requires one specific video.
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
const YOUTUBE_THUMBNAIL_HOSTS = new Set([
  "i.ytimg.com",
  "img.youtube.com",
  "i.scdn.co",
  "mosaic.scdn.co",
  "soundcloud.com",
  "www.soundcloud.com",
]);

export function isValidYouTubeVideoId(value) {
  return typeof value === "string" && YOUTUBE_VIDEO_ID.test(value);
}

export function sanitizeThumbnail(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    const isAllowedImageHost =
      YOUTUBE_THUMBNAIL_HOSTS.has(host) ||
      host.endsWith(".ytimg.com") ||
      host.endsWith(".ggpht.com") ||
      host.endsWith(".googleusercontent.com") ||
      host.endsWith(".scdn.co") ||
      host.endsWith(".spotifycdn.com") ||
      host.endsWith(".sndcdn.com") ||
      host.endsWith(".tiktokcdn.com") ||
      host.endsWith(".tiktokcdn-us.com") ||
      host.endsWith(".byteoversea.com") ||
      host.endsWith(".ibytedtos.com") ||
      host.endsWith(".tiktok.com") ||
      host.endsWith(".tikwm.com") ||
      host === "tikwm.com" ||
      host.endsWith(".bytedance.com");
    if (url.protocol !== "https:" || !isAllowedImageHost) return null;
    const normalized = url.toString();
    return normalized.length <= 2000 ? normalized : null;
  } catch {
    return null;
  }
}

export function parseYouTubeVideoId(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;

  let id = "";
  const host = url.hostname.toLowerCase();
  if (host === "youtu.be") {
    id = url.pathname.split("/").filter(Boolean)[0] || "";
  } else if (url.pathname === "/watch") {
    id = url.searchParams.get("v") || "";
  } else {
    const match = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/);
    id = match?.[1] || "";
  }
  return YOUTUBE_VIDEO_ID.test(id) ? id : null;
}

// oEmbed provides display metadata without a YouTube API key.
export async function fetchYouTubeMetadata(videoId, { timeoutMs = 5000, fetchImpl = globalThis.fetch } = {}) {
  if (!isValidYouTubeVideoId(videoId)) return null;
  const url =
    "https://www.youtube.com/oembed?url=" +
    encodeURIComponent("https://youtu.be/" + videoId) +
    "&format=json";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { "User-Agent": UA }, signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const title = typeof data.title === "string" ? data.title.trim() : "";
    const channel = typeof data.author_name === "string" ? data.author_name.trim() : "";
    if (!title || !channel) return null;
    return {
      videoId,
      title,
      channel,
      duration: "",
      thumbnail: sanitizeThumbnail(data.thumbnail_url) || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSearchData(query, { mode, timeoutMs, fetchImpl = globalThis.fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl("https://music.youtube.com/youtubei/v1/search?prettyPrint=false", {
      method: "POST",
      headers: SEARCH_HEADERS,
      body: JSON.stringify(buildSearchBody(query, { mode })),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`YouTube Music phản hồi ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function searchYouTube(
  query,
  { limit = 12, offset = 0, timeoutMs = 8000, mode = "web", fetchImpl = globalThis.fetch } = {}
) {
  if (mode === "songs") {
    try {
      const data = await fetchSearchData(query, { mode, timeoutMs, fetchImpl });
      const songsResults = parseSearchResults(data, { limit, offset });
      if (songsResults.length > 0 || fetchImpl !== globalThis.fetch) return songsResults;
      const webLikeResults = parseSearchResults(data, { limit, offset, webLike: true });
      if (webLikeResults.length > 0) return webLikeResults;
    } catch (err) {
      if (fetchImpl !== globalThis.fetch) throw err;
    }
    try {
      const webResults = await searchYouTubeWeb(query, { limit, offset, timeoutMs, fetchImpl });
      if (webResults.length > 0) return webResults;
    } catch {}
    return [];
  }

  let primaryResults = [];
  let primaryError;
  try {
    const data = await fetchSearchData(query, { mode: "web", timeoutMs, fetchImpl });
    primaryResults = parseSearchResults(data, { limit, offset, webLike: true });
  } catch (err) {
    primaryError = err;
  }

  if (primaryResults.length >= limit) return primaryResults;

  try {
    const fallbackData = await fetchSearchData(query, { mode: "songs", timeoutMs, fetchImpl });
    const fallbackResults = parseSearchResults(fallbackData, { limit, offset });
    const merged = mergeSearchResults(primaryResults, fallbackResults, limit);
    if (merged.length > 0 || fetchImpl !== globalThis.fetch) return merged;
  } catch {
    if (fetchImpl !== globalThis.fetch) {
      if (primaryError && primaryResults.length === 0) throw primaryError;
      return primaryResults;
    }
  }

  if (primaryResults.length === 0 && fetchImpl === globalThis.fetch) {
    try {
      const webFallback = await searchYouTubeWeb(query, { limit, offset, timeoutMs, fetchImpl });
      if (webFallback.length > 0) return webFallback;
    } catch {}
    if (primaryError) throw primaryError;
  }
  return primaryResults;
}

// YouTube Music exposes the country chart page through this browse contract.
// The page returns the current chart playlist for the selected country.
const VIETNAM_CHART_BROWSE_ID = "FEmusic_charts";
const VIETNAM_CHART_COUNTRY = "VN";

function browseSections(data) {
  return (
    data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content
      ?.sectionListRenderer?.contents ||
    data?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents?.sectionListRenderer
      ?.contents ||
    []
  );
}

function chartPlaylistBrowseId(data) {
  for (const section of browseSections(data)) {
    for (const item of section?.musicCarouselShelfRenderer?.contents || []) {
      const renderer = item?.musicTwoRowItemRenderer;
      const browseId =
        renderer?.navigationEndpoint?.browseEndpoint?.browseId ||
        renderer?.onTap?.innertubeCommand?.browseEndpoint?.browseId;
      if (browseId?.startsWith("VLPL")) return browseId;
    }
  }
  return null;
}

async function browseYouTubeMusic(body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let data;
  try {
    const res = await fetch("https://music.youtube.com/youtubei/v1/browse?prettyPrint=false", {
      method: "POST",
      headers: {
        ...COMMON_HEADERS,
        "Content-Type": "application/json",
        Origin: "https://music.youtube.com",
        Referer: "https://music.youtube.com/",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`YouTube Music phản hồi ${res.status}`);
    data = await res.json();
  } finally {
    clearTimeout(timer);
  }
  return data;
}

// Load the current Vietnam chart playlist and return music video items in the
// same shape as searchYouTube(). The chart page is queried first so its
// rotating playlist ID does not need to be hard-coded in the application.
export async function fetchVietnamChartHits({ limit = 40, timeoutMs = 8000 } = {}) {
  try {
    const chartData = await browseYouTubeMusic(
      {
        context: {
          client: {
            clientName: "WEB_REMIX",
            clientVersion: "1.20250101.01.00",
            hl: "en",
            gl: VIETNAM_CHART_COUNTRY,
          },
        },
        browseId: VIETNAM_CHART_BROWSE_ID,
        formData: { selectedValues: [VIETNAM_CHART_COUNTRY] },
      },
      timeoutMs
    );
    const playlistBrowseId = chartPlaylistBrowseId(chartData);
    if (playlistBrowseId) {
      const data = await browseYouTubeMusic(
        {
          context: {
            client: {
              clientName: "WEB_REMIX",
              clientVersion: "1.20250101.01.00",
              hl: "en",
              gl: VIETNAM_CHART_COUNTRY,
            },
          },
          browseId: playlistBrowseId,
        },
        timeoutMs
      );

      const sections = browseSections(data);

      const results = [];
      for (const section of sections) {
        for (const item of section?.musicPlaylistShelfRenderer?.contents || []) {
          const r = item.musicResponsiveListItemRenderer;
          const videoId = r?.playlistItemData?.videoId;
          if (!videoId) continue;
          const cols = (r.flexColumns || []).map(
            (c) => c.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []
          );
          results.push({
            videoId,
            title: cols[0]?.map((run) => run.text).join("") || "(không có tiêu đề)",
            channel: cols[1]?.[0]?.text || "Không rõ",
            duration:
              r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]
                ?.text || "",
            thumbnail: pickThumbnail(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails),
          });
          if (results.length >= limit) return results;
        }
      }
      if (results.length > 0) return results;
    }
  } catch {}

  try {
    const fallbackSongs = await searchYouTube("nhạc trẻ thịnh hành việt nam", {
      limit,
      timeoutMs,
      mode: "songs",
    });
    if (fallbackSongs.length > 0) return fallbackSongs;
  } catch {}

  return [];
}

// Return { ok: true } when the video exists and is public, or
// { ok: false, reason } for a deleted, private, or missing video ID.
export async function checkPlayable(videoId, { timeoutMs = 5000 } = {}) {
  const url =
    "https://www.youtube.com/oembed?url=" +
    encodeURIComponent("https://youtu.be/" + videoId) +
    "&format=json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: controller.signal });
    if (res.status === 200) return { ok: true };
    if (res.status === 401) return { ok: false, reason: "Video này đã tắt tính năng nhúng." };
    if (res.status === 404 || res.status === 400)
      return { ok: false, reason: "Video này ở chế độ riêng tư, đã bị xóa hoặc không tồn tại." };
    return { ok: false, reason: `Không thể phát video này (trạng thái ${res.status}).` };
  } catch (err) {
    // Temporary network failure — allow the request and let the host player be
    // the fallback.
    return { ok: true, soft: true, note: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// Extract richer metadata from the watch page for moderation context: category
// (whether it is Music), YouTube's isFamilySafe flag, and the description.
// Return null on failure; callers must treat this as best-effort data.
export async function fetchVideoDetails(videoId, { timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://www.youtube.com/watch?v=" + videoId, {
      headers: COMMON_HEADERS,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});(?:var|<\/script>)/s);
    if (!m) return null;
    const data = JSON.parse(m[1]);
    const vd = data.videoDetails || {};
    const mf = data.microformat?.playerMicroformatRenderer || {};
    const lengthSeconds = parseInt(vd.lengthSeconds || mf.lengthSeconds, 10);
    return {
      author: vd.author || "",
      category: mf.category || "",
      isFamilySafe: mf.isFamilySafe,
      description: (vd.shortDescription || "").slice(0, 500),
      durationSeconds: Number.isFinite(lengthSeconds) && lengthSeconds > 0 ? lengthSeconds : null,
      duration: Number.isFinite(lengthSeconds) && lengthSeconds > 0 ? formatSecondsToDuration(lengthSeconds) : "",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
