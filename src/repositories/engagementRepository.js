import { randomUUID } from "node:crypto";
import {
  DEFAULT_EVENT_ID,
  PERSONAL_AWARD_SCOPE,
  RANK_MILESTONE_REWARDS,
  RANK_PODIUM_REWARDS,
  STREAK_MILESTONE_REWARDS,
  STREAK_PODIUM_REWARDS,
  rankDefinitionFor,
} from "../engagement.js";

function mapAward(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    awardKind: row.award_kind,
    category: row.category,
    milestoneKey: row.milestone_key,
    scopeKey: row.scope_key,
    place: row.place == null ? null : Number(row.place),
    points: Number(row.points || 0),
    sourceId: row.source_id || null,
    createdAt: row.created_at,
  };
}

export class EngagementRepository {
  constructor(db, { notificationRepo = null, getNotificationsEnabled = () => true } = {}) {
    this.db = db;
    this.notificationRepo = notificationRepo;
    this.getNotificationsEnabled = getNotificationsEnabled;
  }

  _awardOnce({
    userId,
    awardKind,
    category,
    milestoneKey,
    scopeKey,
    place = null,
    points,
    sourceId = null,
    now = new Date().toISOString(),
    title,
    body,
    announce = true,
  }) {
    const safePoints = Math.floor(Number(points));
    if (!Number.isSafeInteger(safePoints) || safePoints <= 0) {
      return { created: false, award: null, notification: null, announcement: null };
    }

    const user = this.db.query("SELECT id, status, points_balance, display_name FROM users WHERE id = ?").get(userId);
    if (!user || user.status !== "active") {
      return { created: false, award: null, notification: null, announcement: null };
    }

    const awardId = randomUUID();
    const insert = this.db.run(
      `INSERT OR IGNORE INTO engagement_awards
       (id, user_id, award_kind, category, milestone_key, scope_key, place, points, source_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [awardId, userId, awardKind, category, String(milestoneKey), String(scopeKey), place, safePoints, sourceId, now]
    );
    if (!Number(insert?.changes || 0)) {
      return { created: false, award: null, notification: null, announcement: null };
    }

    const newBalance = Number(user.points_balance || 0) + safePoints;
    this.db.run("UPDATE users SET points_balance = ?, updated_at = ? WHERE id = ?", [newBalance, now, userId]);
    const ledgerId = randomUUID();
    this.db.run(
      `INSERT INTO point_ledger
       (id, user_id, delta, type, reference_id, actor_user_id, reason, created_at)
       VALUES (?, ?, ?, 'engagement_reward', ?, NULL, ?, ?)`,
      [ledgerId, userId, safePoints, awardId, body, now]
    );

    const stored = this.db.query("SELECT * FROM engagement_awards WHERE id = ?").get(awardId);
    const award = mapAward(stored);
    let notification = null;
    if (this.getNotificationsEnabled() && this.notificationRepo) {
      notification = this.notificationRepo.createForUserInTransaction({
        userId,
        createdByUserId: userId,
        title,
        body: `${body} Số dư mới: ${newBalance} điểm.`,
        sourceType: "engagement_reward",
        sourceKey: `engagement_award:${awardId}`,
      });
    }

    return {
      created: true,
      award,
      notification,
      announcement: announce
        ? {
            awardId,
            userId,
            displayName: user.display_name,
            category,
            milestoneKey: String(milestoneKey),
            place,
            points: safePoints,
            title,
            body,
            createdAt: now,
          }
        : null,
    };
  }

  _awardPodium({ category, milestoneKey, eventId, rewards, userId, sourceId, now, titleForPlace, bodyForPlace }) {
    const existing = Number(
      this.db.query(
        `SELECT COUNT(*) AS total FROM engagement_awards
         WHERE award_kind = 'podium' AND category = ? AND milestone_key = ? AND scope_key = ?`
      ).get(category, String(milestoneKey), eventId)?.total || 0
    );
    const place = existing + 1;
    const points = Number(rewards?.[place] || 0);
    if (place > 2 || points <= 0) return null;
    return this._awardOnce({
      userId,
      awardKind: "podium",
      category,
      milestoneKey,
      scopeKey: eventId,
      place,
      points,
      sourceId,
      now,
      title: titleForPlace(place),
      body: bodyForPlace(place, points),
    });
  }

  awardStreakMilestonesUnsafe({ userId, streakAfter, eventId = DEFAULT_EVENT_ID, sourceId = null, now } = {}) {
    const safeStreak = Math.max(0, Math.floor(Number(streakAfter) || 0));
    const timestamp = now || new Date().toISOString();
    const result = { pointsAwarded: 0, awards: [], notifications: [], announcements: [] };

    const personalPoints = Number(STREAK_MILESTONE_REWARDS[safeStreak] || 0);
    if (personalPoints > 0) {
      const personal = this._awardOnce({
        userId,
        awardKind: "personal",
        category: "streak",
        milestoneKey: safeStreak,
        scopeKey: PERSONAL_AWARD_SCOPE,
        points: personalPoints,
        sourceId,
        now: timestamp,
        title: `Bạn đã đạt streak ${safeStreak} ngày!`,
        body: `Bạn nhận thưởng cá nhân +${personalPoints} điểm cho mốc streak ${safeStreak} ngày.`,
      });
      this._collect(result, personal);
    }

    if (STREAK_PODIUM_REWARDS[safeStreak]) {
      const podium = this._awardPodium({
        category: "streak",
        milestoneKey: safeStreak,
        eventId,
        rewards: STREAK_PODIUM_REWARDS[safeStreak],
        userId,
        sourceId,
        now: timestamp,
        titleForPlace: (place) => `Top ${place} streak ${safeStreak} ngày`,
        bodyForPlace: (place, points) => `Bạn là người thứ ${place} đạt streak ${safeStreak} ngày trong sự kiện và nhận +${points} điểm.`,
      });
      this._collect(result, podium);
    }

    return result;
  }

  awardStreakMilestones(args = {}) {
    const tx = this.db.transaction(() => this.awardStreakMilestonesUnsafe(args));
    return tx.immediate();
  }

  awardRankMilestonesUnsafe({ userId, crossedLevels = [], eventId = DEFAULT_EVENT_ID, sourceId = null, now } = {}) {
    const timestamp = now || new Date().toISOString();
    const result = { pointsAwarded: 0, awards: [], notifications: [], announcements: [] };
    const levels = [...new Set((crossedLevels || []).map((level) => Math.floor(Number(level))).filter((level) => level > 1))];
    for (const level of levels) {
      const rank = rankDefinitionFor(level);
      const personalPoints = Number(RANK_MILESTONE_REWARDS[level] || 0);
      if (rank && personalPoints > 0) {
        const personal = this._awardOnce({
          userId,
          awardKind: "personal",
          category: "rank",
          milestoneKey: level,
          scopeKey: PERSONAL_AWARD_SCOPE,
          points: personalPoints,
          sourceId,
          now: timestamp,
          title: `Chúc mừng bạn lên hạng ${rank.name}!`,
          body: `Bạn nhận thưởng cá nhân +${personalPoints} điểm khi mở khóa hạng ${rank.name}.`,
        });
        this._collect(result, personal);
      }

      const podium = this._awardPodium({
        category: "rank",
        milestoneKey: level,
        eventId,
        rewards: RANK_PODIUM_REWARDS[level],
        userId,
        sourceId,
        now: timestamp,
        titleForPlace: (place) => `Top ${place} đạt hạng ${rank?.name || `#${level}`}`,
        bodyForPlace: (place, points) => `Bạn là người thứ ${place} đạt hạng ${rank?.name || `#${level}`} trong sự kiện và nhận +${points} điểm.`,
      });
      this._collect(result, podium);
    }
    return result;
  }

  awardRankMilestones(args = {}) {
    const tx = this.db.transaction(() => this.awardRankMilestonesUnsafe(args));
    return tx.immediate();
  }

  _collect(result, outcome) {
    if (!outcome?.created) return;
    result.pointsAwarded += Number(outcome.award?.points || 0);
    result.awards.push(outcome.award);
    if (outcome.notification) result.notifications.push(outcome.notification);
    if (outcome.announcement) result.announcements.push(outcome.announcement);
  }
}
