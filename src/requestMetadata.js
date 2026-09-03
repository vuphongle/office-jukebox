import { sanitizeThumbnail } from "./youtube.js";

const MAX_TITLE_LENGTH = 200;
const MAX_CHANNEL_LENGTH = 120;

// Client metadata is intentionally ignored for trusted fields. The caller
// may retain client duration/name/requester fields separately, but moderation
// and persisted title/channel/thumbnail values must come from YouTube.
export async function resolveCanonicalRequestMetadata(
  videoId,
  { fetchMetadata, clientMetadata = {} } = {}
) {
  if (typeof fetchMetadata !== "function") throw new TypeError("fetchMetadata is required");
  const canonical = await fetchMetadata(videoId);
  const title = typeof canonical?.title === "string" ? canonical.title.trim() : "";
  const channel = typeof canonical?.channel === "string" ? canonical.channel.trim() : "";
  if (!title || !channel) return null;
  return {
    videoId,
    title: title.slice(0, MAX_TITLE_LENGTH),
    channel: channel.slice(0, MAX_CHANNEL_LENGTH),
    thumbnail: sanitizeThumbnail(canonical.thumbnail),
    duration: typeof clientMetadata.duration === "string" ? clientMetadata.duration : "",
  };
}
