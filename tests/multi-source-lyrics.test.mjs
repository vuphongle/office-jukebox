import { describe, it, expect } from "bun:test";
import { fetchLyrics, clearLyricsCache } from "../src/lyricsService.js";

describe("Multi-Source Lyrics Pipeline Orchestrator", () => {
  clearLyricsCache();

  it("prioritizes YouTube Creator Captions when platform is youtube and video has human captions", async () => {
    const mockFetch = async (url, options) => {
      // YouTube InnerTube
      if (url.includes("youtubei/v1/player")) {
        return {
          ok: true,
          json: async () => ({
            captions: {
              playerCaptionsTracklistRenderer: {
                captionTracks: [
                  { languageCode: "vi", vssId: ".vi", baseUrl: "https://www.youtube.com/api/timedtext?v=yt12345&lang=vi" },
                ],
              },
            },
          }),
        };
      }
      if (url.startsWith("https://www.youtube.com/api/timedtext")) {
        return {
          ok: true,
          text: async () => `<timedtext format="3"><body><p t="2000" d="3000">Lời từ YouTube Creator</p></body></timedtext>`,
        };
      }
      throw new Error("LRCLIB should not be called when YouTube creator captions succeed: " + url);
    };

    const res = await fetchLyrics("Đất Phương Nam", "Hương Lan", 240, {
      platform: "youtube",
      videoId: "yt12345",
      fetchImpl: mockFetch,
    });

    expect(res.ok).toBe(true);
    expect(res.source).toBe("youtube_captions");
    expect(res.lines[0].text).toBe("Lời từ YouTube Creator");
  });

  it("skips YouTube captions and uses LRCLIB when YouTube only has auto-generated ASR", async () => {
    const mockFetch = async (url) => {
      if (url.includes("youtubei/v1/player")) {
        return {
          ok: true,
          json: async () => ({
            captions: {
              playerCaptionsTracklistRenderer: {
                captionTracks: [
                  { languageCode: "en", vssId: "a.en", kind: "asr", baseUrl: "https://yt/asr" },
                ],
              },
            },
          }),
        };
      }
      if (url.includes("lrclib.net/api/get")) {
        return {
          ok: true,
          json: async () => ({
            trackName: "Shape of You",
            artistName: "Ed Sheeran",
            duration: 233,
            syncedLyrics: "[00:10.00]The club isn't the best place",
          }),
        };
      }
      throw new Error("unexpected url " + url);
    };

    const res = await fetchLyrics("Shape of You", "Ed Sheeran", 233, {
      platform: "youtube",
      videoId: "ytAsrOnly",
      fetchImpl: mockFetch,
    });

    expect(res.ok).toBe(true);
    expect(res.source).toBe("lrclib");
    expect(res.lines[0].text).toContain("The club isn't the best place");
  });

  it("falls back to Zing MP3 when LRCLIB has no matching version (e.g. Út Trà Ôn 6:30)", async () => {
    const mockFetch = async (url) => {
      // LRCLIB returns mismatched 147s remix
      if (url.includes("lrclib.net/api/get")) {
        return { ok: false, status: 404 };
      }
      if (url.includes("lrclib.net/api/search")) {
        return {
          ok: true,
          json: async () => [
            {
              trackName: "Tình Anh Bán Chiếu",
              artistName: "Thanh Duy",
              duration: 147,
              syncedLyrics: "[00:10.00]Remix 147s",
            },
          ],
        };
      }
      // Zing MP3 returns full 390s version
      if (url.includes("ac.zingmp3.vn")) {
        return {
          ok: true,
          json: async () => ({
            data: {
              items: [
                {
                  suggestions: [
                    {
                      title: "Tình Anh Bán Chiếu",
                      duration: 390,
                      lyricLink: "https://static-zmp3.zmdcdn.me/lyrics/ut-tra-on-390.lrc",
                      artists: [{ name: "Út Trà Ôn" }],
                    },
                  ],
                },
              ],
            },
          }),
        };
      }
      if (url.includes("ut-tra-on-390.lrc")) {
        return {
          ok: true,
          text: async () => `[00:00.00]Hò ơi
[00:05.00]Chiếu Cà Mau nhuộm màu tươi thắm
[06:20.00]Tình anh bán chiếu trọn đời không phai`,
        };
      }
      throw new Error("unexpected url " + url);
    };

    const res = await fetchLyrics("Tình Anh Bán Chiếu", "Út Trà Ôn", 390, {
      fetchImpl: mockFetch,
    });

    expect(res.ok).toBe(true);
    expect(res.source).toBe("zingmp3");
    expect(res.lines.length).toBe(3);
    expect(res.lines[0].text).toBe("Hò ơi");
    expect(res.lines[2].time).toBe(380);
  });

  it("returns no_matching_version when BOTH LRCLIB and Zing MP3 lack a matching version", async () => {
    const mockFetch = async (url) => {
      if (url.includes("lrclib.net/api/get")) {
        return { ok: false, status: 404 };
      }
      if (url.includes("lrclib.net/api/search")) {
        // Only mismatched version
        return {
          ok: true,
          json: async () => [
            {
              trackName: "Rare Song",
              artistName: "Wrong Artist",
              duration: 120,
              syncedLyrics: "[00:10.00]Wrong version",
            },
          ],
        };
      }
      if (url.includes("ac.zingmp3.vn")) {
        // Zing MP3 also only has mismatched version
        return {
          ok: true,
          json: async () => ({
            data: {
              items: [
                {
                  title: "Rare Song (Remix)",
                  duration: 120,
                  lyricLink: "https://static-zmp3.zmdcdn.me/lyrics/wrong.lrc",
                  artists: [{ name: "Wrong Artist" }],
                },
              ],
            },
          }),
        };
      }
      throw new Error("unexpected url " + url);
    };

    const res = await fetchLyrics("Rare Song", "Real Artist", 300, {
      fetchImpl: mockFetch,
    });

    // MUST return no_matching_version, NEVER return wrong lyrics!
    expect(res.ok).toBe(false);
    expect(res.error).toBe("no_matching_version");
  });

  it("falls through to LRCLIB/ZingMP3 for YouTube MV without CC (strict duration match required)", async () => {
    clearLyricsCache();
    let lrclibQueried = false;
    const mockFetch = async (url) => {
      // YouTube returns no creator captions
      if (url.includes("youtubei/v1/player")) {
        return {
          ok: true,
          json: async () => ({ captions: {} }),
        };
      }
      // LRCLIB should now be queried (no hard-stop) but return no matching version
      if (url.includes("lrclib.net")) {
        lrclibQueried = true;
        return { ok: true, json: async () => [] }; // empty result
      }
      // Zing MP3 also returns no match
      if (url.includes("zingmp3.vn")) {
        return { ok: true, json: async () => ({ items: [] }) };
      }
      return { ok: false };
    };

    const res = await fetchLyrics("Đừng Làm Trái Tim Anh Đau | Official Music Video", "Sơn Tùng M-TP", 330, {
      platform: "youtube",
      videoId: "noCcMvVideoId",
      fetchImpl: mockFetch,
    });

    // LRCLIB must now be queried (we fall through, not hard-stop)
    expect(lrclibQueried).toBe(true);
    // No matching version found in any source
    expect(res.ok).toBe(false);
    expect(res.error).toBe("no_matching_version");
  });

  it("falls through to LRCLIB for YouTube Live without CC (strict duration + artist check prevent mismatch)", async () => {
    clearLyricsCache();
    let lrclibQueried = false;
    const mockFetch = async (url) => {
      if (url.includes("youtubei/v1/player")) {
        return {
          ok: true,
          json: async () => ({ captions: {} }),
        };
      }
      if (url.includes("lrclib.net")) {
        lrclibQueried = true;
        return { ok: true, json: async () => [] };
      }
      if (url.includes("zingmp3.vn")) {
        return { ok: true, json: async () => ({ items: [] }) };
      }
      return { ok: false };
    };

    const res = await fetchLyrics("See You Again (Live at Grammy)", "Charlie Puth", 240, {
      platform: "youtube",
      videoId: "noCcLiveVideoId",
      fetchImpl: mockFetch,
    });

    expect(lrclibQueried).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("no_matching_version");
  });

  it("allows studio fallback for YouTube Audio/Visualizer/Topic when duration matches within <= 2s", async () => {
    clearLyricsCache();
    const mockFetch = async (url) => {
      if (url.includes("youtubei/v1/player")) {
        return {
          ok: true,
          json: async () => ({ captions: {} }),
        };
      }
      if (url.includes("lrclib.net/api/get")) {
        return {
          ok: true,
          json: async () => ({
            trackName: "Chạy Ngay Đi",
            artistName: "Sơn Tùng M-TP",
            duration: 247,
            syncedLyrics: "[00:12.00]Chạy ngay đi trước khi...",
          }),
        };
      }
      throw new Error("unexpected URL: " + url);
    };

    const res = await fetchLyrics("Chạy Ngay Đi (Official Audio)", "Sơn Tùng M-TP", 248, {
      platform: "youtube",
      videoId: "audioTrack123",
      fetchImpl: mockFetch,
    });

    expect(res.ok).toBe(true);
    expect(res.source).toBe("lrclib");
    expect(res.lines[0].text).toBe("Chạy ngay đi trước khi...");
  });

  it("rejects studio fallback for YouTube Audio when duration differs by more than 2s (e.g. 3s difference)", async () => {
    clearLyricsCache();
    const mockFetch = async (url) => {
      if (url.includes("youtubei/v1/player")) {
        return {
          ok: true,
          json: async () => ({ captions: {} }),
        };
      }
      if (url.includes("lrclib.net/api/get")) {
        return {
          ok: true,
          json: async () => ({
            trackName: "Chạy Ngay Đi",
            artistName: "Sơn Tùng M-TP",
            duration: 245, // Diff is 3s vs target 248s (> 2s)
            syncedLyrics: "[00:12.00]Chạy ngay đi trước khi...",
          }),
        };
      }
      if (url.includes("lrclib.net/api/search")) {
        return {
          ok: true,
          json: async () => [
            {
              trackName: "Chạy Ngay Đi",
              artistName: "Sơn Tùng M-TP",
              duration: 245, // Diff is 3s (> 2s)
              syncedLyrics: "[00:12.00]Chạy ngay đi trước khi...",
            },
          ],
        };
      }
      if (url.includes("ac.zingmp3.vn")) {
        return { ok: true, json: async () => ({ data: { items: [] } }) };
      }
      return { ok: false };
    };

    const res = await fetchLyrics("Chạy Ngay Đi (Official Audio)", "Sơn Tùng M-TP", 248, {
      platform: "youtube",
      videoId: "mismatchedAudio",
      fetchImpl: mockFetch,
    });

    expect(res.ok).toBe(false);
    expect(res.error).toBe("no_matching_version");
  });
});
