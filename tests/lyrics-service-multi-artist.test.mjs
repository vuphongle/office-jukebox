import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fetchLyrics, prefetchLyricsForTrack, clearLyricsCache } from "../src/lyricsService.js";

describe("Lyrics Service Multi-Artist Search & Candidate Selection", () => {
  beforeEach(() => {
    clearLyricsCache();
  });
  test("Prefers exact multi-artist candidate over an earlier single-artist cover in search results", async () => {
    const mockSearchResults = [
      {
        id: 101,
        trackName: "Ngáo Ngơ",
        artistName: "Ca Sĩ Cover A",
        duration: 215,
        syncedLyrics: "[00:01.00]Cover lyrics...",
      },
      {
        id: 102,
        trackName: "Ngáo Ngơ",
        artistName: "HIEUTHUHAI, ERIK, Anh Tú Atus, JSOL",
        duration: 216,
        syncedLyrics: "[00:01.00]Official multi-artist lyrics...",
      },
    ];

    const mockFetch = async (url) => {
      if (url.includes("/api/get")) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      if (url.includes("/api/search")) {
        return {
          ok: true,
          status: 200,
          json: async () => mockSearchResults,
        };
      }
      return { ok: false, status: 404 };
    };

    const res = await fetchLyrics(
      "Ngáo Ngơ",
      "HIEUTHUHAI, ERIK, Anh Tú Atus, JSOL",
      215,
      {
        artists: ["HIEUTHUHAI", "ERIK", "Anh Tú Atus", "JSOL"],
        fetchImpl: mockFetch,
        timeoutMs: 1000,
      }
    );

    assert.ok(res.ok);
    assert.equal(res.artistName, "HIEUTHUHAI, ERIK, Anh Tú Atus, JSOL");
    assert.equal(res.lines[0].text, "Official multi-artist lyrics...");
  });

  test("Returns error: 'no_matching_version' when LRCLIB only has wrong covers or wildly different durations", async () => {
    const badResults = [
      {
        id: 201,
        trackName: "Ngáo Ngơ (Remix 140BPM)",
        artistName: "Random DJ",
        duration: 120, // 2:00 vs 3:35
        syncedLyrics: "[00:01.00]Remix...",
      },
    ];

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => badResults,
    });

    const res = await fetchLyrics("Ngáo Ngơ", "HIEUTHUHAI, ERIK", 215, {
      artists: ["HIEUTHUHAI", "ERIK"],
      fetchImpl: mockFetch,
    });

    assert.equal(res.ok, false);
    assert.ok(res.error === "no_matching_version" || res.error === "not_found");
  });

  test("prefetchLyricsForTrack warms cache in background and returns payload", async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        trackName: "Easy On Me",
        artistName: "Adele",
        duration: 224,
        syncedLyrics: "[00:05.00]Go easy on me baby",
      }),
    });

    const res = await prefetchLyricsForTrack({
      title: "Easy On Me",
      artist: "Adele",
      artists: ["Adele"],
      durationSec: 224,
      fetchImpl: mockFetch,
    });

    assert.ok(res);
    assert.equal(res.ok, true);
    assert.equal(res.lines[0].text, "Go easy on me baby");
  });
});
