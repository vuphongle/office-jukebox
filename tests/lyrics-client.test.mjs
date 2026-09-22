import { test, describe, expect } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadLyricsClient() {
  const code = readFileSync(path.join(ROOT, "public/lyrics-client.js"), "utf8");
  const context = {
    window: {},
    fetch: globalThis.fetch,
    URLSearchParams: globalThis.URLSearchParams,
    AbortController: globalThis.AbortController,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    encodeURIComponent: globalThis.encodeURIComponent,
    console: globalThis.console,
  };
  vm.runInNewContext(code, context);
  return context.window.JukeboxLyrics;
}

describe("JukeboxLyrics Client Module", () => {
  const JukeboxLyrics = loadLyricsClient();

  test("cleanLyricsQuery strips video/audio noise, ft/feat, and Topic", () => {
    const r1 = JukeboxLyrics.cleanLyricsQuery("Bài Hát Này Hay Quá [Official MV]", "Ca Sĩ A - Topic");
    expect(r1.title).toBe("Bài Hát Này Hay Quá");
    expect(r1.artist).toBe("Ca Sĩ A");

    const r2 = JukeboxLyrics.cleanLyricsQuery("Hit Song (feat. Rapper B)", "Singer A");
    expect(r2.title).toBe("Hit Song");
    expect(r2.artist).toBe("Singer A");

    const r3 = JukeboxLyrics.cleanLyricsQuery("Another Hit - feat. Rapper C", "Singer D");
    expect(r3.title).toBe("Another Hit");
    expect(r3.artist).toBe("Singer D");

    const r4 = JukeboxLyrics.cleanLyricsQuery("Artist X - Track Y", "");
    expect(r4.title).toBe("Track Y");
    expect(r4.artist).toBe("Artist X");
  });

  test("parseLrc parses timestamps and sorts chronologically", () => {
    const lrc = `
[00:12.50]Dòng đầu tiên
[00:05.10]Khởi đầu bài hát
[00:20.00]Kết thúc câu
`;
    const parsed = JukeboxLyrics.parseLrc(lrc);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({ time: 5.1, text: "Khởi đầu bài hát" });
    expect(parsed[1]).toEqual({ time: 12.5, text: "Dòng đầu tiên" });
    expect(parsed[2]).toEqual({ time: 20, text: "Kết thúc câu" });
  });

  test("parseLrc handles invalid, empty or non-string inputs", () => {
    expect(JukeboxLyrics.parseLrc("")).toEqual([]);
    expect(JukeboxLyrics.parseLrc(null)).toEqual([]);
    expect(JukeboxLyrics.parseLrc("Không có timestamp")).toEqual([]);
  });

  test("parseLrc applies [offset:+/-ms] tags accurately", () => {
    const lrcPositive = `
[offset:+500]
[00:10.00]Lời bài hát trễ nửa giây
`;
    const parsedPos = JukeboxLyrics.parseLrc(lrcPositive);
    expect(parsedPos).toHaveLength(1);
    expect(parsedPos[0]).toEqual({ time: 10.5, text: "Lời bài hát trễ nửa giây" });

    const lrcNegative = `
[offset:-400]
[00:05.50]Lời bài hát sớm 400ms
`;
    const parsedNeg = JukeboxLyrics.parseLrc(lrcNegative);
    expect(parsedNeg).toHaveLength(1);
    expect(parsedNeg[0]).toEqual({ time: 5.1, text: "Lời bài hát sớm 400ms" });
  });

  test("fetchLyricsClient queries local API then falls back to LRCLIB", async () => {
    // 1. Local API success
    const mockFetchLocal = async (url) => {
      if (url.startsWith("/api/lyrics")) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            synced: true,
            lines: [{ time: 10, text: "Local lyric line" }],
          }),
        };
      }
      throw new Error("unexpected URL");
    };

    const resLocal = await JukeboxLyrics.fetchLyricsClient({
      title: "Test Song",
      artist: "Test Artist",
      fetchImpl: mockFetchLocal,
    });
    expect(resLocal?.ok).toBe(true);
    expect(resLocal?.lines[0].text).toBe("Local lyric line");

    // 2. Local fails, fallback to LRCLIB
    const mockFetchFallback = async (url) => {
      if (url.startsWith("/api/lyrics")) {
        return { ok: false, status: 404 };
      }
      if (url.includes("lrclib.net/api/search")) {
        return {
          ok: true,
          json: async () => [
            {
              trackName: "Test Song",
              artistName: "Test Artist",
              syncedLyrics: "[00:08.00]Fallback line from LRCLIB",
            },
          ],
        };
      }
      throw new Error("unexpected URL " + url);
    };

    const resFallback = await JukeboxLyrics.fetchLyricsClient({
      title: "Test Song",
      artist: "Test Artist",
      fetchImpl: mockFetchFallback,
    });
    expect(resFallback?.ok).toBe(true);
    expect(resFallback?.synced).toBe(true);
    expect(resFallback?.lines[0].text).toBe("Fallback line from LRCLIB");
    expect(resFallback?.lines[0].time).toBe(8);
  });
});
