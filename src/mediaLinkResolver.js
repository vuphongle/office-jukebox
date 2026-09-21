// Multi-platform media link detection and metadata resolution.
// Strictly maintains 100% backward compatibility for YouTube links while adding
// direct support for Spotify and SoundCloud.

import { parseYouTubeVideoId, fetchYouTubeMetadata } from "./youtube.js";
import { parseSpotifyTrackId, fetchSpotifyTrackMetadata } from "./spotify.js";
import { parseSoundCloudUrl, fetchSoundCloudMetadata } from "./soundcloud.js";

export function detectLinkProvider(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return "unknown";
  const trimmed = rawUrl.trim();

  if (parseYouTubeVideoId(trimmed)) return "youtube";
  if (parseSpotifyTrackId(trimmed)) return "spotify";
  if (parseSoundCloudUrl(trimmed)) return "soundcloud";

  return "unknown";
}

export async function resolveMediaLink(
  rawUrl,
  {
    fetchYouTube = fetchYouTubeMetadata,
    spotifyConfig = {},
    fetchImpl = globalThis.fetch,
  } = {}
) {
  const provider = detectLinkProvider(rawUrl);

  if (provider === "youtube") {
    const videoId = parseYouTubeVideoId(rawUrl);
    if (!videoId) {
      return { ok: false, reason: "Link YouTube không đúng định dạng." };
    }
    const song = await fetchYouTube(videoId);
    if (!song) {
      return { ok: false, reason: "Không thể lấy thông tin video này. Vui lòng thử lại." };
    }
    return {
      ok: true,
      song: {
        ...song,
        provider: "youtube",
      },
    };
  }

  if (provider === "spotify") {
    const trackId = parseSpotifyTrackId(rawUrl);
    if (!trackId) {
      return { ok: false, reason: "Link Spotify không đúng định dạng." };
    }
    const song = await fetchSpotifyTrackMetadata(trackId, {
      clientId: spotifyConfig.clientId,
      clientSecret: spotifyConfig.clientSecret,
      accessToken: spotifyConfig.accessToken,
      fetchImpl,
    });
    if (!song) {
      return { ok: false, reason: "Không thể lấy thông tin bài hát Spotify này. Vui lòng thử lại." };
    }
    return {
      ok: true,
      song: {
        ...song,
        provider: "spotify",
      },
    };
  }

  if (provider === "soundcloud") {
    const trackUrl = parseSoundCloudUrl(rawUrl);
    if (!trackUrl) {
      return { ok: false, reason: "Link SoundCloud không đúng định dạng." };
    }
    const song = await fetchSoundCloudMetadata(trackUrl, { fetchImpl });
    if (!song) {
      return { ok: false, reason: "Không thể lấy thông tin bài hát SoundCloud này. Vui lòng thử lại." };
    }
    return {
      ok: true,
      song: {
        ...song,
        provider: "soundcloud",
      },
    };
  }

  return {
    ok: false,
    reason: "Hiện tại hệ thống chỉ hỗ trợ link YouTube, Spotify và SoundCloud.",
  };
}
