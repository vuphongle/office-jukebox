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

let cachedClientToken = null;
let cachedClientTokenExpiresAt = 0;

export async function getClientCredentialsToken({
  clientId,
  clientSecret,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!clientId || !clientSecret) return null;
  const now = Date.now();
  if (cachedClientToken && now < cachedClientTokenExpiresAt - 60_000) {
    return cachedClientToken;
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

  if (!res.ok) return null;
  const data = await res.json();
  if (data?.access_token) {
    cachedClientToken = data.access_token;
    cachedClientTokenExpiresAt = now + (Number(data.expires_in) || 3600) * 1000;
    return cachedClientToken;
  }
  return null;
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
    const channel = typeof data.author_name === "string" ? data.author_name.trim() : "Spotify Artist";
    if (!title) return null;
    return {
      videoId: trackId,
      title,
      channel,
      duration: "3:30",
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
    accessToken = "",
    fetchImpl = globalThis.fetch,
    timeoutMs = 6000,
  } = {}
) {
  if (!isValidSpotifyTrackId(trackId)) return null;

  let token = accessToken;
  if (!token && clientId && clientSecret) {
    token = await getClientCredentialsToken({ clientId, clientSecret, fetchImpl }).catch(() => null);
  }

  if (token) {
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
        const artists = Array.isArray(data.artists)
          ? data.artists.map((a) => a.name).filter(Boolean).join(", ")
          : "";
        const image = data.album?.images?.[0]?.url || data.album?.images?.[1]?.url || null;
        if (title) {
          return {
            videoId: trackId,
            title,
            channel: artists || "Spotify Artist",
            duration: formatDurationMs(data.duration_ms),
            thumbnail: image,
            provider: "spotify",
          };
        }
      }
    } catch {
      // Fall through to oEmbed
    } finally {
      clearTimeout(timer);
    }
  }

  return fetchSpotifyOEmbed(trackId, { fetchImpl, timeoutMs });
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
