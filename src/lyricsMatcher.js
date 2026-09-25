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

export function scoreLyricsCandidate(candidate, { targetTitle, targetArtists = [], targetDurationSec = null }) {
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
    } else if (durationDiff <= 5) {
      score += 10; // Acceptable tolerance
    } else if (durationDiff <= 15) {
      score -= 10; // Minor difference
    } else if (durationDiff <= 35) {
      score -= 25; // Moderate difference (radio edit / single vs album cut)
    } else {
      score -= 60; // Major difference
    }
  }

  // 4. Version modifier check (prevent Remix vs Original, Live vs Studio, etc.)
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

  if (durationDiff !== null && durationDiff > 35) {
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
