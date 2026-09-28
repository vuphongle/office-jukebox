import { test, describe, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  getSpotifyRateLimitStatus,
  isCredentialRateLimited,
  markCredentialRateLimited,
  resetSpotifyRateLimits,
  searchSpotifyTracks,
  fetchSpotifyTrackMetadata,
  refreshSpotifyToken,
} from "../src/spotify.js";

describe("Spotify Real-time Rate Limit & Status UX", () => {
  beforeEach(() => {
    resetSpotifyRateLimits();
  });

  test("getSpotifyRateLimitStatus returns configured: false when credentials pool is empty", () => {
    const status = getSpotifyRateLimitStatus([]);
    expect(status).toEqual({
      configured: false,
      isRateLimited: false,
      resetAt: null,
      retryAfterSeconds: 0,
    });
  });

  test("getSpotifyRateLimitStatus returns isRateLimited: false when credentials pool is active and not rate-limited", () => {
    const pool = [
      { clientId: "cid_1", clientSecret: "csec_1", label: "primary" },
      { clientId: "cid_2", clientSecret: "csec_2", label: "backup" },
    ];
    const status = getSpotifyRateLimitStatus(pool);
    expect(status).toEqual({
      configured: true,
      isRateLimited: false,
      resetAt: null,
      retryAfterSeconds: 0,
    });
  });

  test("getSpotifyRateLimitStatus stays isRateLimited: false when primary is limited but backup is available", () => {
    const pool = [
      { clientId: "cid_1", clientSecret: "csec_1", label: "primary" },
      { clientId: "cid_2", clientSecret: "csec_2", label: "backup" },
    ];
    // Primary is hit with 429
    markCredentialRateLimited("cid_1", 300);

    const status = getSpotifyRateLimitStatus(pool);
    // Since backup credential is functional, Spotify as a whole is NOT rate-limited
    expect(status.configured).toBe(true);
    expect(status.isRateLimited).toBe(false);
    expect(status.resetAt).toBeNull();
    expect(status.retryAfterSeconds).toBe(0);
  });

  test("getSpotifyRateLimitStatus tracks backup resetAt if backup resets earlier than primary", () => {
    const pool = [
      { clientId: "cid_primary", clientSecret: "csec_1", label: "primary" },
      { clientId: "cid_backup", clientSecret: "csec_2", label: "backup" },
    ];
    // Primary has 600s left, backup has 60s left
    markCredentialRateLimited("cid_primary", 600);
    markCredentialRateLimited("cid_backup", 60);

    const status = getSpotifyRateLimitStatus(pool);
    expect(status.configured).toBe(true);
    expect(status.isRateLimited).toBe(true);
    // Earliest reset must track the backup account (~60s), not the primary (~600s)
    expect(status.retryAfterSeconds).toBeGreaterThan(0);
    expect(status.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  test("getSpotifyRateLimitStatus tracks primary resetAt if primary resets earlier than backup", () => {
    const pool = [
      { clientId: "cid_primary", clientSecret: "csec_1", label: "primary" },
      { clientId: "cid_backup", clientSecret: "csec_2", label: "backup" },
    ];
    // Primary has 30s left, backup has 500s left
    markCredentialRateLimited("cid_primary", 30);
    markCredentialRateLimited("cid_backup", 500);

    const status = getSpotifyRateLimitStatus(pool);
    expect(status.configured).toBe(true);
    expect(status.isRateLimited).toBe(true);
    // Earliest reset must track the primary account (~30s)
    expect(status.retryAfterSeconds).toBeGreaterThan(0);
    expect(status.retryAfterSeconds).toBeLessThanOrEqual(30);
  });

  test("when backup credential recovers from rate limit, system recovers to ready even if primary is still limited", async () => {
    const pool = [
      { clientId: "cid_primary_long", clientSecret: "csec_1", label: "primary" },
      { clientId: "cid_backup_fast", clientSecret: "csec_2", label: "backup" },
    ];
    // Primary limited for 1 hour, backup limited for only 1 second
    markCredentialRateLimited("cid_primary_long", 3600);
    markCredentialRateLimited("cid_backup_fast", 1);

    const initialStatus = getSpotifyRateLimitStatus(pool);
    expect(initialStatus.isRateLimited).toBe(true);

    // Wait 1.1s for backup to recover
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const recoveredStatus = getSpotifyRateLimitStatus(pool);
    // Backup is ready -> Spotify search is immediately unblocked!
    expect(recoveredStatus.isRateLimited).toBe(false);
    expect(recoveredStatus.resetAt).toBeNull();
    expect(recoveredStatus.retryAfterSeconds).toBe(0);
  });

  test("searchSpotifyTracks uses backup credential when primary hits 429 and keeps pool rateLimit false", async () => {
    const pool = [
      { clientId: "cid_p", clientSecret: "sec_p", label: "primary" },
      { clientId: "cid_b", clientSecret: "sec_b", label: "backup" },
    ];

    let primaryCalled = false;
    let backupCalled = false;

    const mockFetch = async (url, options = {}) => {
      if (url.includes("/api/token")) {
        const body = String(options.body || "");
        const auth = String(options.headers?.Authorization || "");
        const credBase64 = auth.replace("Basic ", "");
        const credDecoded = Buffer.from(credBase64, "base64").toString();

        if (credDecoded.startsWith("cid_p:")) {
          primaryCalled = true;
          // Primary account token returns 429
          return {
            ok: false,
            status: 429,
            headers: { get: (h) => (h.toLowerCase() === "retry-after" ? "300" : null) },
            text: async () => "Rate limit exceeded",
          };
        }

        if (credDecoded.startsWith("cid_b:")) {
          backupCalled = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: "backup_token_123", expires_in: 3600 }),
          };
        }
      }

      if (url.includes("/v1/search")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tracks: {
              items: [
                {
                  id: "4cOdK2wGLETKBW3PvgPWqT",
                  name: "Backup Song",
                  artists: [{ name: "Backup Artist" }],
                  duration_ms: 180000,
                  album: { images: [] },
                },
              ],
            },
          }),
        };
      }

      return { ok: false, status: 404 };
    };

    const results = await searchSpotifyTracks("test query", {
      credentialsPool: pool,
      fetchImpl: mockFetch,
    });

    expect(primaryCalled).toBe(true);
    expect(backupCalled).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Backup Song");

    // Realtime rate limit status must STILL be false because backup succeeded!
    const status = getSpotifyRateLimitStatus(pool);
    expect(status.isRateLimited).toBe(false);
  });

  test("fetchSpotifyTrackMetadata uses backup credential when primary hits 429 and succeeds", async () => {
    const pool = [
      { clientId: "cid_primary_meta", clientSecret: "sec_p", label: "primary" },
      { clientId: "cid_backup_meta", clientSecret: "sec_b", label: "backup" },
    ];

    let primaryAttempts = 0;
    let backupAttempts = 0;

    const mockFetch = async (url, options = {}) => {
      if (url.includes("/api/token")) {
        const auth = String(options.headers?.Authorization || "");
        const credDecoded = Buffer.from(auth.replace("Basic ", ""), "base64").toString();

        if (credDecoded.startsWith("cid_primary_meta:")) {
          primaryAttempts++;
          return {
            ok: false,
            status: 429,
            headers: { get: (h) => (h.toLowerCase() === "retry-after" ? "300" : null) },
            text: async () => "Rate limit exceeded",
          };
        }

        if (credDecoded.startsWith("cid_backup_meta:")) {
          backupAttempts++;
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: "backup_token_meta_xyz", expires_in: 3600 }),
          };
        }
      }

      if (url.includes("/v1/tracks/")) {
        const authHeader = options.headers?.Authorization || "";
        expect(authHeader).toBe("Bearer backup_token_meta_xyz");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: "Chung Ta Cua Tuong Lai",
            duration_ms: 254000,
            artists: [{ name: "Son Tung M-TP" }],
            album: { images: [{ url: "https://i.scdn.co/image/meta_img" }] },
          }),
        };
      }

      return { ok: false, status: 404 };
    };

    const track = await fetchSpotifyTrackMetadata("4cOdK2wGLETKBW3PvgPWqT", {
      credentialsPool: pool,
      fetchImpl: mockFetch,
    });

    expect(primaryAttempts).toBe(1);
    expect(backupAttempts).toBe(1);
    expect(track).not.toBeNull();
    expect(track.videoId).toBe("4cOdK2wGLETKBW3PvgPWqT");
    expect(track.title).toBe("Chung Ta Cua Tuong Lai");
    expect(track.channel).toBe("Son Tung M-TP");
    expect(track.provider).toBe("spotify");

    // Primary must now be marked rate limited
    expect(isCredentialRateLimited("cid_primary_meta")).toBe(true);

    // Rate limit status of pool remains healthy (isRateLimited: false) because backup is operational
    const status = getSpotifyRateLimitStatus(pool);
    expect(status.isRateLimited).toBe(false);
  });

  test("subsequent API calls skip primary credential immediately while primary is in 429 cooldown", async () => {
    const pool = [
      { clientId: "cid_primary_cool", clientSecret: "sec_p", label: "primary" },
      { clientId: "cid_backup_cool", clientSecret: "sec_b", label: "backup" },
    ];

    // Mark primary as rate-limited (300 seconds cooldown)
    markCredentialRateLimited("cid_primary_cool", 300);

    let primaryCalled = false;
    let backupCalled = false;

    const mockFetch = async (url, options = {}) => {
      if (url.includes("/api/token")) {
        const auth = String(options.headers?.Authorization || "");
        const credDecoded = Buffer.from(auth.replace("Basic ", ""), "base64").toString();

        if (credDecoded.startsWith("cid_primary_cool:")) {
          primaryCalled = true;
          return { ok: false, status: 429, headers: { get: () => "300" } };
        }

        if (credDecoded.startsWith("cid_backup_cool:")) {
          backupCalled = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: "backup_token_direct", expires_in: 3600 }),
          };
        }
      }

      if (url.includes("/v1/search")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tracks: {
              items: [
                {
                  id: "4cOdK2wGLETKBW3PvgPWqT",
                  name: "Fast Fallback Track",
                  artists: [{ name: "Fast Artist" }],
                  duration_ms: 200000,
                  album: { images: [] },
                },
              ],
            },
          }),
        };
      }

      return { ok: false, status: 404 };
    };

    const results = await searchSpotifyTracks("query while primary limited", {
      credentialsPool: pool,
      fetchImpl: mockFetch,
    });

    // Primary was completely skipped without unnecessary requests
    expect(primaryCalled).toBe(false);
    expect(backupCalled).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Fast Fallback Track");
  });

  test("Host primary OAuth token refresh succeeds even when primary search credential is in 429 cooldown", async () => {
    const primaryClientId = "cid_primary_playback";
    const primaryClientSecret = "sec_primary_playback";

    // Simulate primary client credential being rate limited on search/metadata APIs
    markCredentialRateLimited(primaryClientId, 300);
    expect(isCredentialRateLimited(primaryClientId)).toBe(true);

    let refreshCalledWithPrimary = false;

    const mockFetch = async (url, options = {}) => {
      if (url.includes("/api/token")) {
        const body = String(options.body || "");
        const auth = String(options.headers?.Authorization || "");
        const credDecoded = Buffer.from(auth.replace("Basic ", ""), "base64").toString();

        if (body.includes("grant_type=refresh_token") && credDecoded === `${primaryClientId}:${primaryClientSecret}`) {
          refreshCalledWithPrimary = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "mock_refreshed_primary_user_token_999",
              expires_in: 3600,
              token_type: "Bearer",
              scope: "streaming user-modify-playback-state",
            }),
          };
        }
      }
      return { ok: false, status: 404 };
    };

    // Host refreshes user token via refreshSpotifyToken using the primary Host credentials
    const tokenResult = await refreshSpotifyToken("host_primary_refresh_token_xyz", {
      clientId: primaryClientId,
      clientSecret: primaryClientSecret,
      fetchImpl: mockFetch,
    });

    expect(refreshCalledWithPrimary).toBe(true);
    expect(tokenResult.access_token).toBe("mock_refreshed_primary_user_token_999");
  });

  test("Host playback (playSpotify) succeeds on primary device using primary user token while search pool uses fallback", async () => {
    // 1. Simulate state where primary search credential is in 429 rate limit cooldown
    const primaryClientId = "cid_primary_for_host";
    markCredentialRateLimited(primaryClientId, 300);
    expect(isCredentialRateLimited(primaryClientId)).toBe(true);

    // 2. Setup Host DOM & VM environment
    const elements = new Map();
    class MockElement {
      constructor() {
        const classes = new Set(["hidden"]);
        this.classList = {
          add: (...names) => names.forEach((n) => classes.add(n)),
          remove: (...names) => names.forEach((n) => classes.delete(n)),
          contains: (n) => classes.has(n),
          toggle: (name, force) =>
            force === undefined
              ? (classes.has(name) ? (classes.delete(name), false) : (classes.add(name), true))
              : (force ? classes.add(name) : classes.delete(name), force),
        };
        this.style = { setProperty() {} };
        this.children = [];
        this.dataset = {};
        this.listeners = new Map();
      }
      addEventListener(name, handler) {
        const list = this.listeners.get(name) || [];
        list.push(handler);
        this.listeners.set(name, list);
      }
      removeEventListener(name, handler) {
        const list = this.listeners.get(name) || [];
        this.listeners.set(name, list.filter((h) => h !== handler));
      }
      appendChild(c) { this.children.push(c); }
      querySelector() { return null; }
      querySelectorAll() { return []; }
    }

    const getElementById = (id) => {
      if (!elements.has(id)) elements.set(id, new MockElement());
      return elements.get(id);
    };

    const fetchCalls = [];
    const spotifyListeners = new Map();
    const spotifyPlayer = {
      addListener(name, handler) {
        const list = spotifyListeners.get(name) || [];
        list.push(handler);
        spotifyListeners.set(name, list);
      },
      removeListener() {},
      connect: () => Promise.resolve(true),
      seek: () => Promise.resolve(true),
      activateElement: () => Promise.resolve(),
      resume: () => Promise.resolve(),
    };

    const context = vm.createContext({
      window: {
        addEventListener() {},
        removeEventListener() {},
        Spotify: { Player: function () { return spotifyPlayer; } },
      },
      navigator: { onLine: true },
      document: {
        hidden: false,
        activeElement: null,
        addEventListener() {},
        createElement: () => new MockElement(),
        getElementById,
        querySelectorAll: () => [],
      },
      Element: MockElement,
      WebSocket: class {
        readyState = 1;
        send() {}
      },
      YT: {
        PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3 },
        Player: function () { return {}; },
      },
      location: { protocol: "http:", host: "localhost" },
      fetch: async (url, options = {}) => {
        fetchCalls.push({ url, options });
        if (url === "/api/spotify/token") {
          // Returns Host's primary user OAuth token
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, access_token: "primary_host_user_oauth_token_abc" }),
          };
        }
        if (url.includes("/api/info")) {
          return { ok: true, status: 200, json: async () => ({ guestUrl: "http://localhost/guest", qr: "qr" }) };
        }
        if (url.includes("https://api.spotify.com/v1/me/player/play")) {
          // Spotify Web API executes play command on primary host player
          return { ok: true, status: 204 };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
      crypto: { randomUUID: () => "test-uuid" },
      console,
      clearTimeout,
      setTimeout,
      clearInterval() {},
      setInterval: () => 1,
      requestAnimationFrame: (cb) => setTimeout(cb, 20),
      cancelAnimationFrame: (id) => clearTimeout(id),
      performance: { now: () => Date.now() },
    });
    context.globalThis = context;

    const source = readFileSync(new URL("../public/host.js", import.meta.url), "utf8");
    vm.runInContext(source, context);

    // Initialize Spotify Web Playback SDK on Host
    context.window.onSpotifyWebPlaybackSDKReady();
    const onReady = spotifyListeners.get("ready")?.[0];
    expect(onReady).toBeDefined();

    // Host player is ready with device ID
    onReady({ device_id: "spotify-primary-device-id-123" });

    // Host starts playback of a track
    vm.runInContext(
      'started = true; latestState = { nowPlaying: { videoId: "4cOdK2wGLETKBW3PvgPWqT", provider: "spotify", playbackToken: "token-p1" }, queue: [] }; syncPlayer();',
      context
    );

    // Wait a brief tick for async playSpotify to resolve
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify /api/spotify/token was fetched
    const tokenCall = fetchCalls.find((c) => c.url === "/api/spotify/token");
    expect(tokenCall).toBeDefined();

    // Verify Spotify Web API play was called with primary user token and primary device ID
    const playCall = fetchCalls.find((c) => c.url.includes("/v1/me/player/play"));
    expect(playCall).toBeDefined();
    expect(playCall.url).toContain("device_id=spotify-primary-device-id-123");
    expect(playCall.options.headers.Authorization).toBe("Bearer primary_host_user_oauth_token_abc");

    const playBody = JSON.parse(playCall.options.body);
    expect(playBody.uris).toEqual(["spotify:track:4cOdK2wGLETKBW3PvgPWqT"]);
  });

  test("End-to-End: Primary hits 429 -> Search API uses fallback -> Song selected -> Playback succeeds on Primary", async () => {
    // 1. Credentials pool
    const pool = [
      { clientId: "cid_primary_e2e", clientSecret: "sec_p_e2e", label: "primary" },
      { clientId: "cid_backup_e2e", clientSecret: "sec_b_e2e", label: "backup" },
    ];

    let primarySearchAttempts = 0;
    let backupSearchAttempts = 0;
    const recordedEvents = [];

    // Unified fetch mock representing the whole distributed interaction
    const mockFetch = async (url, options = {}) => {
      // Client Credentials token (Search & Metadata)
      if (url.includes("/api/token")) {
        const body = String(options.body || "");
        const auth = String(options.headers?.Authorization || "");
        const credDecoded = Buffer.from(auth.replace("Basic ", ""), "base64").toString();

        if (body.includes("grant_type=client_credentials")) {
          if (credDecoded.startsWith("cid_primary_e2e:")) {
            primarySearchAttempts++;
            recordedEvents.push("search_token_primary_429");
            return {
              ok: false,
              status: 429,
              headers: { get: (h) => (h.toLowerCase() === "retry-after" ? "300" : null) },
              text: async () => "Rate limit exceeded on primary app",
            };
          }
          if (credDecoded.startsWith("cid_backup_e2e:")) {
            backupSearchAttempts++;
            recordedEvents.push("search_token_backup_200");
            return {
              ok: true,
              status: 200,
              json: async () => ({ access_token: "backup_search_access_token_777", expires_in: 3600 }),
            };
          }
        }
      }

      // Spotify Search endpoint
      if (url.includes("/v1/search")) {
        const authHeader = options.headers?.Authorization || "";
        expect(authHeader).toBe("Bearer backup_search_access_token_777");
        recordedEvents.push("search_api_via_backup");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tracks: {
              items: [
                {
                  id: "4cOdK2wGLETKBW3PvgPWqT",
                  name: "Chung Ta Cua Tuong Lai",
                  artists: [{ name: "Son Tung M-TP" }],
                  duration_ms: 254000,
                  album: { images: [{ url: "https://i.scdn.co/image/e2e_thumb" }] },
                },
              ],
            },
          }),
        };
      }

      return { ok: false, status: 404 };
    };

    // Step A: Search query while primary is 429
    const searchResults = await searchSpotifyTracks("Chung Ta Cua Tuong Lai", {
      credentialsPool: pool,
      fetchImpl: mockFetch,
    });

    expect(primarySearchAttempts).toBe(1);
    expect(backupSearchAttempts).toBe(1);
    expect(searchResults).toHaveLength(1);
    expect(searchResults[0].videoId).toBe("4cOdK2wGLETKBW3PvgPWqT");
    expect(recordedEvents).toContain("search_token_primary_429");
    expect(recordedEvents).toContain("search_token_backup_200");
    expect(recordedEvents).toContain("search_api_via_backup");

    // Pool rate limit remains unblocked for users
    const rateLimitStatus = getSpotifyRateLimitStatus(pool);
    expect(rateLimitStatus.isRateLimited).toBe(false);

    // Step B: Song is added to queue, now Host plays it via primary account
    const selectedTrack = searchResults[0];

    const hostFetchCalls = [];
    const hostFetchMock = async (url, options = {}) => {
      hostFetchCalls.push({ url, options });
      if (url === "/api/spotify/token") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, access_token: "primary_host_premium_user_token" }),
        };
      }
      if (url.includes("/v1/me/player/play")) {
        return { ok: true, status: 204 };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    // Simulate Host player running playSpotify
    let spotifyDeviceId = "spotify-host-primary-device-999";
    const tokenRes = await hostFetchMock("/api/spotify/token");
    const tokenData = await tokenRes.json();
    expect(tokenData.ok).toBe(true);
    expect(tokenData.access_token).toBe("primary_host_premium_user_token");

    const playRes = await hostFetchMock(`https://api.spotify.com/v1/me/player/play?device_id=${spotifyDeviceId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        uris: [`spotify:track:${selectedTrack.videoId}`],
      }),
    });

    expect(playRes.status).toBe(204);
    const hostPlayCall = hostFetchCalls.find((c) => c.url.includes("/v1/me/player/play"));
    expect(hostPlayCall).toBeDefined();
    expect(hostPlayCall.options.headers.Authorization).toBe("Bearer primary_host_premium_user_token");
    expect(JSON.parse(hostPlayCall.options.body).uris).toEqual(["spotify:track:4cOdK2wGLETKBW3PvgPWqT"]);
  });
});

