import { describe, it, expect } from "bun:test";
import {
  formatDurationSeconds,
  cleanTikTokTitle,
  fetchTikTokMetadata,
  deleteCachedTikTokMetadata,
  clearTikTokCache,
} from "../src/tiktok.js";

describe("TikTok Metadata & Duration Resolution", () => {
  it("formatDurationSeconds formats seconds properly", () => {
    expect(formatDurationSeconds(0)).toBe("0:30");
    expect(formatDurationSeconds(15)).toBe("0:15");
    expect(formatDurationSeconds(65)).toBe("1:05");
    expect(formatDurationSeconds(125)).toBe("2:05");
  });

  it("prioritizes music_info.duration over video duration when present", async () => {
    clearTikTokCache();
    const mockJson = {
      code: 0,
      data: {
        id: "7123456789",
        title: "Funny moments #comedy #viral",
        duration: 60, // Video duration: 60s
        music_info: {
          title: "Catchy Song",
          author: "Singer Name",
          duration: 25, // Actual music duration: 25s
          play: "https://example.com/audio.mp3",
        },
        music: "https://example.com/audio.mp3",
        cover: "https://example.com/cover.jpg",
      },
    };

    const mockFetch = async () => ({
      ok: true,
      json: async () => mockJson,
    });

    const meta = await fetchTikTokMetadata("https://www.tiktok.com/@user/video/7123456789", {
      fetchImpl: mockFetch,
    });

    expect(meta).not.toBeNull();
    expect(meta.title).toBe("Catchy Song");
    expect(meta.channel).toBe("Singer Name");
    expect(meta.musicDurationSec).toBe(25);
    expect(meta.videoDurationSec).toBe(60);
    expect(meta.durationSec).toBe(25);
    expect(meta.duration).toBe("0:25");
    expect(meta.streamKind).toBe("music");
    expect(meta.streamUrl).toBe("https://example.com/audio.mp3");
  });

  it("falls back to video duration when music_info.duration is 0 or absent", async () => {
    clearTikTokCache();
    const mockJson = {
      code: 0,
      data: {
        id: "7987654321",
        title: "Daily Vlog @friend",
        duration: 42,
        music_info: {
          title: "original sound",
          duration: 0,
        },
        play: "https://example.com/video.mp4",
        cover: "https://example.com/cover2.jpg",
      },
    };

    const mockFetch = async () => ({
      ok: true,
      json: async () => mockJson,
    });

    const meta = await fetchTikTokMetadata("https://www.tiktok.com/@user/video/7987654321", {
      fetchImpl: mockFetch,
    });

    expect(meta).not.toBeNull();
    expect(meta.musicDurationSec).toBe(0);
    expect(meta.videoDurationSec).toBe(42);
    expect(meta.durationSec).toBe(42);
    expect(meta.duration).toBe("0:42");
    expect(meta.streamKind).toBe("video");
    expect(meta.streamUrl).toBe("https://example.com/video.mp4");
  });

  it("deleteCachedTikTokMetadata removes item from cache", async () => {
    clearTikTokCache();
    const url = "https://www.tiktok.com/@user/video/7111111111";
    let fetchCount = 0;
    const mockFetch = async () => {
      fetchCount++;
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            id: "7111111111",
            title: "Test Video",
            duration: 30,
            music: "https://example.com/audio.mp3",
          },
        }),
      };
    };

    const meta1 = await fetchTikTokMetadata(url, { fetchImpl: mockFetch });
    expect(fetchCount).toBe(1);

    // Second call hits cache
    const meta2 = await fetchTikTokMetadata(url, { fetchImpl: mockFetch });
    expect(fetchCount).toBe(1);

    // Invalidate cache
    deleteCachedTikTokMetadata(url);

    // Third call re-fetches
    const meta3 = await fetchTikTokMetadata(url, { fetchImpl: mockFetch });
    expect(fetchCount).toBe(2);
  });
});
