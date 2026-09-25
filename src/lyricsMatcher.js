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

const LOCALIZED_TAG_PATTERNS = [
  { lang: "japanese", regex: /(?:^|[^a-z0-9])(?:japan(?:ese)?(?:\s+(?:ver(?:sion)?|edition|tour|cut))?|jp\s+ver(?:sion)?|日本語)(?:$|[^a-z0-9])/i },
  { lang: "korean", regex: /(?:^|[^a-z0-9])(?:korea(?:n)?(?:\s+(?:ver(?:sion)?|edition))?|kr\s+ver(?:sion)?|한국어)(?:$|[^a-z0-9])/i },
  { lang: "chinese", regex: /(?:^|[^a-z0-9])(?:china|chinese|mandarin)(?:\s+(?:ver(?:sion)?|edition))?|cn\s+ver(?:sion)?|中文|国语(?:$|[^a-z0-9])/i },
  { lang: "english", regex: /(?:^|[^a-z0-9])(?:english(?:\s+(?:ver(?:sion)?|edition))?|eng\s+ver(?:sion)?)(?:$|[^a-z0-9])/i },
  { lang: "vietnamese", regex: /(?:^|[^a-z0-9])(?:vietnamese(?:\s+(?:ver(?:sion)?|edition))?|vn\s+ver(?:sion)?|tiếng\s+việt)(?:$|[^a-z0-9])/i },
  { lang: "spanish", regex: /(?:^|[^a-z0-9])(?:spanish(?:\s+(?:ver(?:sion)?|edition))?|español)(?:$|[^a-z0-9])/i },
];

export function extractLocalizedVersionTags(text) {
  if (typeof text !== "string" || !text) return [];
  const found = [];
  for (const { lang, regex } of LOCALIZED_TAG_PATTERNS) {
    if (regex.test(text)) {
      found.push(lang);
    }
  }
  return found;
}

export function analyzeScripts(text) {
  if (typeof text !== "string" || !text) {
    return { hangul: 0, kana: 0, hanzi: 0, vietnamese: 0, latin: 0, total: 0 };
  }
  // Strip LRC timestamps like [00:12.34] before analyzing
  const cleaned = text.replace(/\[\d{2}:\d{2}(?:\.\d{2,3})?\]/g, "");

  const hangul = (cleaned.match(/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/g) || []).length;
  const kana = (cleaned.match(/[\u3040-\u309F\u30A0-\u30FF]/g) || []).length;
  const vietnamese = (cleaned.match(/[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđĐ]/gi) || []).length;
  const hanzi = (cleaned.match(/[\u4E00-\u9FFF]/g) || []).length;
  const latin = (cleaned.match(/[a-zA-Z]/g) || []).length;
  const total = cleaned.replace(/\s+/g, "").length;

  return { hangul, kana, hanzi, vietnamese, latin, total };
}

