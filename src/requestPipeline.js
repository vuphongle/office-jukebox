import { resolveCanonicalRequestMetadata } from "./requestMetadata.js";

// The request pipeline keeps the untrusted client payload separate from the
// canonical metadata used by moderation and queue persistence.
export async function prepareRequestSong({
  videoId,
  clientMetadata,
  checkPlayable,
  fetchMetadata,
  moderationOn = false,
  fetchDetails,
  moderateSong,
  moderationOptions = {},
}) {
  const playable = await checkPlayable(videoId);
  if (!playable?.ok) return { ok: false, reason: playable?.reason || "Video không thể phát." };

  const song = await resolveCanonicalRequestMetadata(videoId, { fetchMetadata, clientMetadata });
  if (!song) return { ok: false, reason: "Không thể xác thực thông tin video này. Vui lòng thử lại.", unavailable: true };

  if (moderationOn) {
    const details = await fetchDetails(videoId);
    const verdict = await moderateSong({ title: song.title, channel: song.channel }, details, moderationOptions);
    if (!verdict?.approved) return { ok: false, reason: verdict?.reason || "Bài hát không được chấp thuận." };
  }
  return { ok: true, song };
}
