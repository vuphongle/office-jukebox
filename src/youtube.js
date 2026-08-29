// Keyless YouTube access:
//  - searchYouTube(): call YouTube Music's internal search API (InnerTube, the
//    same JSON endpoint used by music.youtube.com). Direct search prioritizes
//    web-like context, then supplements results with the "Songs" filter.
//    Discovery tabs use only the "Songs" filter.
//  - checkPlayable(): use the oEmbed endpoint to reject deleted/private videos
//    before queueing. Embed-disabled videos still return 200 here, so the host
//    player also skips iframe error codes 101/150.

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

export function parseSearchResults(data, { limit = 12, webLike = false } = {}) {
  const results = [];
  const seen = new Set();
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

    const duration = byline.map((run) => run.text).filter((text) => /^\d+:\d\d/.test(text)).pop();
    const artistRun = byline.find((run) => run.navigationEndpoint?.browseEndpoint);
    const title = cols[0]?.map((run) => run.text).join("") || "(không có tiêu đề)";
    const channel = artistRun?.text || accessibilityArtist(renderer, title) || byline[0]?.text;
    seen.add(videoId);
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

// Accept only common YouTube video-link formats. Search, channel, and playlist
// URLs are not song links because the queue requires one specific video.
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);

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
  if (!YOUTUBE_VIDEO_ID.test(videoId)) return null;
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
    return {
      videoId,
      title: data.title || "(không có tiêu đề)",
      channel: data.author_name || "Không rõ",
      duration: "",
      thumbnail: data.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
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
  { limit = 12, timeoutMs = 8000, mode = "web", fetchImpl = globalThis.fetch } = {}
) {
  if (mode === "songs") {
    const data = await fetchSearchData(query, { mode, timeoutMs, fetchImpl });
    return parseSearchResults(data, { limit });
  }

  let primaryResults = [];
  let primaryError;
  try {
    const data = await fetchSearchData(query, { mode: "web", timeoutMs, fetchImpl });
    primaryResults = parseSearchResults(data, { limit, webLike: true });
  } catch (err) {
    primaryError = err;
  }

  if (primaryResults.length >= limit) return primaryResults;

  try {
    const fallbackData = await fetchSearchData(query, { mode: "songs", timeoutMs, fetchImpl });
    const fallbackResults = parseSearchResults(fallbackData, { limit });
    return mergeSearchResults(primaryResults, fallbackResults, limit);
  } catch (fallbackError) {
    if (primaryError && primaryResults.length === 0) throw primaryError;
    return primaryResults;
  }
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
  if (!playlistBrowseId) return [];

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
  return results;
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
    return {
      author: vd.author || "",
      category: mf.category || "",
      isFamilySafe: mf.isFamilySafe,
      description: (vd.shortDescription || "").slice(0, 500),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