const KPOP_ARTISTS_SET = new Set([
  "ikon", "bts", "blackpink", "twice", "newjeans", "seventeen", "stray kids",
  "exo", "red velvet", "nct", "nct 127", "nct dream", "nct u", "wayv", "aespa",
  "itzy", "txt", "tomorrow x together", "enhypen", "le sserafim", "ive", "bigbang",
  "big bang", "2ne1", "shinee", "super junior", "snsd", "girls generation",
  "iu", "taeyeon", "g-dragon", "gd", "jungkook", "v", "jimin", "suga", "agust d",
  "rm", "j-hope", "jin", "rose", "jennie", "lisa", "jisoo", "baekhyun", "taemin",
  "kai", "sunmi", "chungha", "jay park", "zico", "crush", "dean", "loco",
  "epik high", "day6", "the boyz", "ateez", "treasure", "zerobaseone", "zb1",
  "boynextdoor", "riize", "tws", "babymonster", "kiss of life", "illit",
  "fifty fifty", "mamamoo", "btob", "monsta x", "got7", "winner", "highlight",
  "beast", "infinite", "cnblue", "ftisland", "nmixx", "stayc", "kep1er",
  "fromis 9", "fromis_9", "wjsn", "cosmic girls", "oh my girl", "apink", "aoa",
  "exid", "sistar", "miss a", "kara", "wonder girls", "t-ara", "4minute",
  "tvxq", "dbsk", "jyj", "boa", "rain", "psy", "akmu", "akdong musician",
  "bol4", "bolbbalgan4", "davichi", "paul kim", "heize", "lee hi", "punch",
  "ailee", "k.will", "eric nam", "b.i", "bobby", "woodz", "kang daniel",
  "park jihoon", "ab6ix", "cix", "cravity", "p1harmony", "tempest", "xikers",
  "oneus", "onewe", "verivery", "pentagon", "sf9", "astro", "lucy",
  "xdinary heroes", "the rose", "qwer", "triples", "triple s", "artms",
  "loossemble", "chuu", "loona", "dreamcatcher", "everglow", "purple kiss",
  "billlie", "weeekly", "gfriend", "viviz", "izone", "iz*one", "wanna one",
  "x1", "unis", "katseye", "wave to earth", "the black skirts", "surl",
  "silica gel", "se so neon", "hyukoh", "zion.t", "zion t", "giriboy",
  "bewhy", "changmo", "ash island", "ph-1", "sik-k", "haon", "big naughty",
  "colde", "dpr ian", "dpr live"
]);

const VPOP_ARTISTS_SET = new Set([
  "son tung m-tp", "son tung", "hieuthuhai", "mono", "soobin", "soobin hoang son",
  "vu", "vu.", "den", "den vau", "hoang thuy linh", "amee", "min", "erik",
  "duc phuc", "hoa minzy", "jack - j97", "jack 97", "k-icm", "phan manh quynh",
  "b ray", "karik", "justatee", "bigdaddy", "emily", "rhymastic", "binz",
  "suboi", "tlinh", "mck", "wren evans", "grey d", "vu cat tuong", "tien tien",
  "trung quan idol", "trung quan", "bao anh", "huong tram", "noo phuoc thinh",
  "dong nhi", "toc tien", "isaac", "jun pham", "st son thach", "will",
  "365daband", "chillies", "ngot", "ca hoi hoang", "the cassette", "7uppercuts",
  "da lab", "low g", "thang", "obito", "seachains", "ricky star", "phap kieu",
  "quang hung masterd", "anh tu atus", "jsol", "duong domic", "rhyder",
  "captain boy", "hurrykng", "negav", "wean", "tage", "gill", "24k.right",
  "double2t", "my tam", "ha anh tuan", "le bao binh", "quan a.p", "quan ap",
  "tang duy tan", "chu thuy quynh", "nal", "dinh dung", "khai dang"
]);

const JPOP_ARTISTS_SET = new Set([
  "yoasobi", "kenshi yonezu", "ado", "fujii kaze", "aimyon",
  "official hige dandism", "king gnu", "vaundy", "radwimps", "eve", "lisa",
  "aimer", "milet", "yama", "yuuri", "back number", "one ok rock",
  "mrs. green apple", "mrs green apple", "sekai no owari", "man with a mission",
  "bump of chicken", "asian kung-fu generation", "spyair", "uverworld",
  "l'arc~en~ciel", "x japan", "babymetal", "atarashii gakko", "atarashii gakko!",
  "perfume", "kyary pamyu pamyu", "hikaru utada", "ayumi hamasaki",
  "namie amuro", "koda kumi", "misia", "shiina ringo", "tokyo jihen",
  "polkadot stingray", "zutomayo", "yorushika", "tuyu", "minami", "daoko",
  "reol", "lilas", "ikura", "ayase"
]);

