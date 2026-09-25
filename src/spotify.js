// Spotify URL parsing, Web API client, and OAuth token management.

const SPOTIFY_TRACK_ID = /^[A-Za-z0-9]{22}$/;
const SPOTIFY_HOSTS = new Set(["open.spotify.com", "spotify.com"]);

export function isValidSpotifyTrackId(value) {
  return typeof value === "string" && SPOTIFY_TRACK_ID.test(value.trim());
}

export function parseSpotifyTrackId(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const input = value.trim();

  // Support spotify:track:xxx format
  if (input.startsWith("spotify:track:")) {
    const id = input.slice("spotify:track:".length).split("?")[0];
    return isValidSpotifyTrackId(id) ? id : null;
  }

  // Direct track ID
  if (isValidSpotifyTrackId(input)) return input;

  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (!/^https?:$/.test(url.protocol) || !SPOTIFY_HOSTS.has(url.hostname.toLowerCase())) {
    return null;
  }

  // Support paths like /track/ID or /intl-vi/track/ID
  const match = url.pathname.match(/(?:\/intl-[^/]+)?\/track\/([A-Za-z0-9]{22})/);
  return match?.[1] && isValidSpotifyTrackId(match[1]) ? match[1] : null;
}

export function formatDurationMs(durationMs) {
  const ms = Number(durationMs);
  if (!Number.isFinite(ms) || ms <= 0) return "3:30";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

const clientTokenCache = new Map();
const credentialRateLimits = new Map();

export function resetSpotifyRateLimits() {
  credentialRateLimits.clear();
  clientTokenCache.clear();
}

export function isCredentialRateLimited(clientId) {
  if (!clientId) return false;
  const until = credentialRateLimits.get(clientId) || 0;
  return Date.now() < until;
}

export function markCredentialRateLimited(clientId, retryAfterSeconds = 3600) {
  if (!clientId) return;
  const sec = Math.max(1, Number(retryAfterSeconds) || 3600);
  credentialRateLimits.set(clientId, Date.now() + sec * 1000);
}

function getHeader(res, headerName) {
  if (!res || !res.headers) return null;
  if (typeof res.headers.get === "function") {
    return res.headers.get(headerName);
  }
  const lower = headerName.toLowerCase();
  for (const [k, v] of Object.entries(res.headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

export function normalizeCredentialsPool({
  clientId = "",
  clientSecret = "",
  backupClientId = "",
  backupClientSecret = "",
  credentialsPool = null,
} = {}) {
  if (Array.isArray(credentialsPool) && credentialsPool.length > 0) {
    return credentialsPool
      .filter(
        (c) =>
          c &&
          typeof c.clientId === "string" &&
          typeof c.clientSecret === "string" &&
          c.clientId.trim() &&
          c.clientSecret.trim()
      )
      .map((c) => ({
        clientId: c.clientId.trim(),
        clientSecret: c.clientSecret.trim(),
        label: c.label || "spotify-app",
      }));
  }
  const pool = [];
  if (clientId && clientSecret) {
    pool.push({ clientId: clientId.trim(), clientSecret: clientSecret.trim(), label: "primary" });
  }
  if (backupClientId && backupClientSecret) {
    pool.push({ clientId: backupClientId.trim(), clientSecret: backupClientSecret.trim(), label: "backup" });
  }
  return pool;
}

export async function getClientCredentialsToken({
  clientId,
  clientSecret,
  fetchImpl = globalThis.fetch,
  forceRefresh = false,
} = {}) {
  if (!clientId || !clientSecret) return null;
  const now = Date.now();
  const cached = clientTokenCache.get(clientId);
  if (!forceRefresh && cached && now < cached.expiresAt - 60_000) {
    return cached.token;
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetchImpl("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    if (res.status === 429) {
      const retryAfter = getHeader(res, "retry-after") || 3600;
      markCredentialRateLimited(clientId, retryAfter);
    }
    return null;
  }
  const data = await res.json();
  if (data?.access_token) {
    const token = data.access_token;
    const expiresAt = now + (Number(data.expires_in) || 3600) * 1000;
    clientTokenCache.set(clientId, { token, expiresAt });
    return token;
  }
  return null;
}

export function parseArtistListFromString(raw) {
  if (typeof raw !== "string" || !raw.trim()) return [];
  const splitRegex = /\s*(?:,|&|\band\b|\bwith\b|\bfeat\.?|\bft\.?|\bx\b|\bvs\.?|\bvà\b)\s*/gi;
  const parts = raw.split(splitRegex);
  const seen = new Set();
  const result = [];
  for (const p of parts) {
    let cleaned = p.trim();
    if (
      (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith("'") && cleaned.endsWith("'")) ||
      (cleaned.startsWith("“") && cleaned.endsWith("”")) ||
      (cleaned.startsWith("‘") && cleaned.endsWith("’"))
    ) {
      cleaned = cleaned.slice(1, -1).trim();
    }
    const lower = cleaned.toLowerCase();
    if (cleaned && !seen.has(lower) && !/^(official|audio|mv|topic)$/i.test(cleaned)) {
      seen.add(lower);
      result.push(cleaned);
    }
  }
  return result;
}

export function extractFeaturedArtistsFromTitle(title) {
  if (typeof title !== "string") return [];
  const match = title.match(/\((?:feat\.?|ft\.?|with)\s+([^)]+)\)/i);
  if (!match) return [];
  return parseArtistListFromString(match[1]);
}

export async function fetchSpotifyOEmbed(trackId, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `https://open.spotify.com/oembed?url=https://open.spotify.com/track/${encodeURIComponent(trackId)}`;
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const title = typeof data.title === "string" ? data.title.trim() : "";
    const rawAuthor = typeof data.author_name === "string" ? data.author_name.trim() : "Spotify Artist";
    if (!title) return null;
    const authorArtists = parseArtistListFromString(rawAuthor);
    const titleFeatured = extractFeaturedArtistsFromTitle(title);
    const allArtists = Array.from(new Set([...authorArtists, ...titleFeatured]));
    return {
      videoId: trackId,
      title,
      channel: allArtists.join(", ") || rawAuthor || "Spotify Artist",
      artists: allArtists.length > 0 ? allArtists : (rawAuthor ? [rawAuthor] : []),
      duration: "3:30",
      durationMs: 210000,
      thumbnail: typeof data.thumbnail_url === "string" ? data.thumbnail_url : null,
      provider: "spotify",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchSpotifyTrackMetadata(
  trackId,
  {
    clientId = "",
    clientSecret = "",
    backupClientId = "",
    backupClientSecret = "",
    credentialsPool = null,
    accessToken = "",
    fetchImpl = globalThis.fetch,
    timeoutMs = 6000,
  } = {}
) {
  if (!isValidSpotifyTrackId(trackId)) return null;

  const pool = normalizeCredentialsPool({
    clientId,
    clientSecret,
    backupClientId,
    backupClientSecret,
    credentialsPool,
  });

  const tryFetchTrack = async (token) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`https://api.spotify.com/v1/tracks/${trackId}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (res.ok) {
        const data = await res.json();
        const title = typeof data.name === "string" ? data.name.trim() : "";
        const apiArtists = Array.isArray(data.artists)
          ? data.artists.map((a) => a?.name?.trim()).filter(Boolean)
          : [];
        const titleFeatured = extractFeaturedArtistsFromTitle(title);
        const allArtists = Array.from(new Set([...apiArtists, ...titleFeatured]));
        const image = data.album?.images?.[0]?.url || data.album?.images?.[1]?.url || null;
        if (title) {
          return {
            videoId: trackId,
            title,
            channel: allArtists.join(", ") || "Spotify Artist",
            artists: allArtists,
            duration: formatDurationMs(data.duration_ms),
            durationMs: data.duration_ms,
            thumbnail: image,
            provider: "spotify",
          };
        }
      }
      if (res.status === 429) {
        const retryAfter = getHeader(res, "retry-after") || 3600;
        const err = new Error("Spotify track API rate limited (429)");
        err.status = 429;
        err.retryAfter = retryAfter;
        throw err;
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  if (accessToken) {
    try {
      const result = await tryFetchTrack(accessToken);
      if (result) return result;
    } catch (err) {
      if (err.status !== 429) {
        // Continue to fallback
      }
    }
  }

  const nonLimited = pool.filter((c) => !isCredentialRateLimited(c.clientId));
  const candidateList = nonLimited.length > 0 ? nonLimited : pool;

  for (const cred of candidateList) {
    const token = await getClientCredentialsToken({
      clientId: cred.clientId,
      clientSecret: cred.clientSecret,
      fetchImpl,
    }).catch(() => null);

    if (!token) continue;

    try {
      const result = await tryFetchTrack(token);
      if (result) return result;
    } catch (err) {
      if (err.status === 429) {
        markCredentialRateLimited(cred.clientId, err.retryAfter || 3600);
        continue;
      }
    }
  }

  return fetchSpotifyOEmbed(trackId, { fetchImpl, timeoutMs });
}

async function executeSpotifySearch(
  query,
  token,
  {
    market = "VN",
    limit = 10,
    offset = 0,
    fetchImpl = globalThis.fetch,
    timeoutMs = 6000,
  } = {}
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const params = new URLSearchParams({
      q: query.trim(),
      type: "track",
      market: market || "VN",
      limit: String(Math.min(Math.max(1, limit), 10)),
      offset: String(Math.max(0, parseInt(offset, 10) || 0)),
    });

    const res = await fetchImpl(`https://api.spotify.com/v1/search?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      const retryAfter = getHeader(res, "retry-after");
      const err = new Error(`Spotify search API error (${res.status}): ${errBody}`);
      err.status = res.status;
      if (retryAfter) err.retryAfter = retryAfter;
      throw err;
    }

    const data = await res.json();
    const items = Array.isArray(data?.tracks?.items) ? data.tracks.items : [];

    return items
      .filter((track) => track && typeof track.id === "string" && isValidSpotifyTrackId(track.id))
      .map((track) => {
        const title = typeof track.name === "string" ? track.name.trim() : "Unknown Title";
        const apiArtists = Array.isArray(track.artists)
          ? track.artists.map((a) => a?.name?.trim()).filter(Boolean)
          : [];
        const titleFeatured = extractFeaturedArtistsFromTitle(title);
        const allArtists = Array.from(new Set([...apiArtists, ...titleFeatured]));
        const image =
          track.album?.images?.[0]?.url ||
          track.album?.images?.[1]?.url ||
          null;

        return {
          videoId: track.id,
          title,
          channel: allArtists.join(", ") || "Spotify Artist",
          artists: allArtists,
          duration: formatDurationMs(track.duration_ms),
          durationMs: track.duration_ms,
          thumbnail: image,
          provider: "spotify",
        };
      });
  } finally {
    clearTimeout(timer);
  }
}

export async function searchSpotifyTracks(
  query,
  {
    clientId = "",
    clientSecret = "",
    backupClientId = "",
    backupClientSecret = "",
    credentialsPool = null,
    accessToken = "",
    market = "VN",
    limit = 10,
    offset = 0,
    fetchImpl = globalThis.fetch,
    timeoutMs = 6000,
  } = {}
) {
  if (typeof query !== "string" || !query.trim()) return [];

  const pool = normalizeCredentialsPool({
    clientId,
    clientSecret,
    backupClientId,
    backupClientSecret,
    credentialsPool,
  });

  if (pool.length === 0 && !accessToken) {
    throw new Error("Spotify credentials or access token required for search.");
  }

  // 1. If an accessToken was explicitly supplied, try it first
  if (accessToken) {
    try {
      return await executeSpotifySearch(query, accessToken, {
        market,
        limit,
        offset,
        fetchImpl,
        timeoutMs,
      });
    } catch (err) {
      const is429 = Boolean(err?.message && (err.message.includes("429") || err.message.includes("Too Many Requests")));
      const is401 = Boolean(err?.message && err.message.includes("401"));
      if (!is429 && !is401) {
        throw err;
      }
      if (pool.length === 0) {
        throw err;
      }
      // If pool is available, fall through to try pool credentials
    }
  }

  // 2. Iterate through credentials in the pool
  let lastError = null;
  const nonLimited = pool.filter((c) => !isCredentialRateLimited(c.clientId));
  const candidateList = nonLimited.length > 0 ? nonLimited : pool;

  for (let i = 0; i < candidateList.length; i++) {
    const cred = candidateList[i];
    let token = await getClientCredentialsToken({
      clientId: cred.clientId,
      clientSecret: cred.clientSecret,
      fetchImpl,
    }).catch(() => null);

    if (!token) {
      continue;
    }

    try {
      return await executeSpotifySearch(query, token, {
        market,
        limit,
        offset,
        fetchImpl,
        timeoutMs,
      });
    } catch (err) {
      lastError = err;
      const is429 = Boolean(err?.message && (err.message.includes("429") || err.message.includes("Too Many Requests")));
      if (is429) {
        const retryAfter = err.retryAfter || 3600;
        markCredentialRateLimited(cred.clientId, retryAfter);
        console.warn(`[spotify] Credential (${cred.label || cred.clientId.slice(0, 6)}) hit 429 rate limit. Trying fallback credential if available.`);
        continue;
      }

      const is401 = Boolean(err?.message && err.message.includes("401"));
      if (is401) {
        const freshToken = await getClientCredentialsToken({
          clientId: cred.clientId,
          clientSecret: cred.clientSecret,
          fetchImpl,
          forceRefresh: true,
        }).catch(() => null);

        if (freshToken && freshToken !== token) {
          try {
            return await executeSpotifySearch(query, freshToken, {
              market,
              limit,
              offset,
              fetchImpl,
              timeoutMs,
            });
          } catch (retryErr) {
            lastError = retryErr;
            if (retryErr?.message && (retryErr.message.includes("429") || retryErr.message.includes("Too Many Requests"))) {
              markCredentialRateLimited(cred.clientId, retryErr.retryAfter || 3600);
              continue;
            }
          }
        }
      }
      throw err;
    }
  }

  if (lastError) throw lastError;
  throw new Error("Unable to search Spotify: all available credentials failed or reached rate limits.");
}


export const SPOTIFY_OAUTH_SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-modify-playback-state",
  "user-read-playback-state",
].join(" ");

export function buildSpotifyAuthorizeUrl({ clientId, redirectUri, state = "" }) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SPOTIFY_OAUTH_SCOPES,
  });
  if (state) params.set("state", state);
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

