import { test, describe, expect, beforeEach } from "bun:test";
import { searchSpotifyTracks, resetSpotifyRateLimits } from "../src/spotify.js";

describe("searchSpotifyTracks", () => {
  beforeEach(() => {
    resetSpotifyRateLimits();
  });
  test("returns empty array when query is empty or whitespace", async () => {
    const res1 = await searchSpotifyTracks("");
    expect(res1).toEqual([]);

    const res2 = await searchSpotifyTracks("   ");
    expect(res2).toEqual([]);
  });

  test("throws when no token or credentials provided", async () => {
    expect(searchSpotifyTracks("son tung")).rejects.toThrow("Spotify credentials or access token required");
  });

  test("queries Spotify Search API and maps tracks accurately", async () => {
    const mockTracks = [
      {
        id: "4cOdK2wGLETKBW3PvgPWqT",
        name: "Chung Ta Cua Tuong Lai",
        artists: [{ name: "Son Tung M-TP" }],
        duration_ms: 254000,
        album: {
          images: [
            { url: "https://i.scdn.co/image/ab67616d0000b273thumb1" },
            { url: "https://i.scdn.co/image/ab67616d00001e02thumb2" },
          ],
        },
      },
      {
        id: "11dFghVXANMlKmJXsNCbNl",
        name: "Cat Doi Noi Sau",
        artists: [{ name: "Tang Duy Tan" }, { name: "Drum7" }],
        duration_ms: 180000,
        album: {
          images: [{ url: "https://i.scdn.co/image/catdoi" }],
        },
      },
    ];

    let capturedUrl = "";
    let capturedHeaders = null;

    const mockFetch = async (url, options) => {
      capturedUrl = url;
      capturedHeaders = options.headers;
      return {
        ok: true,
        json: async () => ({
          tracks: {
            items: mockTracks,
          },
        }),
      };
    };

    const results = await searchSpotifyTracks("son tung", {
      accessToken: "mock_token_123",
      fetchImpl: mockFetch,
    });

    expect(capturedUrl).toContain("https://api.spotify.com/v1/search?");
    expect(capturedUrl).toContain("q=son+tung");
    expect(capturedUrl).toContain("type=track");
    expect(capturedUrl).toContain("market=VN");
    expect(capturedHeaders.Authorization).toBe("Bearer mock_token_123");

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      videoId: "4cOdK2wGLETKBW3PvgPWqT",
      title: "Chung Ta Cua Tuong Lai",
      channel: "Son Tung M-TP",
      artists: ["Son Tung M-TP"],
      duration: "4:14",
      durationMs: 254000,
      thumbnail: "https://i.scdn.co/image/ab67616d0000b273thumb1",
      provider: "spotify",
    });

    expect(results[1]).toEqual({
      videoId: "11dFghVXANMlKmJXsNCbNl",
      title: "Cat Doi Noi Sau",
      channel: "Tang Duy Tan, Drum7",
      artists: ["Tang Duy Tan", "Drum7"],
      duration: "3:00",
      durationMs: 180000,
      thumbnail: "https://i.scdn.co/image/catdoi",
      provider: "spotify",
    });
  });

  test("handles Spotify API error response cleanly when no credentials to fallback", async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 401,
      text: async () => "The access token expired",
    });

    expect(
      searchSpotifyTracks("test", {
        accessToken: "expired_token",
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow("Spotify search API error (401)");
  });

  test("retries with client credentials token when accessToken gets 401", async () => {
    let callCount = 0;
    const mockFetch = async (url, options) => {
      if (url.includes("accounts.spotify.com/api/token")) {
        return {
          ok: true,
          json: async () => ({ access_token: "new_client_token", expires_in: 3600 }),
        };
      }
      if (url.includes("api.spotify.com/v1/search")) {
        callCount++;
        if (callCount === 1) {
          expect(options.headers.Authorization).toBe("Bearer expired_token");
          return {
            ok: false,
            status: 401,
            text: async () => "expired",
          };
        }
        expect(options.headers.Authorization).toBe("Bearer new_client_token");
        return {
          ok: true,
          json: async () => ({
            tracks: {
              items: [
                {
                  id: "4cOdK2wGLETKBW3PvgPWqT",
                  name: "Fallback Track",
                  artists: [{ name: "Artist" }],
                  duration_ms: 120000,
                  album: { images: [] },
                },
              ],
            },
          }),
        };
      }
      throw new Error("unexpected URL: " + url);
    };

    const results = await searchSpotifyTracks("test", {
      accessToken: "expired_token",
      clientId: "client_id",
      clientSecret: "client_secret",
      fetchImpl: mockFetch,
    });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Fallback Track");
  });

  test("respects limit option capped at 10 tracks for search API safety", async () => {
    let capturedUrl = "";
    const mockFetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ tracks: { items: [] } }),
      };
    };

    await searchSpotifyTracks("v-pop", {
      accessToken: "mock_token",
      limit: 10,
      fetchImpl: mockFetch,
    });

    expect(capturedUrl).toContain("limit=10");

    await searchSpotifyTracks("v-pop", {
      accessToken: "mock_token",
      limit: 50,
      fetchImpl: mockFetch,
    });
    // Values above 10 are capped at 10 to prevent Spotify API 400 Invalid limit error
    expect(capturedUrl).toContain("limit=10");
  });

  test("supports offset parameter for pagination", async () => {
    let capturedUrl = "";
    const mockFetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ tracks: { items: [] } }),
      };
    };

    await searchSpotifyTracks("v-pop", {
      accessToken: "mock_token",
      offset: 20,
      fetchImpl: mockFetch,
    });

    expect(capturedUrl).toContain("offset=20");
  });

  test("automatically falls back to backup credentials when primary credential hits 429 rate limit", async () => {
    const primaryAuth = Buffer.from("primary_id:primary_secret").toString("base64");
    const backupAuth = Buffer.from("backup_id:backup_secret").toString("base64");
    const attemptedTokens = [];

    const mockFetch = async (url, options = {}) => {
      if (url.includes("accounts.spotify.com/api/token")) {
        const auth = options.headers?.Authorization;
        if (auth === `Basic ${primaryAuth}`) {
          return {
            ok: true,
            json: async () => ({ access_token: "token_primary", expires_in: 3600 }),
          };
        }
        if (auth === `Basic ${backupAuth}`) {
          return {
            ok: true,
            json: async () => ({ access_token: "token_backup", expires_in: 3600 }),
          };
        }
        return { ok: false, status: 400, text: async () => "bad credentials" };
      }

      if (url.includes("api.spotify.com/v1/search")) {
        const token = options.headers?.Authorization;
        attemptedTokens.push(token);

        if (token === "Bearer token_primary") {
          return {
            ok: false,
            status: 429,
            headers: new Headers({ "retry-after": "3600" }),
            text: async () => "Too Many Requests (Quota Exceeded)",
          };
        }

        if (token === "Bearer token_backup") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              tracks: {
                items: [
                  {
                    id: "4cOdK2wGLETKBW3PvgPWqT",
                    name: "Backup Track Found",
                    artists: [{ name: "Backup Artist" }],
                    duration_ms: 210000,
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

    const results = await searchSpotifyTracks("query test", {
      clientId: "primary_id",
      clientSecret: "primary_secret",
      backupClientId: "backup_id",
      backupClientSecret: "backup_secret",
      fetchImpl: mockFetch,
    });

    expect(attemptedTokens).toContain("Bearer token_primary");
    expect(attemptedTokens).toContain("Bearer token_backup");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Backup Track Found");
  });

  test("throws 429 when both primary and backup credentials hit rate limit", async () => {
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
        return {
          ok: false,
          status: 429,
          headers: new Headers({ "retry-after": "3600" }),
          text: async () => "Too Many Requests",
        };
      }

      throw new Error("unexpected URL " + url);
    };

    await expect(
      searchSpotifyTracks("test", {
        clientId: "primary_id",
        clientSecret: "primary_secret",
        credentialsPool: [
          { clientId: "primary_id", clientSecret: "primary_secret", label: "primary" },
          { clientId: "backup_id", clientSecret: "backup_secret", label: "backup" },
        ],
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow(/429/);
  });
});


