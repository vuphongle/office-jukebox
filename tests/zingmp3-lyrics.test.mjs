import { describe, it, expect } from "bun:test";
import {
  fetchZingMp3Lyrics,
  validateZingCandidate,
  extractZingCandidates,
} from "../src/providers/zingMp3Lyrics.js";

describe("Zing MP3 Lyrics Provider", () => {
  describe("extractZingCandidates", () => {
    it("extracts songs from nested suggestions or direct items", () => {
      const data = {
        items: [
          { keywords: [{ keyword: "test" }] },
          {
            suggestions: [
              {
                title: "Tình Anh Bán Chiếu",
                duration: 390,
                lyricLink: "https://static-zmp3.zmdcdn.me/lyrics/1.lrc",
                artists: [{ name: "Út Trà Ôn" }],
              },
            ],
          },
          {
            title: "Tình Anh Bán Chiếu Remix",
            duration: 147,
            lyricLink: "https://static-zmp3.zmdcdn.me/lyrics/2.lrc",
            artists: [{ name: "Thanh Duy" }],
          },
        ],
      };

      const candidates = extractZingCandidates(data);
      expect(candidates).toHaveLength(2);
      expect(candidates[0].title).toBe("Tình Anh Bán Chiếu");
      expect(candidates[1].title).toBe("Tình Anh Bán Chiếu Remix");
    });
  });

  describe("validateZingCandidate", () => {
    it("accepts candidate with matching artist and duration", () => {
      const cand = {
        title: "Tình Anh Bán Chiếu",
        duration: 390,
        lyricLink: "https://static-zmp3.zmdcdn.me/lyrics/1.lrc",
        artists: [{ name: "Út Trà Ôn" }],
      };

      const res = validateZingCandidate(cand, {
        targetTitle: "Tình Anh Bán Chiếu",
        targetArtist: "Út Trà Ôn",
        targetDurationSec: 390,
      });

      expect(res.valid).toBe(true);
    });

    it("rejects candidate when duration differs significantly (e.g. 147s vs 390s)", () => {
      const cand = {
        title: "Tình Anh Bán Chiếu",
        duration: 147,
        lyricLink: "https://static-zmp3.zmdcdn.me/lyrics/remix.lrc",
        artists: [{ name: "Thanh Duy" }],
      };

      const res = validateZingCandidate(cand, {
        targetTitle: "Tình Anh Bán Chiếu",
        targetArtist: "Út Trà Ôn",
        targetDurationSec: 390,
      });

      expect(res.valid).toBe(false);
      expect(res.reason).toBe("duration_mismatch");
    });

    it("rejects candidate when duration differs by more than 2s (e.g. 3s difference)", () => {
      const cand = {
        title: "Tình Anh Bán Chiếu",
        duration: 393,
        lyricLink: "https://static-zmp3.zmdcdn.me/lyrics/1.lrc",
        artists: [{ name: "Út Trà Ôn" }],
      };

      const res = validateZingCandidate(cand, {
        targetTitle: "Tình Anh Bán Chiếu",
        targetArtist: "Út Trà Ôn",
        targetDurationSec: 390,
      });

      expect(res.valid).toBe(false);
      expect(res.reason).toBe("duration_mismatch");
    });

    it("rejects candidate when artist differs completely", () => {
      const cand = {
        title: "Tình Anh Bán Chiếu",
        duration: 390,
        lyricLink: "https://static-zmp3.zmdcdn.me/lyrics/1.lrc",
        artists: [{ name: "Khác Ca Sĩ" }],
      };

      const res = validateZingCandidate(cand, {
        targetTitle: "Tình Anh Bán Chiếu",
        targetArtist: "Út Trà Ôn",
        targetDurationSec: 390,
      });

      expect(res.valid).toBe(false);
      expect(res.reason).toBe("artist_mismatch");
    });

    it("rejects remix or cover when target title does not ask for it", () => {
      const cand = {
        title: "Tình Anh Bán Chiếu (Remix)",
        duration: 220,
        lyricLink: "https://static-zmp3.zmdcdn.me/lyrics/1.lrc",
        artists: [{ name: "Út Trà Ôn" }],
      };

      const res = validateZingCandidate(cand, {
        targetTitle: "Tình Anh Bán Chiếu",
        targetArtist: "Út Trà Ôn",
        targetDurationSec: 220,
      });

      expect(res.valid).toBe(false);
      expect(res.reason).toBe("variation_mismatch");
    });

    it("rejects candidate without lyricLink", () => {
      const cand = {
        title: "Tình Anh Bán Chiếu",
        duration: 390,
        lyricLink: "",
        artists: [{ name: "Út Trà Ôn" }],
      };

      const res = validateZingCandidate(cand, {
        targetTitle: "Tình Anh Bán Chiếu",
        targetArtist: "Út Trà Ôn",
        targetDurationSec: 390,
      });

      expect(res.valid).toBe(false);
      expect(res.reason).toBe("no_lyric_link");
    });
  });

  describe("fetchZingMp3Lyrics", () => {
    it("fetches, validates, and downloads .lrc from Zing CDN", async () => {
      const mockFetch = async (url) => {
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
                        lyricLink: "https://static-zmp3.zmdcdn.me/lyrics/ut-tra-on.lrc",
                        artists: [{ name: "Út Trà Ôn" }],
                      },
                    ],
                  },
                ],
              },
            }),
          };
        }
        if (url === "https://static-zmp3.zmdcdn.me/lyrics/ut-tra-on.lrc") {
          return {
            ok: true,
            text: async () => `[00:00.00]Hò ơi
[00:03.00]Chiếu Cà Mau nhuộm màu tươi thắm
[06:20.00]Tình anh bán chiếu trọn đời không phai`,
          };
        }
        throw new Error("unexpected url " + url);
      };

      const res = await fetchZingMp3Lyrics("Tình Anh Bán Chiếu", "Út Trà Ôn", 390, {
        fetchImpl: mockFetch,
      });

      expect(res.ok).toBe(true);
      expect(res.synced).toBe(true);
      expect(res.source).toBe("zingmp3");
      expect(res.lines.length).toBe(3);
      expect(res.lines[0].text).toBe("Hò ơi");
      expect(res.lines[2].time).toBe(380);
      expect(res.lines[2].text).toContain("trọn đời không phai");
    });

    it("returns no_matching_version when all candidates fail duration or artist check", async () => {
      const mockFetch = async (url) => {
        if (url.includes("ac.zingmp3.vn")) {
          return {
            ok: true,
            json: async () => ({
              data: {
                items: [
                  {
                    title: "Tình Anh Bán Chiếu (Remix)",
                    duration: 147,
                    lyricLink: "https://static-zmp3.zmdcdn.me/lyrics/remix.lrc",
                    artists: [{ name: "Thanh Duy" }],
                  },
                ],
              },
            }),
          };
        }
        throw new Error("unexpected url " + url);
      };

      const res = await fetchZingMp3Lyrics("Tình Anh Bán Chiếu", "Út Trà Ôn", 390, {
        fetchImpl: mockFetch,
      });

      expect(res.ok).toBe(false);
      expect(res.error).toBe("no_matching_version");
    });

    it("returns not_found when Zing MP3 suggestions return no songs", async () => {
      const mockFetch = async () => ({
        ok: true,
        json: async () => ({ data: { items: [] } }),
      });

      const res = await fetchZingMp3Lyrics("NonExistentSong", "UnknownArtist", 200, {
        fetchImpl: mockFetch,
      });

      expect(res.ok).toBe(false);
      expect(res.error).toBe("not_found");
    });
  });
});
