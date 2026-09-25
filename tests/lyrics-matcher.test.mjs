import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { scoreLyricsCandidate, normalizeSearchText, containsArtist } from "../src/lyricsMatcher.js";

describe("Lyrics Matcher & Candidate Scoring", () => {
  const target = {
    targetTitle: "Ngáo Ngơ",
    targetArtists: ["HIEUTHUHAI", "ERIK", "Anh Tú Atus", "JSOL"],
    targetDurationSec: 215, // 3:35
  };

  test("Gives top score to candidate having ALL artists, synced lyrics, and matching duration", () => {
    const candidate = {
      trackName: "Ngáo Ngơ",
      artistName: "HIEUTHUHAI, ERIK, Anh Tú Atus, JSOL",
      duration: 216,
      syncedLyrics: "[00:10.00]Lời bài hát...",
      plainLyrics: "Lời bài hát...",
    };

    const res = scoreLyricsCandidate(candidate, target);
    assert.equal(res.allArtistsMatched, true);
    assert.equal(res.missingArtists.length, 0);
    assert.ok(res.isAcceptable);
    assert.ok(res.score >= 100);
  });

  test("Recognizes artists even if featured in trackName instead of artistName", () => {
    const candidate = {
      trackName: "Ngáo Ngơ (feat. ERIK, Anh Tú Atus, JSOL)",
      artistName: "HIEUTHUHAI",
      duration: 214,
      syncedLyrics: "[00:10.00]Lời...",
    };

    const res = scoreLyricsCandidate(candidate, target);
    assert.equal(res.allArtistsMatched, true);
    assert.ok(res.isAcceptable);
  });

  test("Disqualifies candidate from a completely different cover artist", () => {
    const coverCandidate = {
      trackName: "Ngáo Ngơ (Cover)",
      artistName: "Nguyễn Văn A",
      duration: 210,
      syncedLyrics: "[00:05.00]Cover...",
    };

    const res = scoreLyricsCandidate(coverCandidate, target);
    assert.equal(res.allArtistsMatched, false);
    assert.equal(res.isAcceptable, false);
    assert.ok(res.score < 30);
  });

  test("Penalizes / rejects Remix version when target song is original and duration differs > 15s", () => {
    const remixCandidate = {
      trackName: "Ngáo Ngơ - Remix",
      artistName: "HIEUTHUHAI, ERIK, Anh Tú Atus, JSOL",
      duration: 150, // 2:30 vs 3:35
      syncedLyrics: "[00:02.00]Remix...",
    };

    const res = scoreLyricsCandidate(remixCandidate, target);
    assert.equal(res.isAcceptable, false);
  });

  test("Matches Vietnamese names with or without diacritics and smart quotes", () => {
    const candidate = {
      trackName: "Chay Ngay Di",
      artistName: "Son Tung M-TP, Snoop Dogg",
      duration: 198,
      syncedLyrics: "[00:01.00]Chay ngay di...",
    };
    const tg = {
      targetTitle: "Chạy Ngay Đi",
      targetArtists: ["Sơn Tùng M-TP", "Snoop Dogg"],
      targetDurationSec: 200,
    };
    const res = scoreLyricsCandidate(candidate, tg);
    assert.equal(res.allArtistsMatched, true);
    assert.ok(res.isAcceptable);
  });

  test("containsArtist does not false positive on substrings like 'An' inside 'Anh Tú'", () => {
    assert.equal(containsArtist("Anh Tú Atus", "An"), false);
    assert.equal(containsArtist("An ft. Anh Tú", "An"), true);
  });
});
