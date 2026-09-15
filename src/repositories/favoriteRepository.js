import { parseDurationSeconds } from "../duration.js";
import { isValidYouTubeVideoId, sanitizeThumbnail } from "../youtube.js";

const MAX_TITLE_LENGTH = 200;
const MAX_CHANNEL_LENGTH = 120;
const MAX_DURATION_SECONDS = 10 * 60;

function normalizeSong(song) {
  const videoId = typeof song?.videoId === "string" ? song.videoId.trim() : "";
  const title = typeof song?.title === "string" ? song.title.trim() : "";
  const channel = typeof song?.channel === "string" ? song.channel.trim() : "";
  const duration = typeof song?.duration === "string" ? song.duration.trim() : "";

  if (!isValidYouTubeVideoId(videoId)) throw new Error("Mã video YouTube không hợp lệ.");
  if (!title || title.length > MAX_TITLE_LENGTH) throw new Error("Tên bài hát không hợp lệ.");
  if (channel.length > MAX_CHANNEL_LENGTH) throw new Error("Tên nghệ sĩ không hợp lệ.");
  if (duration && parseDurationSeconds(duration, { maxSeconds: MAX_DURATION_SECONDS }) === null) {
    throw new Error("Thời lượng bài hát không hợp lệ.");
  }

  return {
    videoId,
    title,
    channel,
    duration,
    thumbnail: sanitizeThumbnail(song?.thumbnail),
  };
}

function mapFavorite(row) {
  return {
    videoId: row.video_id,
    title: row.title,
    channel: row.channel || "",
    duration: row.duration || "",
    thumbnail: row.thumbnail || null,
  };
}

export class FavoriteRepository {
  constructor(db) {
    this.db = db;
  }

  save(userId, song) {
    if (!userId) throw new Error("Thiếu người dùng.");
    const favorite = normalizeSong(song);
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO song_favorites
       (user_id, video_id, title, channel, duration, thumbnail, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, video_id) DO UPDATE SET
         title = excluded.title,
         channel = excluded.channel,
         duration = excluded.duration,
         thumbnail = excluded.thumbnail,
         updated_at = excluded.updated_at`,
      [
        userId,
        favorite.videoId,
        favorite.title,
        favorite.channel,
        favorite.duration,
        favorite.thumbnail,
        now,
        now,
      ]
    );
    return favorite;
  }

  list(userId) {
    if (!userId) return [];
    return this.db
      .query(
        `SELECT video_id, title, channel, duration, thumbnail
         FROM song_favorites
         WHERE user_id = ?
         ORDER BY created_at DESC, rowid DESC`
      )
      .all(userId)
      .map(mapFavorite);
  }

  remove(userId, videoId) {
    if (!userId || !isValidYouTubeVideoId(videoId)) return false;
    const result = this.db.run(
      "DELETE FROM song_favorites WHERE user_id = ? AND video_id = ?",
      [userId, videoId]
    );
    return Number(result?.changes || 0) > 0;
  }
}
