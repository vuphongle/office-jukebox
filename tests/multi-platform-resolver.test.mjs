import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  parseSpotifyTrackId,
  isValidSpotifyTrackId,
  formatDurationMs,
  fetchSpotifyTrackMetadata,
} from "../src/spotify.js";
import {
  parseSoundCloudUrl,
  isValidSoundCloudUrl,
  cleanSoundCloudTitle,
  fetchSoundCloudMetadata,
} from "../src/soundcloud.js";
import {
  detectLinkProvider,
  resolveMediaLink,
} from "../src/mediaLinkResolver.js";

describe("Spotify URL parsing and metadata", () => {
  test("parses standard, intl, and uri spotify links", () => {
    const id = "4cOdK2wGLETKBW3PvgPWqT";
    assert.equal(parseSpotifyTrackId(`https://open.spotify.com/track/${id}`), id);
    assert.equal(parseSpotifyTrackId(`https://open.spotify.com/track/${id}?si=abcdef123456`), id);
    assert.equal(parseSpotifyTrackId(`https://open.spotify.com/intl-vi/track/${id}?si=abcdef`), id);
    assert.equal(parseSpotifyTrackId(`spotify:track:${id}`), id);
    assert.equal(parseSpotifyTrackId(id), id);
  });

  test("rejects invalid spotify links", () => {
    assert.equal(parseSpotifyTrackId("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"), null);
    assert.equal(parseSpotifyTrackId("https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb"), null);
    assert.equal(parseSpotifyTrackId("https://example.com/track/4cOdK2wGLETKBW3PvgPWqT"), null);
    assert.equal(parseSpotifyTrackId("invalid-track-id"), null);
  });

  test("formats duration in milliseconds to M:SS", () => {
    assert.equal(formatDurationMs(210_000), "3:30");
    assert.equal(formatDurationMs(65_000), "1:05");
    assert.equal(formatDurationMs(0), "3:30");
  });

  test("fetches metadata using mock Web API", async () => {
    const mockFetch = async (url) => {
      if (url.includes("/v1/tracks/")) {
        return {
          ok: true,
          json: async () => ({
            name: "Never Gonna Give You Up",
            artists: [{ name: "Rick Astley" }],
            duration_ms: 213000,
            album: { images: [{ url: "https://i.scdn.co/image/ab67616d0000b273test" }] },
          }),
        };
      }
      return { ok: false, status: 404 };
    };

    const song = await fetchSpotifyTrackMetadata("4cOdK2wGLETKBW3PvgPWqT", {
      accessToken: "mock-token",
      fetchImpl: mockFetch,
    });
    assert.ok(song);
    assert.equal(song.videoId, "4cOdK2wGLETKBW3PvgPWqT");
    assert.equal(song.title, "Never Gonna Give You Up");
    assert.equal(song.channel, "Rick Astley");
    assert.equal(song.provider, "spotify");
  });
});

describe("SoundCloud URL parsing and metadata", () => {
  test("parses standard and short soundcloud links", () => {
    const url = "https://soundcloud.com/artist-name/track-title";
    assert.equal(parseSoundCloudUrl(url), "https://soundcloud.com/artist-name/track-title");
    assert.equal(parseSoundCloudUrl("https://soundcloud.com/artist-name/track-title?si=6e5e0366990b451e899926c20cc3648f&utm_source=clipboard"), "https://soundcloud.com/artist-name/track-title");
    assert.equal(parseSoundCloudUrl("https://on.soundcloud.com/xyz123"), "https://on.soundcloud.com/xyz123");
  });

  test("rejects invalid or reserved soundcloud links", () => {
    assert.equal(parseSoundCloudUrl("https://soundcloud.com/discover"), null);
    assert.equal(parseSoundCloudUrl("https://soundcloud.com/stream"), null);
    assert.equal(parseSoundCloudUrl("https://soundcloud.com/only-one-segment"), null);
    assert.equal(parseSoundCloudUrl("https://other-site.com/artist/track"), null);
  });

  test("cleans up redundant artist prefixes and promo suffixes", () => {
    assert.equal(cleanSoundCloudTitle("Artist - Song Title [Free Download]", "Artist"), "Song Title");
    assert.equal(cleanSoundCloudTitle("Artist : Song Title (Out Now)", "Artist"), "Song Title");
    assert.equal(cleanSoundCloudTitle("Normal Song", "Artist"), "Normal Song");
  });

  test("fetches metadata using mock oEmbed", async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        title: "Chill Lofi Beat",
        author_name: "Lofi Producer",
        thumbnail_url: "https://i1.sndcdn.com/artworks-test.jpg",
      }),
    });

    const song = await fetchSoundCloudMetadata("https://soundcloud.com/producer/chill-lofi", {
      fetchImpl: mockFetch,
    });
    assert.ok(song);
    assert.equal(song.title, "Chill Lofi Beat");
    assert.equal(song.channel, "Lofi Producer");
    assert.equal(song.provider, "soundcloud");
  });
});

describe("Unified media link detection and resolution", () => {
  test("detects link provider accurately", () => {
    assert.equal(detectLinkProvider("https://youtu.be/dQw4w9WgXcQ"), "youtube");
    assert.equal(detectLinkProvider("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "youtube");
    assert.equal(detectLinkProvider("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"), "spotify");
    assert.equal(detectLinkProvider("https://soundcloud.com/artist/song"), "soundcloud");
    assert.equal(detectLinkProvider("https://unknown-site.com/media/123"), "unknown");
  });

  test("resolves YouTube link preserving 100% YouTube metadata shape", async () => {
    const mockFetchYouTube = async (videoId) => ({
      videoId,
      title: "YouTube Song Title",
      channel: "YouTube Channel",
      duration: "3:45",
      thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    });

    const res = await resolveMediaLink("https://youtu.be/dQw4w9WgXcQ", {
      fetchYouTube: mockFetchYouTube,
    });
    assert.ok(res.ok);
    assert.equal(res.song.videoId, "dQw4w9WgXcQ");
    assert.equal(res.song.title, "YouTube Song Title");
    assert.equal(res.song.channel, "YouTube Channel");
    assert.equal(res.song.provider, "youtube");
  });

  test("resolves Spotify link directly with spotify provider", async () => {
    const mockFetch = async (url) => {
      if (url.includes("/v1/tracks/")) {
        return {
          ok: true,
          json: async () => ({
            name: "Spotify Track",
            artists: [{ name: "Artist One" }, { name: "Artist Two" }],
            duration_ms: 180000,
            album: { images: [{ url: "https://spotify.thumb/img.jpg" }] },
          }),
        };
      }
      return { ok: false };
    };

    const res = await resolveMediaLink("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT", {
      spotifyConfig: { accessToken: "valid-token" },
      fetchImpl: mockFetch,
    });

    assert.ok(res.ok);
    assert.equal(res.song.videoId, "4cOdK2wGLETKBW3PvgPWqT");
    assert.equal(res.song.title, "Spotify Track");
    assert.equal(res.song.channel, "Artist One, Artist Two");
    assert.equal(res.song.provider, "spotify");
  });

  test("rejects unsupported URLs with friendly message", async () => {
    const res = await resolveMediaLink("https://vimeo.com/12345678");
    assert.equal(res.ok, false);
    assert.ok(res.reason.includes("YouTube, Spotify"));
  });
});
