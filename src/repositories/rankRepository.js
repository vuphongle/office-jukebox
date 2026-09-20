import { randomUUID } from "node:crypto";
import { rankForXp, RANK_XP_DEFAULTS } from "../rank.js";
import { EngagementRepository } from "./engagementRepository.js";
import { avatarPublicUrl } from "../avatar.js";
import { getWeeklyPeriod } from "../weeklyRank.js";

function parseMetadata(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function serializeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return "{}";
  try {
    return JSON.stringify(metadata);
  } catch {
    return "{}";
  }
}

function mapProfile(row) {
  if (!row) return null;
  const rank = rankForXp(row.xp_total);
  return {
    userId: row.user_id,
    xpTotal: rank.xp,
    rankLevel: rank.level,
    rankName: rank.name,
    badge: rank.badge,
    checkinPoints: rank.checkinPoints,
    minXp: rank.minXp,
    nextLevel: rank.nextLevel,
    nextMinXp: rank.nextMinXp,
    xpToNext: rank.xpToNext,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapActivity(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    eventId: row.event_id,
    activityType: row.activity_type,
    deltaXp: row.delta_xp,
    sourceId: row.source_id,
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
  };
}

function mapWeeklyLeaderboardEntry(row, position) {
  const rank = rankForXp(row.xp_total);
  return {
    position,
    displayName: row.display_name,
    avatarUrl: avatarPublicUrl(row.avatar_file),
    weeklyMusicXp: Number(row.weekly_music_xp || 0),
    qualifiedPlayCount: Number(row.qualified_play_count || 0),
    voteParticipationCount: Number(row.vote_participation_count || 0),
    rank: {
      level: rank.level,
      name: rank.name,
      badge: rank.badge,
    },
  };
}

export class RankRepository {
  constructor(db, {
    notificationRepo = null,
    getNotificationsEnabled = () => true,
    engagementRepo = null,
    createAnnouncementInTransaction = null,
  } = {}) {
    this.db = db;
    this.engagementRepo = engagementRepo || new EngagementRepository(db, { notificationRepo, getNotificationsEnabled });
    this.createAnnouncementInTransaction = createAnnouncementInTransaction;
  }

  ensureProfile(userId) {
    if (!userId) return null;
    const now = new Date().toISOString();
    this.db.run(
      `INSERT OR IGNORE INTO user_rank_profiles (user_id, xp_total, rank_level, created_at, updated_at)
       SELECT id, 0, 1, ?, ? FROM users WHERE id = ?`,
      [now, now, userId]
    );
    return this.getProfile(userId);
  }

  getProfile(userId) {
    if (!userId) return null;
    return mapProfile(this.db.query("SELECT * FROM user_rank_profiles WHERE user_id = ?").get(userId));
  }

  getRank(userId) {
    return this.getProfile(userId) || this.ensureProfile(userId);
  }

  /**
   * Append an activity and update the profile in one transaction. The unique
   * (user,event,type,source) key makes retries/reconnects idempotent.
   */
  awardXp({
    userId,
    eventId = "default_event",
    activityType,
    sourceId = "",
    deltaXp,
    metadata = {},
  } = {}) {
    if (!userId) throw new Error("Thiếu userId khi cộng rank XP");
    if (!activityType || typeof activityType !== "string") {
      throw new Error("Thiếu loại hoạt động rank");
    }

    const amount = Math.floor(Number(deltaXp));
    if (!Number.isFinite(amount) || amount <= 0) {
      return { awarded: false, deltaXp: 0, profile: this.getRank(userId) };
    }

    const cleanEventId = eventId || "default_event";
    const cleanSourceId = sourceId == null ? "" : String(sourceId);
    const metadataJson = serializeMetadata(metadata);
    const transaction = this.db.transaction(() => {
      const profile = this.ensureProfile(userId);
      if (!profile) throw new Error("Không tìm thấy người dùng khi cộng rank XP");

      const now = new Date().toISOString();
      const existing = this.db
        .query(
          `SELECT * FROM rank_activity_ledger
           WHERE user_id = ? AND event_id = ? AND activity_type = ? AND source_id = ?`
        )
        .get(userId, cleanEventId, activityType, cleanSourceId);
      if (existing) {
        return {
          awarded: false,
          deltaXp: 0,
          ledger: mapActivity(existing),
          profile: this.getRank(userId),
          notifications: [],
          announcements: [],
          pointsAwarded: 0,
        };
      }
      const utcDayStart = new Date();
      utcDayStart.setUTCHours(0, 0, 0, 0);
      const usedToday = Number(this.db.query(
        `SELECT COALESCE(SUM(delta_xp), 0) AS total
         FROM rank_activity_ledger WHERE user_id = ? AND created_at >= ?`
      ).get(userId, utcDayStart.toISOString())?.total || 0);
      const awardAmount = Math.min(amount, Math.max(0, RANK_XP_DEFAULTS.dailyCap - usedToday));
      if (awardAmount <= 0) {
        return {
          awarded: false,
          deltaXp: 0,
          ledger: null,
          profile: this.getRank(userId),
          notifications: [],
          announcements: [],
          pointsAwarded: 0,
        };
      }
      const ledgerId = randomUUID();
      const insert = this.db.run(
        `INSERT OR IGNORE INTO rank_activity_ledger
         (id, user_id, event_id, activity_type, delta_xp, source_id, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [ledgerId, userId, cleanEventId, activityType, awardAmount, cleanSourceId, metadataJson, now]
      );
      const inserted = Number(insert?.changes || 0) > 0;

      let previousRank = rankForXp(profile.xpTotal);
      if (inserted) {
        const current = this.db.query("SELECT xp_total FROM user_rank_profiles WHERE user_id = ?").get(userId);
        const xpTotal = Number(current?.xp_total || 0) + awardAmount;
        const rank = rankForXp(xpTotal);
        this.db.run(
          "UPDATE user_rank_profiles SET xp_total = ?, rank_level = ?, updated_at = ? WHERE user_id = ?",
          [xpTotal, rank.level, now, userId]
        );
      }

      const engagement = inserted
        ? this.engagementRepo.awardRankMilestonesUnsafe({
            userId,
            crossedLevels: Array.from(
              { length: Math.max(0, this.getRank(userId).rankLevel - previousRank.level) },
              (_, index) => previousRank.level + index + 1
            ),
            eventId: cleanEventId,
            sourceId: ledgerId,
            now,
        })
        : { pointsAwarded: 0, notifications: [], announcements: [] };
      const chatMessages = inserted && typeof this.createAnnouncementInTransaction === "function"
        ? this.createAnnouncementInTransaction(engagement.announcements)
        : [];

      const stored = this.db
        .query(
          `SELECT * FROM rank_activity_ledger
           WHERE user_id = ? AND event_id = ? AND activity_type = ? AND source_id = ?`
        )
        .get(userId, cleanEventId, activityType, cleanSourceId);
      return {
        awarded: inserted,
        deltaXp: inserted ? awardAmount : 0,
        ledger: mapActivity(stored),
        profile: this.getRank(userId),
        notifications: engagement.notifications,
        announcements: engagement.announcements,
        chatMessages,
        pointsAwarded: engagement.pointsAwarded,
      };
    });

    return transaction.immediate();
  }

  awardQualifiedPlay({ userId, queueItemId, eventId = "default_event", title = "", playedSeconds = null } = {}) {
    return this.awardXp({
      userId,
      eventId,
      activityType: "qualified_play",
      sourceId: queueItemId,
      deltaXp: RANK_XP_DEFAULTS.qualifiedPlay,
      metadata: { queueItemId, title, playedSeconds },
    });
  }

  awardVoteParticipation({ userId, queueItemId, eventId = "default_event", title = "" } = {}) {
    return this.awardXp({
      userId,
      eventId,
      activityType: "vote_participation",
      sourceId: queueItemId,
      deltaXp: RANK_XP_DEFAULTS.voteParticipation,
      metadata: { queueItemId, title },
    });
  }

  /**
   * Record one accepted human chat message in a deterministic 15-minute
   * bucket. XP grows slowly with distinct activity and is capped at 8 XP per
   * bucket; the caller can mark obvious repeated messages as spam so a burst
   * cannot be converted directly into rank progress.
   */
  recordChatActivity({ userId, eventId = "default_event", createdAt = new Date().toISOString(), isSpam = false } = {}) {
    if (!userId || isSpam) return { awardedXp: 0, windowStart: null, xpAwarded: 0 };
    const timestamp = Date.parse(createdAt);
    const safeTimestamp = Number.isFinite(timestamp) ? timestamp : Date.now();
    const windowMs = 15 * 60 * 1000;
    const windowStart = new Date(Math.floor(safeTimestamp / windowMs) * windowMs).toISOString();
    const windowEnd = new Date(Math.floor(safeTimestamp / windowMs) * windowMs + windowMs).toISOString();
    const tx = this.db.transaction(() => {
      const now = new Date().toISOString();
      this.db.run(
        `INSERT OR IGNORE INTO rank_chat_windows
         (id, user_id, event_id, window_start, window_end, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [randomUUID(), userId, eventId, windowStart, windowEnd, now]
      );
      this.db.run(
        `UPDATE rank_chat_windows
         SET unique_message_count = unique_message_count + 1,
             active_bucket_count = MIN(3, CAST((unique_message_count + 1 + 3) / 4 AS INTEGER))
         WHERE user_id = ? AND event_id = ? AND window_start = ?`,
        [userId, eventId, windowStart]
      );
      const row = this.db.query(
        `SELECT unique_message_count, xp_awarded
         FROM rank_chat_windows WHERE user_id = ? AND event_id = ? AND window_start = ?`
      ).get(userId, eventId, windowStart);
      const count = Number(row?.unique_message_count || 0);
      const previousXp = Number(row?.xp_awarded || 0);
      const targetXp = count < 2 ? 0 : Math.min(RANK_XP_DEFAULTS.chatWindowCap, 2 + Math.floor(Math.sqrt(count - 2)));
      const deltaXp = Math.max(0, targetXp - previousXp);
      if (deltaXp > 0) {
        this.db.run(
          "UPDATE rank_chat_windows SET xp_awarded = ?, evaluated_at = ? WHERE user_id = ? AND event_id = ? AND window_start = ?",
          [targetXp, now, userId, eventId, windowStart]
        );
      }
      return { awardedXp: deltaXp, windowStart, windowEnd, xpAwarded: targetXp, messageCount: count };
    });
    return tx.immediate();
  }

  listActivity(userId, { eventId = null, limit = 50, offset = 0 } = {}) {
    if (!userId) return [];
    const boundedLimit = Math.min(200, Math.max(1, Number(limit) || 50));
    const boundedOffset = Math.max(0, Number(offset) || 0);
    if (eventId) {
      return this.db
        .query(
          `SELECT * FROM rank_activity_ledger
           WHERE user_id = ? AND event_id = ?
           ORDER BY created_at DESC LIMIT ? OFFSET ?`
        )
        .all(userId, eventId, boundedLimit, boundedOffset)
        .map(mapActivity);
    }
    return this.db
      .query(
        `SELECT * FROM rank_activity_ledger
         WHERE user_id = ?
         ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(userId, boundedLimit, boundedOffset)
      .map(mapActivity);
  }

  listPublicLeaderboard({ limit = 10, offset = 0 } = {}) {
    const boundedLimit = Math.min(10, Math.max(1, Number(limit) || 10));
    const boundedOffset = Math.max(0, Number(offset) || 0);
    const rows = this.db
      .query(
        `SELECT u.display_name, u.avatar_file, COALESCE(urp.xp_total, 0) AS xp_total
         FROM users u
         LEFT JOIN user_rank_profiles urp ON urp.user_id = u.id
         WHERE u.status = 'active' AND u.role = 'user'
         ORDER BY COALESCE(urp.xp_total, 0) DESC, u.display_name COLLATE NOCASE ASC, u.id ASC
         LIMIT ? OFFSET ?`
      )
      .all(boundedLimit, boundedOffset);

    return rows.map((row, index) => {
      const rank = rankForXp(row.xp_total);
      return {
        position: boundedOffset + index + 1,
        displayName: row.display_name,
        avatarUrl: avatarPublicUrl(row.avatar_file),
        xpTotal: rank.xp,
        rank: {
          level: rank.level,
          name: rank.name,
          badge: rank.badge,
        },
      };
    });
  }

  listWeeklyMusicLeaderboard({ period = getWeeklyPeriod(), limit = 10, offset = 0 } = {}) {
    const boundedLimit = Math.min(10, Math.max(1, Number(limit) || 10));
    const boundedOffset = Math.max(0, Number(offset) || 0);
    const rows = this.db
      .query(
        `SELECT u.display_name, u.avatar_file, COALESCE(urp.xp_total, 0) AS xp_total,
                SUM(ral.delta_xp) AS weekly_music_xp,
                SUM(CASE WHEN ral.activity_type = 'qualified_play' THEN 1 ELSE 0 END) AS qualified_play_count,
                SUM(CASE WHEN ral.activity_type = 'vote_participation' THEN 1 ELSE 0 END) AS vote_participation_count
         FROM rank_activity_ledger ral
         JOIN users u ON u.id = ral.user_id
         LEFT JOIN user_rank_profiles urp ON urp.user_id = u.id
         WHERE u.status = 'active'
           AND u.role = 'user'
           AND ral.created_at >= ?
           AND ral.created_at < ?
           AND ral.activity_type IN ('qualified_play', 'vote_participation')
         GROUP BY u.id
         ORDER BY weekly_music_xp DESC,
                  qualified_play_count DESC,
                  vote_participation_count DESC,
                  u.display_name COLLATE NOCASE ASC,
                  u.id ASC
         LIMIT ? OFFSET ?`
      )
      .all(period.startAt, period.endAt, boundedLimit, boundedOffset);

    return rows.map((row, index) => mapWeeklyLeaderboardEntry(row, boundedOffset + index + 1));
  }

  getWeeklyMusicSummary(userId, { period = getWeeklyPeriod() } = {}) {
    if (!userId) return null;
    const rows = this.db
      .query(
        `SELECT u.id AS user_id, u.display_name, u.avatar_file, COALESCE(urp.xp_total, 0) AS xp_total,
                SUM(ral.delta_xp) AS weekly_music_xp,
                SUM(CASE WHEN ral.activity_type = 'qualified_play' THEN 1 ELSE 0 END) AS qualified_play_count,
                SUM(CASE WHEN ral.activity_type = 'vote_participation' THEN 1 ELSE 0 END) AS vote_participation_count
         FROM rank_activity_ledger ral
         JOIN users u ON u.id = ral.user_id
         LEFT JOIN user_rank_profiles urp ON urp.user_id = u.id
         WHERE u.status = 'active'
           AND u.role = 'user'
           AND ral.created_at >= ?
           AND ral.created_at < ?
           AND ral.activity_type IN ('qualified_play', 'vote_participation')
         GROUP BY u.id
         ORDER BY weekly_music_xp DESC,
                  qualified_play_count DESC,
                  vote_participation_count DESC,
                  u.display_name COLLATE NOCASE ASC,
                  u.id ASC`
      )
      .all(period.startAt, period.endAt);
    const index = rows.findIndex((row) => row.user_id === userId);
    if (index < 0) {
      return {
        position: null,
        participantCount: rows.length,
        weeklyMusicXp: 0,
        qualifiedPlayCount: 0,
        voteParticipationCount: 0,
      };
    }
    return {
      ...mapWeeklyLeaderboardEntry(rows[index], index + 1),
      participantCount: rows.length,
    };
  }

  listLeaderboard({ eventId = null, limit = 50, offset = 0 } = {}) {
    const boundedLimit = Math.min(200, Math.max(1, Number(limit) || 50));
    const boundedOffset = Math.max(0, Number(offset) || 0);
    let rows;
    if (eventId) {
      rows = this.db
        .query(
          `SELECT u.id AS user_id, COALESCE(urp.xp_total, 0) AS xp_total,
                  urp.rank_level, urp.created_at, urp.updated_at,
                  u.username, u.display_name, u.avatar_file,
                  COALESCE(SUM(CASE WHEN ral.event_id = ? THEN ral.delta_xp ELSE 0 END), 0) AS event_xp
           FROM users u
           LEFT JOIN user_rank_profiles urp ON urp.user_id = u.id
           LEFT JOIN rank_activity_ledger ral ON ral.user_id = u.id
           GROUP BY u.id
           ORDER BY event_xp DESC, urp.xp_total DESC, u.display_name COLLATE NOCASE ASC
           LIMIT ? OFFSET ?`
        )
        .all(eventId, boundedLimit, boundedOffset);
    } else {
      rows = this.db
        .query(
          `SELECT u.id AS user_id, COALESCE(urp.xp_total, 0) AS xp_total,
                  urp.rank_level, urp.created_at, urp.updated_at,
                  u.username, u.display_name, u.avatar_file
           FROM users u
           LEFT JOIN user_rank_profiles urp ON urp.user_id = u.id
           ORDER BY COALESCE(urp.xp_total, 0) DESC, u.display_name COLLATE NOCASE ASC
           LIMIT ? OFFSET ?`
        )
        .all(boundedLimit, boundedOffset);
    }
    return rows.map((row, index) => ({
      position: boundedOffset + index + 1,
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: avatarPublicUrl(row.avatar_file),
      xpTotal: row.xp_total,
      eventXp: eventId ? row.event_xp : null,
      ...mapProfile(row),
    }));
  }
}
