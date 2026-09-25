import { test, describe, expect, beforeEach } from "bun:test";
import { searchSpotifyTracks, isArtistMatch, searchSpotifyArtistTracks, resetSpotifyRateLimits } from "../src/spotify.js";

describe("Spotify Browse Logic & Filtering", () => {
  beforeEach(() => {
    resetSpotifyRateLimits();
  });
  test("filters out Spotify tracks longer than 10 minutes", () => {
    const mockTracks = [
      { id: "1", durationMs: 200000, duration: "3:20" },
      { id: "2", durationMs: 700000, duration: "11:40" },
      { id: "3", durationMs: 300000, duration: "5:00" },
    ];
    const MAX_SECONDS = 10 * 60;
    const filtered = mockTracks.filter((t) => t.durationMs / 1000 <= MAX_SECONDS);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((t) => t.id)).toEqual(["1", "3"]);
  });

  test("cache keys isolate spotify and youtube queries", () => {
    const cache = new Map();
    const query = "VPop";
    cache.set(`youtube:${query}`, { results: [{ title: "YT Song", provider: "youtube" }] });
    cache.set(`spotify:${query}`, { results: [{ title: "Spotify Song", provider: "spotify" }] });

    expect(cache.get(`youtube:${query}`).results[0].title).toBe("YT Song");
    expect(cache.get(`youtube:${query}`).results[0].provider).toBe("youtube");
    expect(cache.get(`spotify:${query}`).results[0].title).toBe("Spotify Song");
    expect(cache.get(`spotify:${query}`).results[0].provider).toBe("spotify");
  });

  test("sentinel __vn_hits maps to top hits vietnam for Spotify", async () => {
    let capturedQuery = "";
    const mockFetch = async (url) => {
      capturedQuery = new URL(url).searchParams.get("q");
      return {
        ok: true,
        json: async () => ({ tracks: { items: [] } }),
      };
    };

    const resolvedQuery = "__vn_hits" === "__vn_hits" ? "top hits vietnam" : "__vn_hits";
    await searchSpotifyTracks(resolvedQuery, {
      accessToken: "mock_token",
      fetchImpl: mockFetch,
    });

    expect(capturedQuery).toBe("top hits vietnam");
  });

  test("missing spotify credentials returns 503 error contract", () => {
    const checkCredentials = (clientId, clientSecret) => {
      if (!clientId || !clientSecret) {
        return { status: 503, error: "Spotify chưa được cấu hình Client ID / Secret trên hệ thống." };
      }
      return { status: 200 };
    };

    expect(checkCredentials("", "")).toEqual({
      status: 503,
      error: "Spotify chưa được cấu hình Client ID / Secret trên hệ thống.",
    });
    expect(checkCredentials("client_id", "")).toEqual({
      status: 503,
      error: "Spotify chưa được cấu hình Client ID / Secret trên hệ thống.",
    });
    expect(checkCredentials("client_id", "client_secret")).toEqual({
      status: 200,
    });
  });

  test("spotify browse maps tracks with provider=spotify and required metadata", async () => {
    const mockTracks = [
      {
        id: "4cOdK2wGLETKBW3PvgPWqT",
        name: "Test Song",
        artists: [{ name: "Artist One" }, { name: "Artist Two" }],
        duration_ms: 210000,
        album: { images: [{ url: "https://example.com/cover.jpg" }] },
      },
    ];

    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ tracks: { items: mockTracks } }),
    });

    const results = await searchSpotifyTracks("test", {
      accessToken: "mock_token",
      limit: 20,
      fetchImpl: mockFetch,
    });

    expect(results).toHaveLength(1);
    expect(results[0].provider).toBe("spotify");
    expect(results[0].videoId).toBe("4cOdK2wGLETKBW3PvgPWqT");
    expect(results[0].title).toBe("Test Song");
    expect(results[0].channel).toBe("Artist One, Artist Two");
    expect(results[0].artists).toEqual(["Artist One", "Artist Two"]);
    expect(results[0].duration).toBe("3:30");
    expect(results[0].thumbnail).toBe("https://example.com/cover.jpg");
  });

  test("isArtistMatch correctly matches artists while rejecting partial substring collisions", () => {
    // Single word artists
    expect(isArtistMatch("AMEE", "AMEE")).toBe(true);
    expect(isArtistMatch("amee", "AMEE")).toBe(true);
    expect(isArtistMatch("Karol G", "AMEE")).toBe(false);
    expect(isArtistMatch("MONO", "MONO")).toBe(true);
    expect(isArtistMatch("Monochrome", "MONO")).toBe(false);

    // MIN disambiguation tests
    expect(isArtistMatch("MIN", "MIN")).toBe(true);
    expect(isArtistMatch("min", "MIN")).toBe(true);
    expect(isArtistMatch("Min Quỳnh Anh", "MIN")).toBe(false);
    expect(isArtistMatch("Min Cho", "MIN")).toBe(false);

    // Multi word and accents
    expect(isArtistMatch("Sơn Tùng M-TP", "Sơn Tùng M-TP")).toBe(true);
    expect(isArtistMatch("Son Tung M-TP", "Sơn Tùng M-TP")).toBe(true);
    expect(isArtistMatch("Sơn Tùng MTP", "Sơn Tùng M-TP")).toBe(true);
    expect(isArtistMatch("Low G", "Low G")).toBe(true);
    expect(isArtistMatch("everlow", "Low G")).toBe(false);
    expect(isArtistMatch("Vũ.", "Vũ.")).toBe(true);
    expect(isArtistMatch("Vu", "Vũ.")).toBe(true);
    expect(isArtistMatch("Thái Vũ", "Vũ.")).toBe(true);
    expect(isArtistMatch("Vũ Cát Tường", "Vũ.")).toBe(false);
    expect(isArtistMatch("Hoà Minzy", "Hòa Minzy")).toBe(true);

    // Artist Aliases
    expect(isArtistMatch("MCK", "RPT MCK")).toBe(true);
    expect(isArtistMatch("RPT MCK", "MCK")).toBe(true);
    expect(isArtistMatch("Soobin Hoàng Sơn", "SOOBIN")).toBe(true);
    expect(isArtistMatch("SOOBIN", "Soobin Hoàng Sơn")).toBe(true);
    expect(isArtistMatch("G-IDLE", "(G)I-DLE")).toBe(true);
    expect(isArtistMatch("GIDLE", "(G)I-DLE")).toBe(true);
    expect(isArtistMatch("TOMORROW X TOGETHER", "TXT")).toBe(true);
    expect(isArtistMatch("The Black Eyed Peas", "Black Eyed Peas")).toBe(true);
  });

  test("searchSpotifyArtistTracks strictly excludes tracks where artist is not performed by target", async () => {
    const mockTracks = [
      {
        id: "4cOdK2wGLETKBW3PvgPWqT",
        name: "trời giấu trời mang đi",
        artists: [{ name: "AMEE" }],
        duration_ms: 210000,
      },
      {
        id: "11dFghVXANMlKmJXsNCbNl",
        name: "Amiga Mía",
        artists: [{ name: "KAROL G" }, { name: "Greeicy" }],
        duration_ms: 190000,
      },
      {
        id: "0VjIjW4GlUZAMYd2vXMi3b",
        name: "MỘNG YU",
        artists: [{ name: "AMEE" }, { name: "RPT MCK" }],
        duration_ms: 200000,
      },
    ];

    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ tracks: { items: mockTracks } }),
    });

    const results = await searchSpotifyArtistTracks("AMEE", {
      accessToken: "mock_token",
      limit: 10,
      fetchImpl: mockFetch,
    });

    expect(results).toHaveLength(2);
    expect(results[0].title).toBe("trời giấu trời mang đi");
    expect(results[1].title).toBe("MỘNG YU");
    expect(results.some((r) => r.title === "Amiga Mía")).toBe(false);
  });

  test("cleanTrackTitle normalizes remix, acoustic, and reissue suffixes for deduplication", async () => {
    const { cleanTrackTitle } = await import("../src/spotify.js");
    expect(cleanTrackTitle("Love Story (Taylor’s Version)")).toBe("love story");
    expect(cleanTrackTitle("Love Story")).toBe("love story");
    expect(cleanTrackTitle("Nơi Này Có Anh - Acoustic Version")).toBe("noi nay co anh");
    expect(cleanTrackTitle("Nơi Này Có Anh")).toBe("noi nay co anh");
    expect(cleanTrackTitle("Đi Để Trở Về 2 - Chuyến Đi Của Năm")).toBe("di de tro ve 2 - chuyen di cua nam");
  });

  test("searchSpotifyArtistTracks paginates and preserves trending hits order across pages", async () => {
    const page0Tracks = [
      { id: "4cOdK2wGLETKBW3PvgPW01", name: "Hit 1", artists: [{ name: "Target Singer" }], duration_ms: 200000 },
      { id: "4cOdK2wGLETKBW3PvgPW02", name: "Hit 2", artists: [{ name: "Target Singer" }], duration_ms: 200000 },
      { id: "4cOdK2wGLETKBW3PvgPW03", name: "Hit 2 - Acoustic", artists: [{ name: "Target Singer" }], duration_ms: 200000 },
      { id: "4cOdK2wGLETKBW3PvgPW04", name: "Hit 3", artists: [{ name: "Target Singer" }], duration_ms: 200000 },
    ];
    const page1Tracks = [
      { id: "4cOdK2wGLETKBW3PvgPW05", name: "Hit 4", artists: [{ name: "Target Singer" }], duration_ms: 200000 },
      { id: "4cOdK2wGLETKBW3PvgPW06", name: "Hit 5", artists: [{ name: "Target Singer" }], duration_ms: 200000 },
    ];

    const mockFetch = async (url) => {
      const u = new URL(url);
      const offset = parseInt(u.searchParams.get("offset") || "0", 10);
      const items = offset === 0 ? page0Tracks : page1Tracks;
      return {
        ok: true,
        json: async () => ({ tracks: { items } }),
      };
    };

    // Page 0 with limit 2
    const p0 = await searchSpotifyArtistTracks("Target Singer", {
      accessToken: "mock_token",
      offset: 0,
      limit: 2,
      fetchImpl: mockFetch,
    });
    expect(p0).toHaveLength(2);
    expect(p0[0].title).toBe("Hit 1");
    expect(p0[1].title).toBe("Hit 2");

    // Page 1 with offset 2, limit 2: Hit 2 - Acoustic is deduplicated against Hit 2, so next are Hit 3 and Hit 4!
    const p1 = await searchSpotifyArtistTracks("Target Singer", {
      accessToken: "mock_token",
      offset: 2,
      limit: 2,
      fetchImpl: mockFetch,
    });
    expect(p1).toHaveLength(2);
    expect(p1[0].title).toBe("Hit 3");
    expect(p1[1].title).toBe("Hit 4");
  });

  test("ARTIST_AVATARS contains official Spotify CDN images for all top singers", async () => {
    const { ARTIST_AVATARS } = await import("../src/artistAvatars.js");
    expect(Object.keys(ARTIST_AVATARS).length).toBeGreaterThanOrEqual(80);
    expect(ARTIST_AVATARS["Sơn Tùng M-TP"]).toMatch(/^https:\/\/i\.scdn\.co\/image\//);
    expect(ARTIST_AVATARS["AMEE"]).toMatch(/^https:\/\/i\.scdn\.co\/image\//);
    expect(ARTIST_AVATARS["HIEUTHUHAI"]).toMatch(/^https:\/\/i\.scdn\.co\/image\//);
    expect(ARTIST_AVATARS["NewJeans"]).toMatch(/^https:\/\/i\.scdn\.co\/image\//);
  });

  test("searchSpotifyTracks passes offset and limit to Spotify search API", async () => {
    let capturedOffset = "";
    let capturedLimit = "";
    const mockFetch = async (url) => {
      const u = new URL(url);
      capturedOffset = u.searchParams.get("offset");
      capturedLimit = u.searchParams.get("limit");
      return {
        ok: true,
        json: async () => ({ tracks: { items: [] } }),
      };
    };

    await searchSpotifyTracks("top hits vietnam", {
      accessToken: "mock_token",
      offset: 20,
      limit: 10,
      fetchImpl: mockFetch,
    });

    expect(capturedOffset).toBe("20");
    expect(capturedLimit).toBe("10");
  });

  test("searchSpotifyArtistTracks matches tracks using artist aliases", async () => {
    const mockTracks = [
      { id: "4cOdK2wGLETKBW3PvgPW01", name: "Chìm Sâu", artists: [{ name: "MCK" }], duration_ms: 180000 },
      { id: "4cOdK2wGLETKBW3PvgPW02", name: "Phía Sau Một Cô Gái", artists: [{ name: "Soobin Hoàng Sơn" }], duration_ms: 240000 },
      { id: "4cOdK2wGLETKBW3PvgPW03", name: "Queencard", artists: [{ name: "GIDLE" }], duration_ms: 170000 },
    ];
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ tracks: { items: mockTracks } }),
    });

    const mckResults = await searchSpotifyArtistTracks("RPT MCK", {
      accessToken: "mock_token",
      limit: 10,
      fetchImpl: mockFetch,
    });
    expect(mckResults.some((t) => t.title === "Chìm Sâu")).toBe(true);

    const soobinResults = await searchSpotifyArtistTracks("SOOBIN", {
      accessToken: "mock_token",
      limit: 10,
      fetchImpl: mockFetch,
    });
    expect(soobinResults.some((t) => t.title === "Phía Sau Một Cô Gái")).toBe(true);

    const gidleResults = await searchSpotifyArtistTracks("(G)I-DLE", {
      accessToken: "mock_token",
      limit: 10,
      fetchImpl: mockFetch,
    });
    expect(gidleResults.some((t) => t.title === "Queencard")).toBe(true);
  });

  test("searchSpotifyArtistTracks propagates 429 error when Spotify rate-limits", async () => {
    const mock429Fetch = async () => ({
      ok: false,
      status: 429,
      text: async () => "Too Many Requests",
    });

    await expect(
      searchSpotifyArtistTracks("Unknown Artist", {
        accessToken: "mock_token",
        limit: 10,
        fetchImpl: mock429Fetch,
      })
    ).rejects.toThrow(/429/);
  });

  test("searchSpotifyArtistTracks falls back to backup credentials when primary hits 429", async () => {
    const primaryAuth = Buffer.from("primary_id:primary_secret").toString("base64");
    const backupAuth = Buffer.from("backup_id:backup_secret").toString("base64");

    const mockFetch = async (url, options = {}) => {
      if (url.includes("accounts.spotify.com/api/token")) {
        const auth = options.headers?.Authorization;
        if (auth === `Basic ${primaryAuth}`) {
          return { ok: true, json: async () => ({ access_token: "token_primary", expires_in: 3600 }) };
        }
        if (auth === `Basic ${backupAuth}`) {
          return { ok: true, json: async () => ({ access_token: "token_backup", expires_in: 3600 }) };
        }
      }

      if (url.includes("api.spotify.com/v1/search")) {
        const token = options.headers?.Authorization;
        if (token === "Bearer token_primary") {
          return {
            ok: false,
            status: 429,
            headers: new Headers({ "retry-after": "3600" }),
            text: async () => "Too Many Requests",
          };
        }
        if (token === "Bearer token_backup") {
          return {
            ok: true,
            json: async () => ({
              tracks: {
                items: [
                  {
                    id: "4cOdK2wGLETKBW3PvgPWqT",
                    name: "Hit Bài Hát",
                    artists: [{ name: "Ca Sĩ A" }],
                    duration_ms: 180000,
                    album: { images: [] },
                  },
                ],
              },
            }),
          };
        }
      }

      throw new Error("unexpected URL " + url);
    };

    const results = await searchSpotifyArtistTracks("Ca Sĩ A", {
      clientId: "primary_id",
      clientSecret: "primary_secret",
      backupClientId: "backup_id",
      backupClientSecret: "backup_secret",
      fetchImpl: mockFetch,
    });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Hit Bài Hát");
  });
});



