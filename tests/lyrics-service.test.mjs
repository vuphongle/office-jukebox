import { describe, it, expect } from "bun:test";
import { cleanLyricsQuery, parseLrc, fetchLyrics } from "../src/lyricsService.js";

describe("Lyrics Service & LRC Parser", () => {
  it("cleans noisy YouTube and Spotify track titles", () => {
    const q1 = cleanLyricsQuery("Tip Toe (Official Music Video)", "HYBS");
    expect(q1.title).toBe("Tip Toe");
    expect(q1.artist).toBe("HYBS");

    const q2 = cleanLyricsQuery("HIEUTHUHAI - Không Thể Say [Official MV]", "");
    expect(q2.artist).toBe("HIEUTHUHAI");
    expect(q2.title).toBe("Không Thể Say");

    const q3 = cleanLyricsQuery("See Tình (prod. by DTAP)", "Hoàng Thùy Linh - Topic");
    expect(q3.title).toBe("See Tình");
    expect(q3.artist).toBe("Hoàng Thùy Linh");

    const q4 = cleanLyricsQuery("LAVIEM (feat. Quang Hùng MasterD, CAPTAIN BOY, Pháp Kiều, CoolKid & Danny Chung...)", "TINH HÀ \"SAY HI\", Quang Hùng MasterD");
    expect(q4.title).toBe("LAVIEM");
    expect(q4.artist).toContain("TINH HÀ");
  });

  it("parses standard LRC strings into sorted time-stamped array", () => {
    const lrc = `
[00:05.12]Line one of lyrics
[00:12.80]Line two with some beat
[01:04.500]Chorus arrives here
`;
    const parsed = parseLrc(lrc);
    expect(parsed.length).toBe(3);
    expect(parsed[0].time).toBeCloseTo(5.12, 2);
    expect(parsed[0].text).toBe("Line one of lyrics");
    expect(parsed[1].time).toBeCloseTo(12.8, 2);
    expect(parsed[1].text).toBe("Line two with some beat");
    expect(parsed[2].time).toBeCloseTo(64.5, 2);
    expect(parsed[2].text).toBe("Chorus arrives here");
  });

  it("handles empty or malformed LRC gracefully", () => {
    expect(parseLrc("")).toEqual([]);
    expect(parseLrc(null)).toEqual([]);
    expect(parseLrc("random text without timestamps")).toEqual([]);
  });

  it("fetches synced lyrics with mock fetch", async () => {
    const mockLrc = "[00:10.00]Hello world\n[00:20.00]Second line";
    const mockFetch = async (url) => {
      return {
        ok: true,
        json: async () => ({
          trackName: "Hello",
          artistName: "Adele",
          syncedLyrics: mockLrc,
          plainLyrics: "Hello world\nSecond line",
        }),
      };
    };

    const res = await fetchLyrics("Hello", "Adele", 200, { fetchImpl: mockFetch });
    expect(res.ok).toBe(true);
    expect(res.synced).toBe(true);
    expect(res.lines.length).toBe(2);
    expect(res.lines[0].text).toBe("Hello world");
    expect(res.lines[1].time).toBe(20);
  });
});
