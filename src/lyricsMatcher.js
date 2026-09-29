// Candidate scoring and multi-artist containment engine for lyrics matching.

export function stripDiacritics(str) {
  if (typeof str !== "string") return "";
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

export function normalizeSearchText(str) {
  if (typeof str !== "string") return "";
  return str
    .toLowerCase()
    .replace(/["'“”‘’`]/g, "")
    .replace(/[–—_]/g, "-")
    .replace(/[()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const VERSION_MODIFIERS = [
  "remix",
  "acoustic",
  "live",
  "cover",
  "instrumental",
  "karaoke",
  "speed up",
  "slowed",
  "nightcore",
  "edit",
];

export function extractVersionTags(text) {
  const norm = normalizeSearchText(text);
  return VERSION_MODIFIERS.filter((mod) => {
    const esc = mod.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(?:^|[^a-z0-9])${esc}(?:$|[^a-z0-9])`, "i");
    return regex.test(norm);
  });
}

export function detectTrackVersionType(rawTitle = "", rawArtist = "") {
  const title = (rawTitle || "").trim();
  const artist = (rawArtist || "").trim();

  // 1. Official MV / Video clip / Short film / Phim ca nhạc
  const isMv = /\b(?:official\s*(?:music\s*)?video|official\s*mv|\bmv\b|\bm\/v\b|music\s*video|video\s*clip|phim\s*ca\s*nh\u1ea1c|short\s*film)\b/i.test(title);

  // 2. Live, Concert, Performance, Acoustic, Remix, Cover, Speed Up, Slowed
  const isSpecialPerformance = /\b(?:live\s*(?:session|at|performance|acoustic)?|concert|performance\s*video|acoustic|remix|cover|dance\s*practice|speed\s*up|slowed)\b/i.test(title);

  // 3. Audio / Visualizer / Lyric Video / Topic
  const isAudioOrVisualizer = /\b(?:official\s*audio|audio\s*only|\baudio\b|official\s*visualizer|visualizer|lyric\s*video|video\s*lyric)\b/i.test(title) ||
    artist.toLowerCase().endsWith(" - topic");

  return {
    isMv,
    isSpecialPerformance,
    isAudioOrVisualizer,
  };
}

export function containsArtist(haystack, artistName) {
  if (!haystack || !artistName) return false;
  const hNorm = normalizeSearchText(haystack);
  const aNorm = normalizeSearchText(artistName);

  if (!hNorm || !aNorm) return false;

  // 1. Exact normalized match with word boundary check
  const escaped = aNorm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i");
  if (regex.test(hNorm)) return true;

  // 2. Fallback to diacritic-free match
  const hNoDia = stripDiacritics(hNorm);
  const aNoDia = stripDiacritics(aNorm);
  const escNoDia = aNoDia.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regexNoDia = new RegExp(`(?:^|[^a-z0-9])${escNoDia}(?:$|[^a-z0-9])`, "i");
  return regexNoDia.test(hNoDia);
}

export function scoreLyricsCandidate(
  candidate,
  { targetTitle, targetArtists = [], targetDurationSec = null, maxDurationDiff = 2, isStrictDuration = false } = {}
) {
  if (!candidate || typeof candidate !== "object") {
    return {
      score: 0,
      allArtistsMatched: false,
      matchedArtists: [],
      missingArtists: targetArtists,
      isAcceptable: false,
      reason: "invalid_candidate",
    };
  }

  const combinedCandidateText = `${candidate.trackName || ""} ${candidate.artistName || ""}`;
  const matchedArtists = [];
  const missingArtists = [];

  for (const artist of targetArtists) {
    if (containsArtist(combinedCandidateText, artist)) {
      matchedArtists.push(artist);
    } else {
      missingArtists.push(artist);
    }
  }

  const allArtistsMatched = targetArtists.length > 0 && missingArtists.length === 0;
  const artistMatchRatio = targetArtists.length > 0 ? matchedArtists.length / targetArtists.length : 0.5;

  let score = 0;

  // 1. Artist overlap score (up to 50 pts)
  if (allArtistsMatched) {
    score += 50;
  } else {
    score += Math.round(artistMatchRatio * 35);
  }

  // 2. Synced vs Plain (up to 30 pts)
  const hasSynced = Boolean(candidate.syncedLyrics && typeof candidate.syncedLyrics === "string" && candidate.syncedLyrics.trim());
  const hasPlain = Boolean(candidate.plainLyrics && typeof candidate.plainLyrics === "string" && candidate.plainLyrics.trim());

  if (hasSynced) score += 30;
  else if (hasPlain) score += 10;
  else {
    return {
      score: 0,
      allArtistsMatched,
      matchedArtists,
      missingArtists,
      isAcceptable: false,
      reason: "no_lyrics_content",
    };
  }

  // 3. Duration match (up to 20 pts or penalty)
  let durationDiff = null;
  if (targetDurationSec && Number.isFinite(targetDurationSec) && candidate.duration && Number.isFinite(candidate.duration)) {
    durationDiff = Math.abs(candidate.duration - targetDurationSec);
    if (durationDiff <= 2) {
      score += 20; // Excellent match
    } else if (durationDiff <= 4) {
      score += 10; // Acceptable tolerance (<= 4s)
    } else if (durationDiff <= 8) {
      score -= 20; // Minor difference
    } else if (durationDiff <= 15) {
      score -= 45; // Moderate difference
    } else {
      score -= 80; // Major difference (intro/outro/alternate cut)
    }
  }

  // 4. Title similarity check (prevent matching a completely different song by the same artist)
  if (targetTitle && candidate.trackName) {
    const normTarget = stripDiacritics(normalizeSearchText(targetTitle)).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    const normCand = stripDiacritics(normalizeSearchText(candidate.trackName)).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    
    if (normTarget && normCand && normTarget !== normCand && !normTarget.includes(normCand) && !normCand.includes(normTarget)) {
      const targetWords = normTarget.split(" ").filter((w) => w.length >= 2);
      const candWords = normCand.split(" ").filter((w) => w.length >= 2);
      const matchingWords = targetWords.filter((w) => candWords.includes(w));
      const matchRatio = targetWords.length > 0 ? matchingWords.length / targetWords.length : 0;
      
      if (matchingWords.length === 0 || (targetWords.length >= 2 && matchRatio < 0.35 && matchingWords.length < 2)) {
        return {
          score: 0,
          allArtistsMatched,
          matchedArtists,
          missingArtists,
          isAcceptable: false,
          reason: "title_mismatch",
        };
      }
    }
  }

  // 5. Version modifier check (prevent Remix vs Original, Live vs Studio, etc.)
  const targetTags = extractVersionTags(targetTitle);
  const candidateTags = extractVersionTags(combinedCandidateText);

  // If candidate has a version tag that target DOES NOT have
  const extraCandidateTags = candidateTags.filter((t) => !targetTags.includes(t));
  if (extraCandidateTags.length > 0) {
    if (extraCandidateTags.includes("cover") || extraCandidateTags.includes("karaoke") || extraCandidateTags.includes("tribute")) {
      score -= 70; // Reject covers
    } else if (extraCandidateTags.includes("remix") || extraCandidateTags.includes("acoustic") || extraCandidateTags.includes("live") || extraCandidateTags.includes("speed up") || extraCandidateTags.includes("slowed")) {
      score -= 50;
    }
  }

  let isAcceptable = score >= 50;
  let reason = "acceptable";

  if (targetArtists.length >= 2 && !allArtistsMatched) {
    // Collab track: accept if primary artist matched and duration difference is acceptable (<= 25s)
    if (matchedArtists.length === 0 || (durationDiff !== null && durationDiff > 25)) {
      isAcceptable = false;
      reason = "missing_collaborating_artists";
    }
  } else if (targetArtists.length === 1 && matchedArtists.length === 0) {
    isAcceptable = false;
    reason = "artist_mismatch";
  }

  const maxAllowedDiff = isStrictDuration ? (maxDurationDiff ?? 2) : 15;
  if (durationDiff !== null && durationDiff > maxAllowedDiff) {
    isAcceptable = false;
    reason = "duration_mismatch";
  }

  if (extraCandidateTags.includes("cover") && !targetTags.includes("cover")) {
    isAcceptable = false;
    reason = "unwanted_cover";
  }

  return {
    score: Math.max(0, score),
    allArtistsMatched,
    matchedArtists,
    missingArtists,
    isAcceptable,
    durationDiff,
    reason,
  };
}
