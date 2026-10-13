import { randomUUID } from "node:crypto";

const MAX_SUBSCRIPTIONS_PER_USER = 5;

export class PushRepository {
  constructor(db) {
    this.db = db;
  }

  saveSubscription(userId, { endpoint, p256dh, auth, userAgent = null }) {
    if (!endpoint || typeof endpoint !== "string" || !endpoint.startsWith("https://")) {
      throw new Error("Endpoint thông báo đẩy không hợp lệ (phải bắt đầu bằng https://).");
    }
    if (!p256dh || typeof p256dh !== "string" || !auth || typeof auth !== "string") {
      throw new Error("Thông tin khóa mã hóa push không đầy đủ.");
    }

    const nowIso = new Date().toISOString();

    const tx = this.db.transaction(() => {
      // Check if endpoint already exists
      const existing = this.db.query("SELECT id FROM push_subscriptions WHERE endpoint = ?").get(endpoint);
      if (existing) {
        this.db.run(
          `UPDATE push_subscriptions
           SET user_id = ?, p256dh = ?, auth = ?, user_agent = ?, failure_count = 0
           WHERE endpoint = ?`,
          [userId, p256dh, auth, userAgent, endpoint]
        );
        return { id: existing.id, endpoint, updated: true };
      }

      // Check current count for this user
      const userSubs = this.db
        .query("SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at ASC")
        .all(userId);

      if (userSubs.length >= MAX_SUBSCRIPTIONS_PER_USER) {
        // Remove oldest to respect max limit
        const toRemove = userSubs.slice(0, userSubs.length - MAX_SUBSCRIPTIONS_PER_USER + 1);
        for (const sub of toRemove) {
          this.db.run("DELETE FROM push_subscriptions WHERE id = ?", [sub.id]);
        }
      }

      const id = randomUUID();
      this.db.run(
        `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at, failure_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        [id, userId, endpoint, p256dh, auth, userAgent, nowIso]
      );
      return { id, endpoint, created: true };
    });

    return tx.immediate();
  }

  deleteSubscription(userId, endpoint) {
    if (!endpoint) return false;
    const result = this.db.run(
      "DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?",
      [userId, endpoint]
    );
    return result.changes > 0;
  }

  deleteAllForUser(userId) {
    const result = this.db.run("DELETE FROM push_subscriptions WHERE user_id = ?", [userId]);
    return result.changes;
  }

  getSubscriptionsForUser(userId) {
    return this.db
      .query("SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId);
  }

  hasSubscription(userId) {
    const row = this.db.query("SELECT 1 FROM push_subscriptions WHERE user_id = ? LIMIT 1").get(userId);
    return Boolean(row);
  }

  listEligibleUsersForCheckinReminder(todayLocalDate) {
    // Users who are active, have at least 1 subscription, haven't checked in today,
    // and haven't already received reminder today
    return this.db
      .query(
        `SELECT DISTINCT u.id, u.username, u.display_name, u.current_streak, u.last_checkin_date
         FROM users u
         JOIN push_subscriptions ps ON ps.user_id = u.id
         WHERE u.status = 'active'
           AND (u.last_checkin_date IS NULL OR u.last_checkin_date != ?)
           AND NOT EXISTS (
             SELECT 1 FROM push_reminder_log prl
             WHERE prl.user_id = u.id AND prl.local_date = ? AND prl.kind = 'checkin_reminder'
           )`
      )
      .all(todayLocalDate, todayLocalDate);
  }

  recordReminderSent(userId, localDate, kind = "checkin_reminder", sentAt = new Date().toISOString()) {
    this.db.run(
      `INSERT OR IGNORE INTO push_reminder_log (user_id, local_date, kind, sent_at)
       VALUES (?, ?, ?, ?)`,
      [userId, localDate, kind, sentAt]
    );
  }

  hasReminderBeenSent(userId, localDate, kind = "checkin_reminder") {
    const row = this.db
      .query("SELECT 1 FROM push_reminder_log WHERE user_id = ? AND local_date = ? AND kind = ?")
      .get(userId, localDate, kind);
    return Boolean(row);
  }

  recordDeliverySuccess(endpoint) {
    const nowIso = new Date().toISOString();
    this.db.run(
      "UPDATE push_subscriptions SET last_success_at = ?, failure_count = 0 WHERE endpoint = ?",
      [nowIso, endpoint]
    );
  }

  recordDeliveryFailure(endpoint, statusCode) {
    if (statusCode === 404 || statusCode === 410) {
      this.db.run("DELETE FROM push_subscriptions WHERE endpoint = ?", [endpoint]);
      return { deleted: true, reason: `Status ${statusCode}` };
    }
    this.db.run(
      "UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE endpoint = ?",
      [endpoint]
    );
    const sub = this.db.query("SELECT failure_count FROM push_subscriptions WHERE endpoint = ?").get(endpoint);
    if (sub && sub.failure_count >= 5) {
      this.db.run("DELETE FROM push_subscriptions WHERE endpoint = ?", [endpoint]);
      return { deleted: true, reason: "Max failures exceeded (>= 5)" };
    }
    return { deleted: false, failureCount: sub ? sub.failure_count : 0 };
  }
}
