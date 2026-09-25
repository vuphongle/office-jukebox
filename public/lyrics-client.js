(function attachJukeboxLyrics(global) {
  function cleanLyricsQuery(rawTitle, rawArtist) {
    let title = (rawTitle || "").trim();
    let artist = (rawArtist || "").trim();
    if (!artist && title.includes(" - ")) {
      const parts = title.split(" - ");
      artist = parts[0].trim();
      title = parts.slice(1).join(" - ").trim();
    }
    title = title
      .replace(/\[[^\]]*\]/g, "")
      .replace(/\([^)]*(?:official|video|audio|mv|prod\.|feat\.|ft\.)[^)]*\)/gi, "")
      .replace(/\|.*$/g, "")
      .replace(/-.*(?:official|mv|audio).*$/gi, "")
      .replace(/\s*(?:-\s*)?(?:feat\.|ft\.).*$/gi, "")
      .trim();
    artist = artist.replace(/\s*-\s*Topic$/i, "").trim();
    return { title, artist };
  }

  function parseLrc(lrcText) {
    if (typeof lrcText !== "string" || !lrcText.trim()) return [];
    const lines = lrcText.split("\n");
    const result = [];
    let offsetMs = 0;
    const timeRegex = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\](.*)/;
    const offsetRegex = /^\[offset:\s*([+-]?\d+)\s*\]/i;

    for (const line of lines) {
      const offsetMatch = line.match(offsetRegex);
      if (offsetMatch) {
        offsetMs = parseInt(offsetMatch[1], 10) || 0;
        continue;
      }
      const match = line.match(timeRegex);
      if (match) {
        const min = parseInt(match[1], 10);
        const sec = parseInt(match[2], 10);
        const ms = match[3] ? parseInt(match[3].padEnd(3, "0").slice(0, 3), 10) : 0;
        const time = Math.max(0, min * 60 + sec + (ms + offsetMs) / 1000);
        const text = match[4].trim();
        if (text) {
          result.push({ time, text });
        }
      }
    }
    return result.sort((a, b) => a.time - b.time);
  }

  async function fetchLyricsClient({
    title: rawTitle,
    artist: rawArtist = "",
    artists = [],
    durationSec = null,
    fetchImpl = global.fetch || fetch,
    timeoutMs = 6000,
  } = {}) {
    const { title, artist } = cleanLyricsQuery(rawTitle, rawArtist);
    if (!title) return null;

    // 1. Try local backend /api/lyrics first
    try {
      const params = new URLSearchParams({ title, artist });
      if (Array.isArray(artists) && artists.length > 0) {
        params.set("artists", JSON.stringify(artists));
      }
      if (durationSec && Number.isFinite(durationSec)) {
        params.set("duration", Math.round(durationSec));
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetchImpl(`/api/lyrics?${params.toString()}`, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const json = await res.json();
        if (json.ok && Array.isArray(json.lines) && json.lines.length > 0) {
          return json;
        }
      }
    } catch {}

    // 2. Direct browser fallback to LRCLIB API with smart queries
    try {
      const baseTitle = title
        .replace(/\([^)]*(?:ver(?:sion)?|edition|tour|cut)[^)]*\)/gi, "")
        .replace(/-.*(?:ver(?:sion)?|edition|tour|cut).*$/gi, "")
        .trim();

      const targetArtists = Array.isArray(artists) && artists.length > 0
        ? artists
        : (artist ? [artist.split(/[,;]/)[0].trim()] : []);
      const primaryArtist = targetArtists[0] || (artist ? artist.split(/[,;]/)[0].replace(/["']/g, "").trim() : "");
      const featuredStr = targetArtists.slice(1).join(" ");
      const searchQueries = [
        primaryArtist && featuredStr ? `${primaryArtist} ${featuredStr} ${title}` : null,
        primaryArtist ? `${primaryArtist} ${title}` : (artist ? `${artist} ${title}` : null),
        baseTitle && baseTitle !== title && primaryArtist ? `${primaryArtist} ${baseTitle}` : null,
        artist && artist !== primaryArtist ? `${artist} ${title}` : null,
        title,
        baseTitle && baseTitle !== title ? baseTitle : null,
      ].filter(Boolean);

      function analyzeScriptsSimple(text) {
        if (!text) return { hangul: 0, kana: 0, vietnamese: 0 };
        const hangul = (text.match(/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/g) || []).length;
        const kana = (text.match(/[\u3040-\u309F\u30A0-\u30FF]/g) || []).length;
        const vietnamese = (text.match(/[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđĐ]/gi) || []).length;
        return { hangul, kana, vietnamese };
      }

      const wantsJapanese = /japan(?:ese)?|jp\s+ver|日本語/i.test(title);
      const wantsKorean = /korea(?:n)?|kr\s+ver|한국어/i.test(title);
      const wantsEnglish = /english|eng\s+ver/i.test(title);
      const hasHangul = /[\uAC00-\uD7AF]/.test(title + " " + primaryArtist);
      const isKpopArtist = /\b(ikon|bts|blackpink|twice|newjeans|seventeen|stray kids|exo|red velvet|aespa|itzy|txt|enhypen|le sserafim|ive|bigbang|iu|taeyeon)\b/i.test(primaryArtist);
      const isTargetKorean = (hasHangul || isKpopArtist || wantsKorean) && !wantsJapanese && !wantsEnglish;
      const isTargetVietnamese = /[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđĐ]/i.test(title + " " + primaryArtist);

      const candidateMap = new Map();
      const addCandidate = (cand) => {
        if (!cand || typeof cand !== "object") return;
        const idKey = cand.id != null ? `id_${cand.id}` : `${cand.artistName || ""}:::${cand.trackName || ""}`;
        if (!candidateMap.has(idKey)) {
          candidateMap.set(idKey, cand);
        }
      };

      for (const q of searchQueries) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        try {
          const res = await fetchImpl(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, {
            signal: controller.signal,
          });
          clearTimeout(timer);
          if (res.ok) {
            const list = await res.json();
            if (Array.isArray(list)) {
              for (const it of list) {
                addCandidate(it);
              }
            }
          }
        } catch {
          clearTimeout(timer);
        }
      }

      const allList = Array.from(candidateMap.values());
      let lrclibData = null;

      if (allList.length > 0) {
        const valid = allList.filter((it) => {
          if (!it) return false;
          const text = `${it.trackName || ""} ${it.artistName || ""}`.toLowerCase();
          const normText = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d");
          const normArtist = (primaryArtist || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d");
          if (primaryArtist && !text.includes(primaryArtist.toLowerCase()) && !normText.includes(normArtist)) return false;
          if (durationSec && Number.isFinite(durationSec) && it.duration) {
            if (Math.abs(it.duration - durationSec) > 35) return false;
          }
          if (text.includes("cover") && !title.toLowerCase().includes("cover")) return false;

          // Reject unwanted localized versions
          const candTitleLower = `${it.trackName || ""} ${it.albumName || ""}`.toLowerCase();
          if (!wantsJapanese && /japan(?:ese)?(?:\s+ver|\s+edition|\s+tour)?|jp\s+ver|日本語/i.test(candTitleLower)) return false;

          const lyrics = it.syncedLyrics || it.plainLyrics || "";
          const scripts = analyzeScriptsSimple(lyrics);

          // Reject Japanese lyrics when target is Korean / Vietnamese
          if (isTargetKorean && scripts.kana > 10 && scripts.hangul === 0) return false;
          if (isTargetVietnamese && (scripts.kana > 10 || scripts.hangul > 10) && scripts.vietnamese === 0) return false;

          return true;
        });

        const scored = valid.map((it) => {
          let score = 0;
          if (it.syncedLyrics) score += 30;
          if (durationSec && Number.isFinite(durationSec) && it.duration) {
            const diff = Math.abs(it.duration - durationSec);
            if (diff <= 2) score += 20;
            else if (diff <= 5) score += 10;
          }
          const tNorm = title.toLowerCase();
          const cNorm = (it.trackName || "").toLowerCase();
          if (cNorm === tNorm) score += 25;
          else if (cNorm.includes(tNorm) || tNorm.includes(cNorm)) score += 20;

          const lyrics = it.syncedLyrics || it.plainLyrics || "";
          const scripts = analyzeScriptsSimple(lyrics);
          if (isTargetKorean && scripts.hangul > 10) score += 30;
          if (isTargetVietnamese && scripts.vietnamese > 5) score += 30;
          if (wantsJapanese && scripts.kana > 10) score += 30;

          return { it, score };
        }).sort((a, b) => b.score - a.score);

        if (scored.length > 0) {
          lrclibData = scored[0].it;
        } else if (allList[0]) {
          lrclibData = allList[0];
        }
      }

      if (lrclibData) {
        let lines = [];
        let isSynced = false;
        if (lrclibData.syncedLyrics) {
          lines = parseLrc(lrclibData.syncedLyrics);
          isSynced = lines.length > 0;
        }
        if (!isSynced && lrclibData.plainLyrics) {
          lines = lrclibData.plainLyrics
            .split("\n")
            .map((t) => t.trim())
            .filter(Boolean)
            .map((text, idx) => ({ time: idx * 5, text }));
        }
        if (lines.length > 0) {
          return { ok: true, synced: isSynced, lines };
        }
      }
    } catch {}

    return null;
  }

  global.JukeboxLyrics = Object.freeze({
    cleanLyricsQuery,
    parseLrc,
    fetchLyricsClient,
  });
})(typeof window !== "undefined" ? window : globalThis);