export function detectTargetLanguage({ targetTitle = "", targetArtists = [], candidateHints = [] } = {}) {
  // 1. Explicit localized version in title takes highest precedence
  const explicitTags = extractLocalizedVersionTags(targetTitle);
  if (explicitTags.length > 0) {
    return explicitTags[0];
  }

  // 2. Script presence in target title or target artists
  const combinedTarget = `${targetTitle} ${targetArtists.join(" ")}`;
  const targetScripts = analyzeScripts(combinedTarget);
  if (targetScripts.hangul > 0) return "korean";
  if (targetScripts.kana > 0) return "japanese";
  if (targetScripts.vietnamese > 0) return "vietnamese";

  // 3. Known artist heritage
  for (const rawArtist of targetArtists) {
    const clean = stripDiacritics(normalizeSearchText(rawArtist));
    if (KPOP_ARTISTS_SET.has(clean)) return "korean";
    if (VPOP_ARTISTS_SET.has(clean)) return "vietnamese";
    if (JPOP_ARTISTS_SET.has(clean)) return "japanese";
  }

  // 4. Candidate pool consensus (if hints provided)
  if (Array.isArray(candidateHints) && candidateHints.length >= 2) {
    let hangulCandidates = 0;
    let kanaCandidates = 0;
    let vietnameseCandidates = 0;

    for (const c of candidateHints) {
      if (!c) continue;
      const text = `${c.trackName || ""} ${c.artistName || ""} ${c.albumName || ""} ${c.syncedLyrics || c.plainLyrics || ""}`;
      const s = analyzeScripts(text);
      if (s.hangul > 15) hangulCandidates++;
      if (s.kana > 15) kanaCandidates++;
      if (s.vietnamese > 5) vietnameseCandidates++;
    }

    if (hangulCandidates >= 2 && hangulCandidates >= kanaCandidates) return "korean";
    if (kanaCandidates >= 2 && kanaCandidates > hangulCandidates) return "japanese";
    if (vietnameseCandidates >= 2) return "vietnamese";
  }

  // 5. Default
  return "unknown";
}

