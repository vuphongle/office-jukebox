import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  isValidTikTokUrl,
  parseTikTokUrl,
  formatDurationSeconds,
  cleanTikTokTitle,
  fetchTikTokMetadata,
  getCachedTikTokMetadata,
  setCachedTikTokMetadata,
  clearTikTokCache,
} from "../src/tiktok.js";

describe("TikTok URL validation and parsing", () => {
  test("validates various TikTok URL formats correctly", () => {
    // Mobile shortlinks
    assert.equal(isValidTikTokUrl("https://vt.tiktok.com/ZSjR3kX7L/"), true);
    assert.equal(isValidTikTokUrl("https://vm.tiktok.com/ZMxxxxxx/"), true);
    assert.equal(isValidTikTokUrl("https://t.tiktok.com/ZTxxxxxx/"), true);

    // Standard video URLs
    assert.equal(
      isValidTikTokUrl("https://www.tiktok.com/@scout2015/video/6718335390845095173"),
      true
    );
    assert.equal(
      isValidTikTokUrl("https://tiktok.com/@user.name/video/1234567890123456789"),
      true
    );
    assert.equal(
      isValidTikTokUrl("https://www.tiktok.com/@user/photo/1234567890123456789"),
      true
    );
    assert.equal(isValidTikTokUrl("https://m.tiktok.com/v/6718335390845095173.html"), true);

    // URLs with query parameters
    assert.equal(
      isValidTikTokUrl("https://vt.tiktok.com/ZSjR3kX7L/?is_from_webapp=1&sender_device=pc"),
      true
    );
    assert.equal(
      isValidTikTokUrl("https://www.tiktok.com/@user/video/6718335390845095173?_t=8xxxx&_r=1"),
      true
    );
  });

  test("rejects invalid or non-TikTok URLs", () => {
    assert.equal(isValidTikTokUrl(""), false);
    assert.equal(isValidTikTokUrl("not a url"), false);
    assert.equal(isValidTikTokUrl("https://youtube.com/watch?v=123"), false);
    assert.equal(isValidTikTokUrl("https://tiktok.com/"), false);
    assert.equal(isValidTikTokUrl("https://www.tiktok.com/@scout2015"), false);
    assert.equal(isValidTikTokUrl("https://fake-tiktok.com/video/123"), false);
  });

  test("parses and normalizes TikTok URLs cleanly", () => {
    assert.equal(
      parseTikTokUrl("https://vt.tiktok.com/ZSjR3kX7L/?param=123"),
      "https://vt.tiktok.com/ZSjR3kX7L"
    );
    assert.equal(
      parseTikTokUrl("https://www.tiktok.com/@user/video/6718335390845095173/"),
      "https://www.tiktok.com/@user/video/6718335390845095173"
    );
  });
});

describe("TikTok duration formatting and title cleaning", () => {
  test("formats duration seconds properly", () => {
    assert.equal(formatDurationSeconds(15), "0:15");
    assert.equal(formatDurationSeconds(65), "1:05");
    assert.equal(formatDurationSeconds(125), "2:05");
    assert.equal(formatDurationSeconds(0), "0:30");
    assert.equal(formatDurationSeconds(-5), "0:30");
  });

  test("cleans up video titles and prefers real music sound titles", () => {
    // Prioritizes real music track title over caption
    assert.equal(
      cleanTikTokTitle("Dance dance #fyp #trending", "Cắt Đôi Nỗi Sầu - Tăng Duy Tân", "Artist"),
      "Cắt Đôi Nỗi Sầu - Tăng Duy Tân"
    );

    // If sound is generic original sound, strips hashtags from caption
    assert.equal(
      cleanTikTokTitle("Bài hát hay quá mọi người ơi #xuhuong #fyp #trend", "original sound - user", "user"),
      "Bài hát hay quá mọi người ơi"
    );

    // Falls back to author if everything is blank or empty
    assert.equal(
      cleanTikTokTitle("#fyp #trending", "", "Sơn Tùng"),
      "Âm thanh TikTok của Sơn Tùng"
    );
  });
});

describe("TikTok metadata fetching and caching", () => {
  beforeEach(() => {
    clearTikTokCache();
  });

  test("fetches metadata using mock API responder", async () => {
    const mockFetch = async (url) => {
      if (url.includes("tikwm.com")) {
        return {
          ok: true,
          json: async () => ({
            code: 0,
            msg: "success",
            data: {
              id: "6718335390845095173",
              title: "Check this beat #fyp #trend",
              duration: 25,
              cover: "https://p16.tiktokcdn.com/cover.jpg",
              music: "https://v16.tiktokcdn.com/stream.mp3",
              music_info: {
                title: "See Tình - Hoàng Thùy Linh",
                author: "Hoàng Thùy Linh",
              },
              author: {
                nickname: "Creator",
              },
            },
          }),
        };
      }
      return { ok: false, status: 404 };
    };

    const song = await fetchTikTokMetadata("https://vt.tiktok.com/ZSjR3kX7L/", {
      fetchImpl: mockFetch,
    });

    assert.ok(song);
    assert.equal(song.videoId, "https://vt.tiktok.com/ZSjR3kX7L");
    assert.equal(song.title, "See Tình - Hoàng Thùy Linh");
    assert.equal(song.channel, "Hoàng Thùy Linh");
    assert.equal(song.duration, "0:25");
    assert.equal(song.provider, "tiktok");
    assert.equal(song.streamUrl, "https://v16.tiktokcdn.com/stream.mp3");
  });

  test("uses cached metadata on subsequent calls", async () => {
    const canonical = "https://vt.tiktok.com/ZS_cached";
    const cachedSong = {
      videoId: canonical,
      title: "Cached Song",
      channel: "Cached Artist",
      duration: "0:20",
      thumbnail: "https://thumb.jpg",
      provider: "tiktok",
      streamUrl: "https://audio.mp3",
    };
    setCachedTikTokMetadata(canonical, cachedSong);

    const hit = getCachedTikTokMetadata(canonical);
    assert.deepEqual(hit, cachedSong);

    // Call fetchTikTokMetadata, which should return cached without fetchImpl call
    let fetchCalled = false;
    const song = await fetchTikTokMetadata(canonical, {
      fetchImpl: async () => {
        fetchCalled = true;
        return { ok: false };
      },
    });
    assert.equal(fetchCalled, false);
    assert.equal(song.title, "Cached Song");
  });
});
