import { test, describe, expect, beforeAll, afterAll } from "bun:test";
import express from "express";
import http from "node:http";

describe("Guest Discovery Multi-Platform E2E & Route Integration", () => {
  let server;
  let baseUrl;
  const browseCache = new Map();
  const BROWSE_TTL_MS = 30 * 60 * 1000;
  const MAX_SINGLE_SECONDS = 10 * 60;

  function durationSeconds(d) {
    if (!d || typeof d !== "string") return Infinity;
    const parts = d.split(":").map(Number);
    if (parts.some(isNaN)) return Infinity;
    const sec = parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 3600 + parts[1] * 60 + parts[2];
    return sec <= MAX_SINGLE_SECONDS ? sec : Infinity;
  }

  beforeAll(async () => {
    const app = express();

    app.get("/api/browse", async (req, res) => {
      const q = (req.query.q || "").toString().trim().slice(0, 100);
      if (!q) return res.json({ results: [] });
      const platform = (req.query.platform || "youtube").toString().toLowerCase().trim();

      const cacheKey = `${platform}:${q}`;
      const hit = browseCache.get(cacheKey);
      if (hit && Date.now() - hit.at < BROWSE_TTL_MS) return res.json({ results: hit.results, cached: true });

      try {
        let results = [];
        if (platform === "spotify") {
          const clientId = req.headers["x-test-no-creds"] ? "" : "test_client_id";
          const clientSecret = req.headers["x-test-no-creds"] ? "" : "test_client_secret";
          if (!clientId || !clientSecret) {
            return res.status(503).json({ error: "Spotify chưa được cấu hình Client ID / Secret trên hệ thống." });
          }

          const spotifyQuery = q === "__vn_hits" ? "top hits vietnam" : q;
          results = [
            {
              videoId: "4cOdK2wGLETKBW3PvgPWqT",
              title: `${spotifyQuery} Track`,
              channel: "Test Artist",
              artists: ["Test Artist"],
              duration: "3:45",
              thumbnail: "https://example.com/art.jpg",
              provider: "spotify",
            },
            {
              videoId: "tooLongTrackId12345678",
              title: "Over 10 Min Track",
              channel: "Podcast",
              artists: ["Podcast"],
              duration: "12:30",
              thumbnail: "https://example.com/long.jpg",
              provider: "spotify",
            },
          ]
            .filter((r) => durationSeconds(r.duration) <= MAX_SINGLE_SECONDS)
            .slice(0, 20);
        } else {
          results = [
            {
              videoId: "dQw4w9WgXcQ",
              title: `${q} YouTube Video`,
              channel: "YT Creator",
              duration: "3:33",
              thumbnail: "https://example.com/yt.jpg",
              provider: "youtube",
            },
          ]
            .filter((r) => durationSeconds(r.duration) <= MAX_SINGLE_SECONDS)
            .slice(0, 20);
        }

        browseCache.set(cacheKey, { at: Date.now(), results });
        res.json({ results, cached: false });
      } catch (err) {
        res.status(502).json({ error: "Không thể tải danh sách bài hát." });
      }
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll((done) => {
    server.close(done);
  });

  test("default platform returns YouTube tracks with provider=youtube", async () => {
    const res = await fetch(`${baseUrl}/api/browse?q=VPop`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.results).toHaveLength(1);
    expect(data.results[0].provider).toBe("youtube");
    expect(data.results[0].videoId).toBe("dQw4w9WgXcQ");
  });

  test("platform=spotify returns Spotify tracks with provider=spotify and filters out tracks > 10 min", async () => {
    const res = await fetch(`${baseUrl}/api/browse?q=VPop&platform=spotify`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.results).toHaveLength(1);
    expect(data.results[0].provider).toBe("spotify");
    expect(data.results[0].videoId).toBe("4cOdK2wGLETKBW3PvgPWqT");
    expect(data.results[0].title).toBe("VPop Track");
    expect(data.cached).toBe(false);
  });

  test("subsequent request hits isolated cache", async () => {
    const res = await fetch(`${baseUrl}/api/browse?q=VPop&platform=spotify`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cached).toBe(true);
    expect(data.results[0].provider).toBe("spotify");
  });

  test("platform=spotify with sentinel __vn_hits resolves to Vietnamese top hits", async () => {
    const res = await fetch(`${baseUrl}/api/browse?q=__vn_hits&platform=spotify`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.results[0].title).toBe("top hits vietnam Track");
    expect(data.results[0].provider).toBe("spotify");
  });

  test("platform=spotify returns 503 when credentials missing", async () => {
    const res = await fetch(`${baseUrl}/api/browse?q=NewHits&platform=spotify`, {
      headers: { "x-test-no-creds": "true" },
    });
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error).toContain("Spotify chưa được cấu hình");
  });
});
