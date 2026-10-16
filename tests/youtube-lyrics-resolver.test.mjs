import { describe, it, expect, beforeEach } from "bun:test";
import {
  resolveYouTubeCreatorLyrics,
  filterCreatorTracks,
  detectSongLanguage,
  detectTextLanguage,
  clearResolverCaches,
} from "../src/providers/youtubeLyricsResolver.js";

function createMockInnerTubeResponse({
  tracks = [],
  title = "Test Song",
  author = "Test Artist",
  audioTracks = [],
  description = "",
  keywords = [],
} = {}) {
  return {
    videoDetails: {
      title,
      author,
      shortDescription: description,
      keywords,
    },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: tracks,
      },
    },
    ...(audioTracks.length > 0 ? { audioTracks } : {}),
  };
}

function makeTimedTextXml(lines) {
  // lines = [{ start: 1.0, text: "..." }]
  const items = lines
    .map(
      (l, idx) =>
        `<p t="${Math.round((l.start || idx * 3) * 1000)}" d="2500">${l.text}</p>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body>${items}</body></timedtext>`;
}

describe("YouTube Lyrics Resolver", () => {
  beforeEach(() => {
    clearResolverCaches?.();
  });

  describe("detectSongLanguage", () => {
    it("detects Vietnamese with diacritics", () => {
      expect(detectSongLanguage({ title: "Nơi này có anh", artist: "Sơn Tùng M-TP" })).toBe("vi");
    });

    it("detects Korean with Hangul", () => {
      expect(detectSongLanguage({ title: "봄날 (Spring Day)", artist: "BTS (방탄소년단)" })).toBe("ko");
    });

    it("detects Japanese with Kana", () => {
      expect(detectSongLanguage({ title: "夜に駆ける", artist: "YOASOBI" })).toBe("ja");
    });

    it("detects Chinese with Hanzi", () => {
      expect(detectSongLanguage({ title: "晴天", artist: "周杰倫" })).toBe("zh");
    });

    it("detects Thai script", () => {
      expect(detectSongLanguage({ title: "รักแรก", artist: "NONT TANONT" })).toBe("th");
    });

    it("detects Vietnamese without diacritics when channel/description/keywords have Vietnamese context", () => {
      expect(
        detectSongLanguage({
          title: "Em cua ngay hom qua",
          artist: "Son Tung M-TP",
          videoDetails: {
            title: "Em cua ngay hom qua",
            author: "Sơn Tùng M-TP Official",
            shortDescription: "Ca khúc chính thức phát hành năm 2013",
            keywords: ["son tung", "nhac tre"],
          },
        })
      ).toBe("vi");
    });

    it("detects Japanese when title/artist has Kana even if keywords contain Korean tags", () => {
      expect(
        detectSongLanguage({
          title: "ヒグチアイ / 悪魔の子 (アニメスペシャルVer.) | Ai Higuchi “Akuma no Ko” Anime Special Ver.",
          artist: "ヒグチアイ",
          videoDetails: {
            title: "ヒグチアイ / 悪魔の子 (アニメスペシャルVer.)公開！",
            author: "ヒグチアイ",
            keywords: ["진격의거인", "악마의 아이", "進撃の巨人", "ヒグチアイ"],
            shortDescription: "Ai Higuchi Akuma no Ko",
          },
        })
      ).toBe("ja");
    });

    it("detects Japanese from keywords when title/artist are Latin but Japanese script dominates keywords/description", () => {
      expect(
        detectSongLanguage({
          title: "Akuma no Ko",
          artist: "Ai Higuchi",
          videoDetails: {
            title: "Akuma no Ko Anime Special Ver",
            author: "Ai Higuchi",
            keywords: ["進撃の巨人", "ヒグチアイ", "悪魔の子", "진격의거인"],
            shortDescription: "ヒグチアイ / 悪魔の子 Official Video",
          },
        })
      ).toBe("ja");
    });

    it("returns null when language is ambiguous", () => {
      expect(detectSongLanguage({ title: "Hello World", artist: "Unknown" })).toBeNull();
    });
  });

  describe("filterCreatorTracks", () => {
    it("filters out ASR, translations, and romanized tracks", () => {
      const tracks = [
        { kind: "asr", languageCode: "vi", baseUrl: "https://www.youtube.com/api/timedtext" },
        { vssId: "a.vi", languageCode: "vi", baseUrl: "https://www.youtube.com/api/timedtext" },
        { vssId: ".vi.translate", languageCode: "vi", baseUrl: "https://www.youtube.com/api/timedtext" },
        { languageCode: "ko-Latn", name: { simpleText: "Romanized" }, baseUrl: "https://www.youtube.com/api/timedtext" },
        { languageCode: "ko", name: { simpleText: "Romaji / Phiên âm" }, baseUrl: "https://www.youtube.com/api/timedtext" },
        { languageCode: "vi", name: { simpleText: "Tiếng Việt" }, baseUrl: "https://www.youtube.com/api/timedtext" },
      ];
      const filtered = filterCreatorTracks(tracks);
      expect(filtered.length).toBe(1);
      expect(filtered[0].languageCode).toBe("vi");
    });
  });

  describe("detectTextLanguage", () => {
    it("detects Korean text", () => {
      const lines = [
        { text: "보고 싶다 이렇게 말하니까 더 보고 싶다" },
        { text: "너희 사진을 보고 있어도 보고 싶다" },
      ];
      expect(detectTextLanguage(lines)).toBe("ko");
    });

    it("detects Vietnamese text with diacritics", () => {
      const lines = [
        { text: "Em là ai từ đâu bước đến nơi đây dịu dàng" },
        { text: "Hạt ngọc rơi nhẹ qua mái hiên nghiêng bóng chiều" },
      ];
      expect(detectTextLanguage(lines)).toBe("vi");
    });
  });

  describe("resolveYouTubeCreatorLyrics", () => {
    it("selects vi track over en translation for Vietnamese song", async () => {
      const viLines = [
        { text: "Em là bông hoa đẹp nhất trong lòng anh" },
        { text: "Dù ngày trôi qua bao nhiêu bão giông cuộc đời" },
        { text: "Vẫn giữ mãi một tình yêu thiết tha nồng say" },
        { text: "Không bao giờ phai nhạt theo tháng năm tháng năm" },
        { text: "Bên nhau trọn đời ngọt ngào đắm say muôn trùng" },
        { text: "Lời hẹn ước đôi ta cùng bước qua giông tố" },
      ];
      const enLines = [
        { text: "You are the most beautiful flower in my heart" },
        { text: "Through all storms of this lifetime" },
        { text: "Still holding on to this passionate deep love" },
        { text: "Never fading away through the passing years" },
        { text: "Together forever sweet and boundless" },
        { text: "Our promise to walk through the heavy storm" },
      ];

      const mockFetch = async (url, opts) => {
        if (url.includes("youtubei/v1/player")) {
          return {
            ok: true,
            json: async () =>
              createMockInnerTubeResponse({
                title: "Bông Hoa Đẹp Nhất",
                author: "Quân A.P",
                tracks: [
                  {
                    languageCode: "en",
                    vssId: ".en",
                    name: { simpleText: "English (translation)" },
                    baseUrl: "https://www.youtube.com/api/timedtext?lang=en",
                  },
                  {
                    languageCode: "vi",
                    vssId: ".vi",
                    name: { simpleText: "Tiếng Việt (Gốc)" },
                    baseUrl: "https://www.youtube.com/api/timedtext?lang=vi",
                  },
                ],
              }),
          };
        }
        if (url.includes("lang=vi")) {
          return { ok: true, text: async () => makeTimedTextXml(viLines) };
        }
        if (url.includes("lang=en")) {
          return { ok: true, text: async () => makeTimedTextXml(enLines) };
        }
        return { ok: false };
      };

      const result = await resolveYouTubeCreatorLyrics("mock_video_1", {
        title: "Bông Hoa Đẹp Nhất",
        artist: "Quân A.P",
        fetchImpl: mockFetch,
      });

      expect(result.ok).toBe(true);
      expect(result.language).toBe("vi");
      expect(result.source).toBe("youtube_captions");
      expect(result.lines.length).toBe(6);
    });

    it("selects ko track and skips ko-Latn and en for K-pop song", async () => {
      const koLines = [
        { text: "보고 싶다 이렇게 말하니까 더 보고 싶다" },
        { text: "너희 사진을 보고 있어도 보고 싶다" },
        { text: "너무 야속한 시간 나는 우리가 밉다" },
        { text: "이젠 얼굴 한 번 보는 것 조차 힘들어진 우리가" },
        { text: "여긴 온통 겨울 뿐이야 8월에도 겨울이 와" },
        { text: "마음은 시간을 달려가 홀로 남은 설국열차" },
      ];

      const mockFetch = async (url) => {
        if (url.includes("youtubei/v1/player")) {
          return {
            ok: true,
            json: async () =>
              createMockInnerTubeResponse({
                title: "봄날",
                author: "BTS",
                tracks: [
                  {
                    languageCode: "ko-Latn",
                    name: { simpleText: "Romanization" },
                    baseUrl: "https://www.youtube.com/api/timedtext?lang=ko-Latn",
                  },
                  {
                    languageCode: "en",
                    name: { simpleText: "English Sub" },
                    baseUrl: "https://www.youtube.com/api/timedtext?lang=en",
                  },
                  {
                    languageCode: "ko",
                    name: { simpleText: "한국어" },
                    baseUrl: "https://www.youtube.com/api/timedtext?lang=ko",
                  },
                ],
              }),
          };
        }
        if (url.includes("lang=ko")) {
          return { ok: true, text: async () => makeTimedTextXml(koLines) };
        }
        return { ok: false };
      };

      const result = await resolveYouTubeCreatorLyrics("mock_kpop", {
        title: "봄날 (Spring Day)",
        artist: "BTS",
        fetchImpl: mockFetch,
      });

      expect(result.ok).toBe(true);
      expect(result.language).toBe("ko");
      expect(result.lines.length).toBe(6);
    });

    it("selects ja track over ko translation track for Japanese song even when tags contain Korean", async () => {
      const jaLines = [
        { text: "鉄の弾が 正義の証明 貫けば 英雄に近づいた" },
        { text: "その目を閉じて 触れてみれば 同じ形 同じ体温の悪魔" },
        { text: "僕はダメで あいつはいいの？ そこに壁があっただけなのに" },
        { text: "生まれてしまった 運命を嘆くな 僕らはみんな 自由なんだから" },
        { text: "鳥のように 羽があれば どこへだって 行けるけど" },
        { text: "帰る場所が なければ きっと どこへも 行けないよ" },
      ];
      const koLines = [
        { text: "철의 탄환이 정의의 증명 꿰뚫었더니 영웅에 가까워졌어" },
        { text: "그 눈을 감고 만져 보면 같은 형태 같은 체온의 악마" },
        { text: "나는 안되고 그 녀석은 되는거야? 거기에 벽이 있었을 뿐인데" },
        { text: "태어나 버린 운명을 한탄하지 마 우리들은 모두 자유로우니까" },
        { text: "새처럼 날개가 있다면 어디로든 갈 수 있겠지만" },
        { text: "돌아갈 장소가 없다면 분명 어디로도 갈 수 없을 거야" },
      ];

      const mockFetch = async (url) => {
        if (url.includes("youtubei/v1/player")) {
          return {
            ok: true,
            json: async () =>
              createMockInnerTubeResponse({
                title: "ヒグチアイ / 悪魔の子 (アニメスペシャルVer.)",
                author: "ヒグチアイ",
                keywords: ["진격의거인", "악마의 아이", "進撃の巨人", "ヒグチアイ"],
                tracks: [
                  {
                    languageCode: "ko",
                    name: { simpleText: "Korean" },
                    baseUrl: "https://www.youtube.com/api/timedtext?lang=ko",
                  },
                  {
                    languageCode: "ja",
                    name: { simpleText: "Japanese" },
                    baseUrl: "https://www.youtube.com/api/timedtext?lang=ja",
                  },
                ],
              }),
          };
        }
        if (url.includes("lang=ja")) {
          return { ok: true, text: async () => makeTimedTextXml(jaLines) };
        }
        if (url.includes("lang=ko")) {
          return { ok: true, text: async () => makeTimedTextXml(koLines) };
        }
        return { ok: false };
      };

      const result = await resolveYouTubeCreatorLyrics("mock_aot_ja", {
        title: "ヒグチアイ / 悪魔の子 (アニメスペシャルVer.)",
        artist: "ヒグチアイ",
        fetchImpl: mockFetch,
      });

      expect(result.ok).toBe(true);
      expect(result.language).toBe("ja");
      expect(result.trackName).toBe("Japanese");
      expect(result.lines[0].text).toContain("鉄の弾が 正義の証明");
    });

    it("rejects when only en translation is available for Hangul song", async () => {
      const enLines = [
        { text: "I miss you, saying this makes me miss you more" },
        { text: "Even looking at your photos I miss you" },
        { text: "Time is so cruel, I resent us" },
        { text: "Now even seeing each other's faces is hard" },
        { text: "It's all winter here, even in August winter comes" },
        { text: "My heart races through time, a lone Snowpiercer" },
      ];

      const mockFetch = async (url) => {
        if (url.includes("youtubei/v1/player")) {
          return {
            ok: true,
            json: async () =>
              createMockInnerTubeResponse({
                title: "봄날",
                author: "BTS",
                tracks: [
                  {
                    languageCode: "en",
                    name: { simpleText: "English (Translation)" },
                    baseUrl: "https://www.youtube.com/api/timedtext?lang=en",
                  },
                ],
              }),
          };
        }
        if (url.includes("lang=en")) {
          return { ok: true, text: async () => makeTimedTextXml(enLines) };
        }
        return { ok: false };
      };

      const result = await resolveYouTubeCreatorLyrics("mock_kpop_no_ko", {
        title: "봄날 (Spring Day)",
        artist: "BTS",
        fetchImpl: mockFetch,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("no_creator_captions");
    });

    it("accepts track with content verification when track languageCode was mislabeled as en", async () => {
      // Song title unaccented, but actual track lines have full Vietnamese text
      const viLines = [
        { text: "Em ơi đừng khóc bóng tối trước mắt sẽ qua nhanh thôi" },
        { text: "Bình minh sẽ hé sáng chiếu rọi con đường đôi ta bước" },
        { text: "Hãy nắm chặt tay anh cùng đi qua bão táp phong ba" },
        { text: "Dù ngày mai ra sao anh vẫn mãi yêu em trọn đời" },
        { text: "Một tình yêu chân thành không bao giờ đổi thay nhạt phai" },
        { text: "Cùng nhau ta xây đắp tương lai tươi sáng rạng ngời" },
      ];

      const mockFetch = async (url) => {
        if (url.includes("youtubei/v1/player")) {
          return {
            ok: true,
            json: async () =>
              createMockInnerTubeResponse({
                title: "Em oi dung khoc",
                author: "Ca si Viet",
                tracks: [
                  {
                    languageCode: "en", // mistakenly tagged as en by uploader
                    name: { simpleText: "Lyrics" },
                    baseUrl: "https://www.youtube.com/api/timedtext?lang=en_mislabeled",
                  },
                ],
              }),
          };
        }
        if (url.includes("lang=en_mislabeled")) {
          return { ok: true, text: async () => makeTimedTextXml(viLines) };
        }
        return { ok: false };
      };

      const result = await resolveYouTubeCreatorLyrics("mock_mislabeled", {
        title: "Em oi dung khoc",
        artist: "Ca si Viet",
        fetchImpl: mockFetch,
      });

      expect(result.ok).toBe(true);
      expect(result.language).toBe("vi"); // recognized from content
      expect(result.lines.length).toBe(6);
    });

    it("rejects when only ASR tracks exist", async () => {
      const mockFetch = async () => ({
        ok: true,
        json: async () =>
          createMockInnerTubeResponse({
            tracks: [
              {
                kind: "asr",
                languageCode: "vi",
                baseUrl: "https://www.youtube.com/api/timedtext?asr=1",
              },
            ],
          }),
      });

      const result = await resolveYouTubeCreatorLyrics("mock_asr_only", {
        title: "Bài Hát Việt",
        artist: "Ca sĩ",
        fetchImpl: mockFetch,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("no_creator_captions");
    });

    it("rejects track with too few characters (< 120 chars total)", async () => {
      const shortLines = [
        { text: "Cảm ơn đã xem video!" },
        { text: "Nhớ like và subscribe nha!" },
      ];

      const mockFetch = async (url) => {
        if (url.includes("youtubei/v1/player")) {
          return {
            ok: true,
            json: async () =>
              createMockInnerTubeResponse({
                title: "Bài Hát Ngắn",
                author: "Ca Sĩ",
                tracks: [
                  {
                    languageCode: "vi",
                    baseUrl: "https://www.youtube.com/api/timedtext?short=1",
                  },
                ],
              }),
          };
        }
        return { ok: true, text: async () => makeTimedTextXml(shortLines) };
      };

      const result = await resolveYouTubeCreatorLyrics("mock_short_track", {
        title: "Bài Hát Ngắn",
        artist: "Ca Sĩ",
        fetchImpl: mockFetch,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("no_creator_captions");
    });

    it("rejects baseUrl outside YouTube domains (SSRF guard)", async () => {
      const mockFetch = async () => ({
        ok: true,
        json: async () =>
          createMockInnerTubeResponse({
            title: "Bài Hát",
            author: "Ca Sĩ",
            tracks: [
              {
                languageCode: "vi",
                baseUrl: "https://evil-attacker.com/timedtext.xml",
              },
            ],
          }),
      });

      const result = await resolveYouTubeCreatorLyrics("mock_ssrf", {
        title: "Bài Hát",
        artist: "Ca Sĩ",
        fetchImpl: mockFetch,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("invalid_caption_url");
    });

    it("probe mode returns hasCcLyrics true and caches result for full fetch", async () => {
      const viLines = [
        { text: "Em là bông hoa đẹp nhất trong lòng anh" },
        { text: "Dù ngày trôi qua bao nhiêu bão giông cuộc đời" },
        { text: "Vẫn giữ mãi một tình yêu thiết tha nồng say" },
        { text: "Không bao giờ phai nhạt theo tháng năm tháng năm" },
        { text: "Bên nhau trọn đời ngọt ngào đắm say muôn trùng" },
        { text: "Lời hẹn ước đôi ta cùng bước qua giông tố" },
      ];

      let playerCalls = 0;
      let timedTextCalls = 0;

      const mockFetch = async (url) => {
        if (url.includes("youtubei/v1/player")) {
          playerCalls++;
          return {
            ok: true,
            json: async () =>
              createMockInnerTubeResponse({
                title: "Bông Hoa Đẹp Nhất",
                author: "Quân A.P",
                tracks: [
                  {
                    languageCode: "vi",
                    baseUrl: "https://www.youtube.com/api/timedtext?lang=vi",
                  },
                ],
              }),
          };
        }
        if (url.includes("timedtext")) {
          timedTextCalls++;
          return { ok: true, text: async () => makeTimedTextXml(viLines) };
        }
        return { ok: false };
      };

      const probe = await resolveYouTubeCreatorLyrics("mock_probe_cache", {
        title: "Bông Hoa Đẹp Nhất",
        artist: "Quân A.P",
        fetchImpl: mockFetch,
        mode: "probe",
      });

      expect(probe.ok).toBe(true);
      expect(probe.hasCcLyrics).toBe(true);
      expect(playerCalls).toBe(1);
      expect(timedTextCalls).toBe(1);

      // Now call full mode on same videoId - should hit cache and NOT make extra network calls
      const full = await resolveYouTubeCreatorLyrics("mock_probe_cache", {
        title: "Bông Hoa Đẹp Nhất",
        artist: "Quân A.P",
        fetchImpl: mockFetch,
        mode: "full",
      });

      expect(full.ok).toBe(true);
      expect(full.lines.length).toBe(6);
      expect(playerCalls).toBe(1);
      expect(timedTextCalls).toBe(1);
    });
  });
});