export async function exchangeSpotifyCode(code, { clientId, clientSecret, redirectUri, fetchImpl = globalThis.fetch }) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  const res = await fetchImpl("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Spotify token exchange failed (${res.status}): ${errText}`);
  }

  return await res.json();
}

export async function refreshSpotifyToken(refreshToken, { clientId, clientSecret, fetchImpl = globalThis.fetch }) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const res = await fetchImpl("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Spotify token refresh failed (${res.status}): ${errText}`);
  }

  return await res.json();
}

function normalizeArtistStr(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchSinglePair(tNorm, targetNorm) {
  if (tNorm === targetNorm) return true;
  const tNoSpace = tNorm.replace(/\s+/g, "");
  const targetNoSpace = targetNorm.replace(/\s+/g, "");
  if (tNoSpace.length >= 3 && tNoSpace === targetNoSpace) return true;

  const targetWords = targetNorm.split(" ");
  if (targetWords.length === 1) {
    const stripped = tNorm.replace(/\b(?:ca si|official|music|records|dj|mc|the)\b/g, "").trim();
    return stripped === targetNorm;
  }

  const regex = new RegExp(`(?:^|\\s)${targetNorm}(?:$|\\s)`);
  return regex.test(tNorm);
}

export const ARTIST_ALIASES = {
  "RPT MCK": ["MCK", "RPT MCK"],
  "MCK": ["RPT MCK", "MCK"],
  "SOOBIN": ["Soobin Hoàng Sơn", "SOOBIN"],
  "Soobin Hoàng Sơn": ["SOOBIN", "Soobin Hoàng Sơn"],
  "Sơn Tùng M-TP": ["Sơn Tùng M-TP", "Sơn Tùng MTP", "M-TP"],
  "Sơn Tùng MTP": ["Sơn Tùng M-TP", "Sơn Tùng MTP", "M-TP"],
  "(G)I-DLE": ["(G)I-DLE", "G-IDLE", "GIDLE", "(여자)아이들"],
  "G-IDLE": ["(G)I-DLE", "G-IDLE", "GIDLE"],
  "GIDLE": ["(G)I-DLE", "G-IDLE", "GIDLE"],
  "TXT": ["TOMORROW X TOGETHER", "TXT"],
  "TOMORROW X TOGETHER": ["TOMORROW X TOGETHER", "TXT"],
  "Black Eyed Peas": ["The Black Eyed Peas", "Black Eyed Peas"],
  "The Black Eyed Peas": ["Black Eyed Peas", "The Black Eyed Peas"],
  "Vũ.": ["Vũ", "Vũ.", "Thái Vũ"],
  "Vũ": ["Vũ", "Vũ.", "Thái Vũ"],
  "SEVENTEEN": ["SEVENTEEN", "SEVENTEEN 세븐틴"],
  "IVE": ["IVE", "IVE 아이브"],
  "IU": ["IU", "IU 아이유"],
  "BTS": ["BTS", "방탄소년단"],
};

export function isArtistMatch(trackArtist, targetArtist) {
  if (!trackArtist || !targetArtist) return false;
  const tNorm = normalizeArtistStr(trackArtist);
  const targetNorm = normalizeArtistStr(targetArtist);
  if (!tNorm || !targetNorm) return false;

  if (matchSinglePair(tNorm, targetNorm)) return true;

  const targetAliases = ARTIST_ALIASES[targetArtist] || [];
  for (const alias of targetAliases) {
    const aNorm = normalizeArtistStr(alias);
    if (aNorm && matchSinglePair(tNorm, aNorm)) return true;
  }

  const trackAliases = ARTIST_ALIASES[trackArtist] || [];
  for (const alias of trackAliases) {
    const aNorm = normalizeArtistStr(alias);
    if (aNorm && matchSinglePair(aNorm, targetNorm)) return true;
  }

  return false;
}

export function cleanTrackTitle(title) {
  return (title || "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s*\((?:taylor’s version|remix|acoustic|live|instrumental|sped up.*?|slowed.*?|bonus track|deluxe|version|english version|vietnamese version|feat\..*?|cung voi.*?)\)/gi, "")
    .replace(/\s*\[(?:remix|acoustic|live|instrumental|official|mv).*?\]/gi, "")
    .replace(/\s*-\s*(?:remix|acoustic|live|instrumental|sped up|slowed|remastered|mono|stereo|bonus track).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Disambiguation & discography expansion queries for artists whose names are short words
// that collide with common vocabulary in Spotify's global track search (e.g. "MIN")
export const ARTIST_QUERY_EXPANSIONS = {
  MIN: [
    "MIN Có Em Chờ",
    "MIN Đừng Yêu Nữa Em Mệt Rồi",
    "MIN Ghen",
    "MIN Trên Tình Bạn Dưới Tình Yêu",
    "MIN Vì Yêu Cứ Đâm Đầu",
    "MIN Cà Phê",
    "MIN ST.319",
    "MIN Em Mới Là Người Yêu Anh",
    "MIN Hôn Anh",
    "MIN Yêu",
    "MIN Bài Này Chill Phết",
    "MIN Gọi Tên Em",
    "MIN Tìm",
    "MIN Có Em Là Nhà",
    "MIN Ngắm Sao",
    "MIN vpop",
    "MIN",
    "ca sĩ MIN"
  ],
  SOOBIN: [
    "SOOBIN",
    "Soobin Hoàng Sơn",
    "SOOBIN Phía Sau Một Cô Gái",
    "SOOBIN Đi Để Trở Về",
    "SOOBIN Xin Đừng Lặng Im",
    "SOOBIN Trò Chơi",
    "SOOBIN BlackJack",
    "SOOBIN Tháng Năm",
    "SOOBIN Giá Như"
  ],
  "(G)I-DLE": [
    "(G)I-DLE",
    "GIDLE",
    "G-IDLE",
    "Queencard",
    "TOMBOY",
    "Klaxon",
    "Super Lady",
    "Fate"
  ],
  "RPT MCK": [
    "MCK",
    "RPT MCK",
    "MCK 99%",
    "MCK Chìm Sâu",
    "MCK Tại Vì Sao",
    "MCK Anh Đã Ổn Hơn",
    "MCK Thờ Kê",
    "MCK Tay To"
  ],
  MONO: [
    "MONO",
    "MONO Waiting For You",
    "MONO Em Là",
    "MONO Đi Tìm Tình Yêu",
    "MONO Chăm Hoa",
    "MONO Quên Anh Đi"
  ],
  "Vũ.": [
    "Vũ.",
    "Vũ",
    "Vũ Bước Qua Nhau",
    "Vũ Lạ Lùng",
    "Vũ Bước Qua Mùa Cô Đơn",
    "Vũ Đông Kiếm Em",
    "Vũ Những Lời Hứa Bỏ Quên"
  ]
};

export async function searchSpotifyArtistTracks(artistName, {
  searchQuery,
  clientId,
  clientSecret,
  backupClientId,
  backupClientSecret,
  credentialsPool,
  accessToken,
  limit = 10,
  offset = 0,
  market = "VN",
  fetchImpl = globalThis.fetch,
} = {}) {
  const cleanTarget = (artistName || "").trim();
  if (!cleanTarget) return [];

  const targetNeeded = offset + limit;
  const matched = [];
  const seenIds = new Set();
  const seenTitles = new Set();
  let lastError = null;

  const matchesTarget = (track) => {
    return (track.artists || []).some((a) => {
      return isArtistMatch(a, cleanTarget) || (searchQuery && isArtistMatch(a, searchQuery));
    });
  };

  const addTracks = (tracks) => {
    for (const t of tracks) {
      if (seenIds.has(t.videoId)) continue;
      const cleanT = cleanTrackTitle(t.title);
      if (cleanT && seenTitles.has(cleanT)) continue;
      if (matchesTarget(t)) {
        seenIds.add(t.videoId);
        if (cleanT) seenTitles.add(cleanT);
        matched.push(t);
      }
    }
  };

  const safeSearch = async (q, opts = {}) => {
    try {
      return await searchSpotifyTracks(q, {
        clientId,
        clientSecret,
        backupClientId,
        backupClientSecret,
        credentialsPool,
        accessToken,
        market,
        fetchImpl,
        limit: 10,
        ...opts,
      });
    } catch (e) {
      if (e?.message && (e.message.includes("429") || e.message.includes("Too Many Requests"))) {
        lastError = e;
      }
      return [];
    }
  };

  // 1. If artist has predefined expansion queries (e.g. MIN, SOOBIN), query them first
  const expansionQueries = ARTIST_QUERY_EXPANSIONS[cleanTarget];
  if (expansionQueries && expansionQueries.length > 0) {
    for (const q of expansionQueries) {
      if (matched.length >= targetNeeded) break;
      const pageTracks = await safeSearch(q, { offset: 0 });
      addTracks(pageTracks);
    }
  }

  // 2. Query primaryQuery with pagination
  const primaryQuery = searchQuery?.trim() || cleanTarget;
  const maxSearchPages = Math.min(8, Math.ceil((targetNeeded + 20) / 10));
  for (let page = 0; page < maxSearchPages && matched.length < targetNeeded; page++) {
    const searchOffset = page * 10;
    const pageTracks = await safeSearch(primaryQuery, { offset: searchOffset });

    if (pageTracks.length === 0) break;
    addTracks(pageTracks);
    if (pageTracks.every((t) => seenIds.has(t.videoId))) break;
  }

  // 3. Fallback queries if still not enough tracks
  if (matched.length < targetNeeded && !primaryQuery.startsWith("artist:")) {
    const fallbackQueries = [
      `artist:"${cleanTarget}"`,
      `${cleanTarget} hits`,
      `${cleanTarget} vpop`
    ];
    for (const fbQuery of fallbackQueries) {
      if (matched.length >= targetNeeded) break;
      for (let page = 0; page < 3 && matched.length < targetNeeded; page++) {
        const searchOffset = page * 10;
        const fallbackTracks = await safeSearch(fbQuery, { offset: searchOffset });

        if (fallbackTracks.length === 0) break;
        addTracks(fallbackTracks);
        if (fallbackTracks.every((t) => seenIds.has(t.videoId))) break;
      }
    }
  }

  if (matched.length === 0 && lastError) {
    throw lastError;
  }

  return matched.slice(offset, offset + limit);
}

