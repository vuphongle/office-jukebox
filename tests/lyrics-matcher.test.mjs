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

  test("Rejects unrequested Japanese localized version when track is Korean (LOVE SCENARIO iKON)", () => {
    const targetKpop = {
      targetTitle: "LOVE SCENARIO",
      targetArtists: ["iKON"],
      targetDurationSec: 209,
    };

    const japaneseCandidate = {
      id: 3674254,
      trackName: "LOVE SCENARIO",
      artistName: "iKON",
      duration: 209,
      syncedLyrics: "[00:03.04] 恋に落ちた僕たちは\n[00:08.01] 消えはしない思い出になる\n[00:10.06] 感動のメロドラマは",
    };

    const koreanCandidate = {
      id: 12866360,
      trackName: "사랑을 했다 (LOVE SCENARIO)",
      artistName: "iKON",
      duration: 209,
      syncedLyrics: "[00:02.15] 사랑을 했다 우리가 만나\n[00:05.79] 지우지 못할 추억이 됐다\n[00:09.14] 볼만한 멜로드라마",
    };

    const pool = [japaneseCandidate, koreanCandidate];

    const scoreJp = scoreLyricsCandidate(japaneseCandidate, {
      ...targetKpop,
      candidateHints: pool,
    });
    const scoreKr = scoreLyricsCandidate(koreanCandidate, {
      ...targetKpop,
      candidateHints: pool,
    });

    assert.equal(scoreJp.isAcceptable, false);
    assert.equal(scoreJp.reason, "unwanted_japanese_version");
    assert.equal(scoreKr.isAcceptable, true);
    assert.ok(scoreKr.score > scoreJp.score);
    assert.ok(scoreKr.score >= 120);
  });

  test("Supports multilingual K-Pop songs with Korean verses and English chorus/rap without penalty", () => {
    const targetMultilingual = {
      targetTitle: "How You Like That",
      targetArtists: ["BLACKPINK"],
      targetDurationSec: 182,
    };

    const candidate = {
      trackName: "How You Like That",
      artistName: "BLACKPINK",
      duration: 182,
      syncedLyrics: "[00:01.00] 보란 듯이 무너졌어\n[00:04.00] 바닥을 뚫고 저 지하까지\n[00:15.00] How you like that, that-that-that-that\n[00:20.00] Now look at you, now look at me",
    };

    const res = scoreLyricsCandidate(candidate, targetMultilingual);
    assert.equal(res.isAcceptable, true);
    assert.equal(res.allArtistsMatched, true);
    assert.ok(res.score >= 120);
  });

  test("Supports 100% English songs by Korean artists (BTS Dynamite) without false rejection", () => {
    const targetEnglish = {
      targetTitle: "Dynamite",
      targetArtists: ["BTS"],
      targetDurationSec: 199,
    };

    const candidate = {
      trackName: "Dynamite",
      artistName: "BTS",
      duration: 199,
      syncedLyrics: "[00:00.10] 'Cause I, I, I'm in the stars tonight\n[00:04.02] So, watch me bring the fire and set the night alight",
    };

    const res = scoreLyricsCandidate(candidate, {
      ...targetEnglish,
      candidateHints: [candidate],
    });
    assert.equal(res.isAcceptable, true);
    assert.ok(res.score >= 100);
  });

  test("Supports Japanese original songs by Korean artists (BTS Film Out) where no Korean version exists", () => {
    const targetJapanese = {
      targetTitle: "Film out",
      targetArtists: ["BTS"],
      targetDurationSec: 214,
    };

    const candidate = {
      trackName: "Film out",
      artistName: "BTS",
      duration: 214,
      syncedLyrics: "[00:00.56] 浮かび上がる君は\n[00:06.62] あまりに鮮やかで Oh-oh\n[00:12.42] まるでそこにいるかと",
    };

    const res = scoreLyricsCandidate(candidate, {
      ...targetJapanese,
      candidateHints: [candidate],
    });
    assert.equal(res.isAcceptable, true);
    assert.ok(res.score >= 100);
  });

  test("Respects explicit language version when user requests Japanese Ver", () => {
    const targetExplicit = {
      targetTitle: "LOVE SCENARIO (Japanese Ver.)",
      targetArtists: ["iKON"],
      targetDurationSec: 209,
    };

    const japaneseCandidate = {
      id: 3674254,
      trackName: "LOVE SCENARIO",
      artistName: "iKON",
      duration: 209,
      syncedLyrics: "[00:03.04] 恋に落ちた僕たちは\n[00:08.01] 消えはしない思い出になる",
    };

    const koreanCandidate = {
      id: 12866360,
      trackName: "사랑을 했다 (LOVE SCENARIO)",
      artistName: "iKON",
      duration: 209,
      syncedLyrics: "[00:02.15] 사랑을 했다 우리가 만나\n[00:05.79] 지우지 못할 추억이 됐다",
    };

    const scoreJp = scoreLyricsCandidate(japaneseCandidate, targetExplicit);
    const scoreKr = scoreLyricsCandidate(koreanCandidate, targetExplicit);

    assert.equal(scoreJp.isAcceptable, true);
    assert.ok(scoreJp.score > scoreKr.score);
  });

  test("Prefers authentic Japanese Kana over unrequested English translation for Japanese artists", () => {
    const targetJpop = {
      targetTitle: "Idol",
      targetArtists: ["YOASOBI"],
      targetDurationSec: 213,
    };

    const japaneseCandidate = {
      trackName: "Idol",
      artistName: "YOASOBI",
      duration: 226,
      syncedLyrics: "[00:00.89] 無敵の笑顔で荒らすメディア\n[00:03.78] 知りたいその秘密ミステリアス",
    };

    const englishCandidate = {
      trackName: "Idol",
      artistName: "YOASOBI",
      duration: 213,
      syncedLyrics: "[00:00.58] Couldn't beat her smile; it stirred up all the media\n[00:03.54] Secret side, I wanna know it",
    };

    const pool = [japaneseCandidate, englishCandidate];

    const scoreJp = scoreLyricsCandidate(japaneseCandidate, {
      ...targetJpop,
      candidateHints: pool,
    });
    const scoreEn = scoreLyricsCandidate(englishCandidate, {
      ...targetJpop,
      candidateHints: pool,
    });

    assert.ok(scoreJp.score > scoreEn.score);
  });
});

