import { describe, it, expect } from "bun:test";
import {
  detectOriginalLanguage,
  selectOriginalCreatorTrack,
  parseYouTubeTimedText,
  fetchYouTubeCreatorCaptions,
} from "../src/providers/youtubeCaptions.js";

describe("YouTube Creator Captions Provider", () => {
  describe("detectOriginalLanguage", () => {
    it("detects Vietnamese for titles/artists with Vietnamese diacritics", () => {
      expect(detectOriginalLanguage("Tình Anh Bán Chiếu", "Út Trà Ôn")).toBe("vi");
      expect(detectOriginalLanguage("Đừng Làm Trái Tim Anh Đau", "Sơn Tùng M-TP")).toBe("vi");
      expect(detectOriginalLanguage("Không Thể Say", "HIEUTHUHAI")).toBe("vi");
    });

    it("detects Korean for Hangul text", () => {
      expect(detectOriginalLanguage("봄날 (Spring Day)", "방탄소년단 (BTS)")).toBe("ko");
      expect(detectOriginalLanguage("Ditto", "NewJeans (뉴진스)")).toBe("ko");
    });

    it("detects Japanese for Hiragana / Katakana text", () => {
      expect(detectOriginalLanguage("夜に駆ける", "YOASOBI")).toBe("ja");
      expect(detectOriginalLanguage("アイドル", "YOASOBI")).toBe("ja");
    });

    it("detects English / Latin default for English songs", () => {
      expect(detectOriginalLanguage("Shape of You", "Ed Sheeran")).toBe("en");
      expect(detectOriginalLanguage("Blinding Lights", "The Weeknd")).toBe("en");
    });
  });

  describe("selectOriginalCreatorTrack", () => {
    it("selects creator-uploaded track matching the original language", () => {
      const tracks = [
        { languageCode: "en", vssId: "a.en", kind: "asr" }, // auto-generated
        { languageCode: "en", vssId: ".en" }, // English manual translation
        { languageCode: "vi", vssId: ".vi" }, // Vietnamese manual original
      ];

      const selected = selectOriginalCreatorTrack(tracks, "vi");
      expect(selected).not.toBeNull();
      expect(selected.languageCode).toBe("vi");
      expect(selected.vssId).toBe(".vi");
    });

    it("rejects auto-generated ASR tracks completely", () => {
      const tracks = [
        { languageCode: "vi", vssId: "a.vi", kind: "asr" },
        { languageCode: "en", vssId: "a.en", kind: "asr" },
      ];

      const selected = selectOriginalCreatorTrack(tracks, "vi");
      expect(selected).toBeNull();
    });

    it("rejects when no creator track matches the original song language", () => {
      // Song is Vietnamese, but video creator only uploaded English and Spanish subs
      const tracks = [
        { languageCode: "en", vssId: ".en" },
        { languageCode: "es", vssId: ".es" },
      ];

      // Must NOT return English lyrics for a Vietnamese song!
      const selected = selectOriginalCreatorTrack(tracks, "vi");
      expect(selected).toBeNull();
    });

    it("selects Korean creator track for Korean song", () => {
      const tracks = [
        { languageCode: "ko", vssId: ".ko" },
        { languageCode: "en", vssId: ".en" },
        { languageCode: "vi", vssId: ".vi" },
      ];

      const selected = selectOriginalCreatorTrack(tracks, "ko");
      expect(selected).not.toBeNull();
      expect(selected.languageCode).toBe("ko");
    });
  });

  describe("parseYouTubeTimedText", () => {
    it("parses timedtext XML, decodes HTML entities, and preserves creator special characters", () => {
      const xml = `<?xml version="1.0" encoding="utf-8" ?>
<timedtext format="3">
<body>
<p t="1200" d="3500">[Âm nhạc]</p>
<p t="5000" d="4200">♪ Chiếu Cà Mau &amp; nhuộm màu &#39;tươi thắm&#39; ♪</p>
<p t="10500" d="3000">Công tôi &quot;cực lắm&quot; mưa nắng dãi dầu &lt;3</p>
<p t="15000" d="2000">   </p>
</body>
</timedtext>`;

      const lines = parseYouTubeTimedText(xml);
      expect(lines).toHaveLength(3);
      expect(lines[0].time).toBe(1.2);
      expect(lines[0].text).toBe("[Âm nhạc]");
      expect(lines[1].time).toBe(5.0);
      expect(lines[1].text).toBe("♪ Chiếu Cà Mau & nhuộm màu 'tươi thắm' ♪");
      expect(lines[2].time).toBe(10.5);
      expect(lines[2].text).toBe('Công tôi "cực lắm" mưa nắng dãi dầu <3');
    });

    it("handles empty or malformed XML gracefully", () => {
      expect(parseYouTubeTimedText("")).toEqual([]);
      expect(parseYouTubeTimedText(null)).toEqual([]);
      expect(parseYouTubeTimedText("<random>not timedtext</random>")).toEqual([]);
    });
  });

  describe("fetchYouTubeCreatorCaptions", () => {
    it("fetches, verifies original language, and returns formatted lyrics", async () => {
      const mockFetch = async (url, options) => {
        if (url.includes("youtubei/v1/player")) {
          return {
            ok: true,
            json: async () => ({
              captions: {
                playerCaptionsTracklistRenderer: {
                  captionTracks: [
                    { languageCode: "en", vssId: "a.en", kind: "asr", baseUrl: "https://www.youtube.com/api/timedtext?v=testVideo123&lang=en&kind=asr" },
                    { languageCode: "vi", vssId: ".vi", baseUrl: "https://www.youtube.com/api/timedtext?v=testVideo123&lang=vi" },
                  ],
                },
              },
            }),
          };
        }
        if (url.startsWith("https://www.youtube.com/api/timedtext") && url.includes("lang=vi")) {
          return {
            ok: true,
            text: async () => `<?xml version="1.0" encoding="utf-8" ?>
<timedtext format="3">
<body>
<p t="4000" d="2000">Câu hát đầu tiên</p>
<p t="8000" d="3000">Câu hát thứ hai</p>
</body>
</timedtext>`,
          };
        }
        throw new Error("unexpected url " + url);
      };

      const res = await fetchYouTubeCreatorCaptions("testVideo123", {
        title: "Bài Ca Đất Phương Nam",
        artist: "Hương Lan",
        fetchImpl: mockFetch,
      });

      expect(res.ok).toBe(true);
      expect(res.synced).toBe(true);
      expect(res.source).toBe("youtube_captions");
      expect(res.lines).toHaveLength(2);
      expect(res.lines[0]).toEqual({ time: 4.0, text: "Câu hát đầu tiên" });
      expect(res.lines[1]).toEqual({ time: 8.0, text: "Câu hát thứ hai" });
    });

    it("returns error when video only has auto-generated ASR captions", async () => {
      const mockFetch = async () => ({
        ok: true,
        json: async () => ({
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: [
                { languageCode: "vi", vssId: "a.vi", kind: "asr", baseUrl: "https://yt/asr" },
              ],
            },
          },
        }),
      });

      const res = await fetchYouTubeCreatorCaptions("testVideoAsr", {
        title: "Tình Anh Bán Chiếu",
        artist: "Út Trà Ôn",
        fetchImpl: mockFetch,
      });

      expect(res.ok).toBe(false);
      expect(res.error).toBe("no_creator_captions");
    });

    it("returns error when video has no captions at all", async () => {
      const mockFetch = async () => ({
        ok: true,
        json: async () => ({
          captions: null,
        }),
      });

      const res = await fetchYouTubeCreatorCaptions("testNoCaps", {
        title: "Song Without Caps",
        artist: "Singer",
        fetchImpl: mockFetch,
      });

      expect(res.ok).toBe(false);
      expect(res.error).toBe("no_creator_captions");
    });
  });
});