export function scoreTitleMatch(targetTitle, candidateTrackName) {
  if (!targetTitle || !candidateTrackName) return 0;
  const tNorm = normalizeSearchText(targetTitle);
  const cNorm = normalizeSearchText(candidateTrackName);
  if (!tNorm || !cNorm) return 0;

  // Exact normalized match
  if (tNorm === cNorm) return 25;

  // Without diacritics
  const tNoDia = stripDiacritics(tNorm);
  const cNoDia = stripDiacritics(cNorm);
  if (tNoDia === cNoDia) return 25;

  // Substring containment: candidate contains target title or target title contains candidate
  if (cNorm.includes(tNorm) || tNorm.includes(cNorm) || cNoDia.includes(tNoDia) || tNoDia.includes(cNoDia)) {
    return 20;
  }

  // Word overlap: check how many words match
  const tWords = tNoDia.split(" ").filter((w) => w.length > 1);
  const cWords = cNoDia.split(" ").filter((w) => w.length > 1);
  if (tWords.length > 0 && cWords.length > 0) {
    const matchingWords = tWords.filter((w) => cWords.includes(w));
    const ratio = matchingWords.length / tWords.length;
    if (ratio >= 0.75) return 15;
    if (ratio >= 0.5) return 10;
    if (ratio > 0) return 5;
  }

  return -25; // Completely different title
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
  { targetTitle = "", targetArtists = [], targetDurationSec = null, candidateHints = [] } = {}
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

  // 4. Title match score
  if (targetTitle && candidate.trackName) {
    const titleScore = scoreTitleMatch(targetTitle, candidate.trackName);
    score += titleScore;
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

  // 6. Localized version tags (prevent Japanese Ver when Korean/English was requested)
  const targetLocTags = extractLocalizedVersionTags(targetTitle);
  const candidateLocTags = extractLocalizedVersionTags(`${candidate.trackName || ""} ${candidate.albumName || ""}`);
  const extraLocTags = candidateLocTags.filter((t) => !targetLocTags.includes(t));
  if (extraLocTags.length > 0) {
    score -= 70; // Reject unrequested localized language editions
  }

  // 7. Script & Language Analysis
  const lyricsText = candidate.syncedLyrics || candidate.plainLyrics || "";
  const lyricsScripts = analyzeScripts(lyricsText);
  const targetLang = detectTargetLanguage({ targetTitle, targetArtists, candidateHints });

  // Check if candidateHints has authentic native script entries
  const poolHasKorean = Array.isArray(candidateHints) && candidateHints.some((c) => {
    if (!c) return false;
    const text = `${c.trackName || ""} ${c.albumName || ""} ${c.syncedLyrics || c.plainLyrics || ""}`;
    return analyzeScripts(text).hangul > 15;
  });

  const poolHasJapanese = Array.isArray(candidateHints) && candidateHints.some((c) => {
    if (!c) return false;
    const text = `${c.trackName || ""} ${c.albumName || ""} ${c.syncedLyrics || c.plainLyrics || ""}`;
    return analyzeScripts(text).kana > 15;
  });

  const poolHasVietnamese = Array.isArray(candidateHints) && candidateHints.some((c) => {
    if (!c) return false;
    const text = `${c.trackName || ""} ${c.albumName || ""} ${c.syncedLyrics || c.plainLyrics || ""}`;
    return analyzeScripts(text).vietnamese > 5;
  });

  let languageMismatchReason = null;

  if (targetLang === "korean") {
    if (lyricsScripts.hangul > 10) {
      score += 30; // Native Hangul bonus!
    } else if (lyricsScripts.kana > 10 && lyricsScripts.hangul === 0) {
      // Conflicting Japanese Kana lyrics for Korean song
      if (poolHasKorean || extraLocTags.includes("japanese") || candidateHints.length === 0) {
        score -= 80;
        languageMismatchReason = "unwanted_japanese_version";
      }
    } else if (poolHasKorean && lyricsScripts.hangul === 0) {
      score -= 20; // Authentic Hangul exists in pool, prefer Hangul over Romanized
    }
  } else if (targetLang === "vietnamese") {
    if (lyricsScripts.vietnamese > 5) {
      score += 30; // Native Vietnamese bonus!
    } else if ((lyricsScripts.kana > 10 || lyricsScripts.hangul > 10) && lyricsScripts.vietnamese === 0) {
      score -= 80;
      languageMismatchReason = "language_mismatch";
    } else if (poolHasVietnamese && lyricsScripts.vietnamese === 0) {
      score -= 20;
    }
  } else if (targetLang === "japanese") {
    if (lyricsScripts.kana > 10) {
      score += 30; // Native Japanese bonus!
    } else if (lyricsScripts.hangul > 10 && lyricsScripts.kana === 0) {
      score -= 80;
      languageMismatchReason = "unwanted_korean_version";
    } else if (poolHasJapanese && lyricsScripts.kana === 0) {
      if (!targetLocTags.includes("english")) {
        score -= 50; // Prefer authentic Japanese over English adaptation
      }
    }
  } else if (targetLang === "english" || targetLang === "unknown") {
    if (extraLocTags.includes("japanese") || (lyricsScripts.kana > 20 && lyricsScripts.latin < 50)) {
      score -= 70;
      languageMismatchReason = "unwanted_japanese_version";
    } else if (extraLocTags.includes("korean") || (lyricsScripts.hangul > 20 && lyricsScripts.latin < 50)) {
      score -= 70;
      languageMismatchReason = "unwanted_korean_version";
    }
  }

  let isAcceptable = score >= 50 && !languageMismatchReason;
  let reason = "acceptable";

  if (languageMismatchReason) {
    isAcceptable = false;
    reason = languageMismatchReason;
  } else if (extraLocTags.length > 0) {
    isAcceptable = false;
    reason = "unwanted_localized_version";
  } else if (targetArtists.length >= 2 && !allArtistsMatched) {
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

