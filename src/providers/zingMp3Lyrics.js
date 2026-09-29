// Provider for fetching synchronized LRC lyrics from Zing MP3
// Uses the public suggestions endpoint and direct CDN LRC downloads.

import { parseLrc } from "../lyricsService.js";
import { parseArtistListFromString } from "../spotify.js";

const ZING_SUGGEST_BASE = "https://ac.zingmp3.vn/v1/web/ac-suggestions";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// SSRF protection: Zing MP3 CDN/API domains allowed for LRC fetching
const ALLOWED_ZING_HOSTS = new Set([
  "zmdcdn.me",
  "zingmp3.vn",
  "ac.zingmp3.vn",
  "media.zingmp3.vn",
]);

/**
 * Returns true if a URL is safe to fetch LRC data from (must be HTTPS and on an allowed Zing host).
 * @param {string} rawUrl
 */
function isAllowedZingLrcUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("https://")) return false;
  try {
    const { hostname } = new URL(rawUrl);
    return [...ALLOWED_ZING_HOSTS].some(
      (h) => hostname === h || hostname.endsWith(`.${h}`)
    );
  } catch {
    return false;
  }
}

export function normalizeText(str = "") {
  if (typeof str !== "string") return "";
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractZingCandidates(data) {
  if (!data || typeof data !== "object") return [];
  const items = Array.isArray(data.items) ? data.items : (Array.isArray(data.data?.items) ? data.data.items : []);
  const candidates = [];

  for (const item of items) {
    if (!item) continue;
    if (item.title && (item.lyricLink || item.duration || item.id)) {
      candidates.push(item);
    }
    if (Array.isArray(item.suggestions)) {
      for (const s of item.suggestions) {
        if (s && s.title && (s.lyricLink || s.duration || s.id)) {
          candidates.push(s);
        }
      }
    }
  }

  return candidates;
}

const VARIATION_TAGS = ["remix", "cover", "karaoke", "beat", "instrumental", "parody"];

export function validateZingCandidate(cand, { targetTitle = "", targetArtist = "", targetArtists = [], targetDurationSec = null } = {}) {
  if (!cand || typeof cand !== "object") {
    return { valid: false, reason: "invalid_candidate" };
  }

  if (!cand.lyricLink || typeof cand.lyricLink !== "string" || !cand.lyricLink.trim()) {
    return { valid: false, reason: "no_lyric_link" };
  }

  // 1. Duration check (strict tolerance <= 4s to prevent out-of-sync lyrics)
  if (targetDurationSec && Number.isFinite(targetDurationSec) && cand.duration && Number.isFinite(cand.duration)) {
    const diff = Math.abs(cand.duration - targetDurationSec);
    if (diff > 4) {
      return { valid: false, reason: "duration_mismatch", diff };
    }
  }

  const normTargetTitle = normalizeText(targetTitle);
  const normCandTitle = normalizeText(cand.title || "");

  // 2. Variation tag check (remix, cover, etc.)
  for (const tag of VARIATION_TAGS) {
    if (normCandTitle.includes(tag) && !normTargetTitle.includes(tag)) {
      return { valid: false, reason: "variation_mismatch", tag };
    }
  }

  // 3. Title match validation (ensure candidate title has overlapping keywords with target title)
  if (normTargetTitle && normCandTitle) {
    const targetWords = normTargetTitle.split(" ").filter((w) => w.length >= 2);
    const candWords = normCandTitle.split(" ").filter((w) => w.length >= 2);
    const matchingWords = targetWords.filter((w) => candWords.includes(w));
    const matchRatio = targetWords.length > 0 ? matchingWords.length / targetWords.length : 0;

    if (matchingWords.length === 0 || (targetWords.length >= 2 && matchRatio < 0.35 && matchingWords.length < 2)) {
      return { valid: false, reason: "title_mismatch" };
    }
  }

  // 4. Artist check
  const allTargetArtists = Array.isArray(targetArtists) && targetArtists.length > 0
    ? targetArtists
    : parseArtistListFromString(targetArtist);

  if (allTargetArtists.length > 0) {
    const candArtistNames = Array.isArray(cand.artists)
      ? cand.artists.map((a) => (typeof a === "string" ? a : a?.name || "")).filter(Boolean)
      : [];

    const normCandArtistsText = candArtistNames.map(normalizeText).join(" ");

    // Check if at least one target artist matches
    const matched = allTargetArtists.some((t) => {
      const normT = normalizeText(t);
      if (!normT) return false;
      return normCandArtistsText.includes(normT) || normT.includes(normCandArtistsText);
    });

    if (!matched && candArtistNames.length > 0) {
      return { valid: false, reason: "artist_mismatch" };
    }
  }

  return { valid: true };
}

export async function fetchZingMp3Lyrics(
  title,
  artist = "",
  durationSec = null,
  { fetchImpl = globalThis.fetch, timeoutMs = 3500, artists = [] } = {}
) {
  if (!title || !title.trim()) {
    return { ok: false, error: "empty_title" };
  }

  const targetArtists = Array.isArray(artists) && artists.length > 0
    ? artists
    : parseArtistListFromString(artist);

  const primaryArtist = targetArtists[0] || artist || "";
  const queries = [
    primaryArtist ? `${primaryArtist} ${title}`.trim() : null,
    title.trim(),
  ].filter(Boolean);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let allCandidates = [];

    for (const q of queries) {
      try {
        const url = `${ZING_SUGGEST_BASE}?query=${encodeURIComponent(q)}`;
        const res = await fetchImpl(url, {
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json",
          },
          signal: controller.signal,
        });

        if (res.ok) {
          const json = await res.json();
          const list = extractZingCandidates(json);
          if (list.length > 0) {
            allCandidates.push(...list);
            // If we found a candidate with lyricLink and matching duration, stop querying
            const quickMatch = list.find((it) => {
              const v = validateZingCandidate(it, { targetTitle: title, targetArtist: artist, targetArtists, targetDurationSec: durationSec });
              return v.valid;
            });
            if (quickMatch) break;
          }
        }
      } catch {}
    }

    if (allCandidates.length === 0) {
      return { ok: false, error: "not_found" };
    }

    // Filter and score candidates
    const validCandidates = [];
    for (const cand of allCandidates) {
      const validation = validateZingCandidate(cand, {
        targetTitle: title,
        targetArtist: artist,
        targetArtists,
        targetDurationSec: durationSec,
      });
      if (validation.valid) {
        // Calculate match score
        const diff = durationSec && cand.duration ? Math.abs(cand.duration - durationSec) : 10;
        const normTitle = normalizeText(title);
        const normCand = normalizeText(cand.title || "");
        const titleExact = normTitle === normCand ? 20 : 0;
        const score = 100 - diff + titleExact;
        validCandidates.push({ cand, score });
      }
    }

    if (validCandidates.length === 0) {
      // Candidates were found on Zing MP3, but all disqualified (mismatched duration, wrong artist, etc.)
      return { ok: false, error: "no_matching_version" };
    }

    // Sort by highest score
    validCandidates.sort((a, b) => b.score - a.score);
    const best = validCandidates[0].cand;

    // SSRF guard: only fetch LRC from known Zing CDN / API domains
    if (!isAllowedZingLrcUrl(best.lyricLink)) {
      return { ok: false, error: "invalid_lyric_url" };
    }

    // Fetch the .lrc file from Zing CDN
    const lrcRes = await fetchImpl(best.lyricLink, {
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
    });

    if (!lrcRes.ok) {
      return { ok: false, error: "download_failed" };
    }

    const lrcText = await lrcRes.text();
    const lines = parseLrc(lrcText);

    if (lines.length === 0) {
      return { ok: false, error: "empty_lyrics" };
    }

    const candArtistName = Array.isArray(best.artists) && best.artists.length > 0
      ? best.artists.map((a) => (typeof a === "string" ? a : a?.name || "")).filter(Boolean).join(", ")
      : artist;

    return {
      ok: true,
      synced: true,
      source: "zingmp3",
      trackName: best.title || title,
      artistName: candArtistName || artist,
      lines,
    };
  } catch (err) {
    return {
      ok: false,
      error: err.name === "AbortError" ? "timeout" : "network_error",
    };
  } finally {
    clearTimeout(timer);
  }
}
