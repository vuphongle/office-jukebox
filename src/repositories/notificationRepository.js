import { randomUUID } from "node:crypto";

export const NOTIFICATION_KINDS = Object.freeze(["info", "maintenance", "feature"]);
export const NOTIFICATION_TITLE_MAX_LENGTH = 120;
export const NOTIFICATION_BODY_MAX_LENGTH = 2000;
export const NOTIFICATION_USER_LIMIT = 20;

function clampLimit(value, max = NOTIFICATION_USER_LIMIT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return max;
  return Math.min(max, Math.max(1, Math.floor(parsed)));
}

function clampOffset(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function mapNotification(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    kind: row.kind,
    createdAt: row.created_at,
  };
}

function mapUserNotification(row) {
  const notification = mapNotification(row);
  return {
    ...notification,
    read: Boolean(row.read_at),
    readAt: row.read_at || null,
  };
}

function mapAdminNotification(row) {
  return {
    ...mapNotification(row),
    createdByDisplayName: row.created_by_display_name,
    recipientCount: Number(row.recipient_count || 0),
    readCount: Number(row.read_count || 0),
  };
}

export class NotificationRepository {
  constructor(db) {
    this.db = db;
  }

  createForActiveUsers({ title, body, kind = "info", createdByUserId } = {}) {
    const cleanTitle = typeof title === "string" ? title.trim() : "";
    const cleanBody = typeof body === "string" ? body.trim() : "";
    if (!cleanTitle || cleanTitle.length > NOTIFICATION_TITLE_MAX_LENGTH) {
      throw new Error(`Tiêu đề thông báo phải từ 1 đến ${NOTIFICATION_TITLE_MAX_LENGTH} ký tự.`);
    }
    if (!cleanBody || cleanBody.length > NOTIFICATION_BODY_MAX_LENGTH) {
      throw new Error(`Nội dung thông báo phải từ 1 đến ${NOTIFICATION_BODY_MAX_LENGTH} ký tự.`);
    }
    if (!NOTIFICATION_KINDS.includes(kind)) throw new Error("Loại thông báo không hợp lệ.");
    if (!createdByUserId) throw new Error("Thiếu người tạo thông báo.");

    const transaction = this.db.transaction(() => {
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      this.db.run(
        `INSERT INTO notifications (id, title, body, kind, created_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, cleanTitle, cleanBody, kind, createdByUserId, createdAt]
      );

      const recipients = this.db
        .query("SELECT id FROM users WHERE status = 'active' ORDER BY id")
        .all();
      for (const recipient of recipients) {
        this.db.run(
          `INSERT INTO notification_recipients (notification_id, user_id)
           VALUES (?, ?)`,
          [id, recipient.id]
        );
      }

      return {
        notification: mapNotification({
          id,
          title: cleanTitle,
          body: cleanBody,
          kind,
          created_at: createdAt,
        }),
        recipientCount: recipients.length,
        recipientUserIds: recipients.map((recipient) => recipient.id),
      };
    });

    return transaction.immediate();
  }

  listForUser(userId, { limit = NOTIFICATION_USER_LIMIT, offset = 0 } = {}) {
    const safeLimit = clampLimit(limit);
    const safeOffset = clampOffset(offset);
    const total = Number(
      this.db.query("SELECT COUNT(*) AS total FROM notification_recipients WHERE user_id = ?").get(userId)?.total || 0
    );
    const unreadCount = this.getUnreadCount(userId);
    const items = this.db
      .query(
        `SELECT n.id, n.title, n.body, n.kind, n.created_at, nr.read_at
         FROM notification_recipients nr
         JOIN notifications n ON n.id = nr.notification_id
         WHERE nr.user_id = ?
         ORDER BY n.created_at DESC, n.rowid DESC
         LIMIT ? OFFSET ?`
      )
      .all(userId, safeLimit, safeOffset)
      .map(mapUserNotification);
    return { total, unreadCount, items };
  }

  getUnreadCount(userId) {
    return Number(
      this.db
        .query("SELECT COUNT(*) AS total FROM notification_recipients WHERE user_id = ? AND read_at IS NULL")
        .get(userId)?.total || 0
    );
  }

  markRead(notificationId, userId) {
    const result = this.db.run(
      `UPDATE notification_recipients
       SET read_at = ?
       WHERE notification_id = ? AND user_id = ? AND read_at IS NULL`,
      [new Date().toISOString(), notificationId, userId]
    );
    return Number(result?.changes || 0) > 0;
  }

  markAllRead(userId) {
    const result = this.db.run(
      `UPDATE notification_recipients
       SET read_at = ?
       WHERE user_id = ? AND read_at IS NULL`,
      [new Date().toISOString(), userId]
    );
    return Number(result?.changes || 0);
  }

  listAdmin({ limit = NOTIFICATION_USER_LIMIT, offset = 0 } = {}) {
    const safeLimit = clampLimit(limit);
    const safeOffset = clampOffset(offset);
    const total = Number(this.db.query("SELECT COUNT(*) AS total FROM notifications").get()?.total || 0);
    const items = this.db
      .query(
        `SELECT n.id, n.title, n.body, n.kind, n.created_at,
                creator.display_name AS created_by_display_name,
                (SELECT COUNT(*) FROM notification_recipients nr WHERE nr.notification_id = n.id) AS recipient_count,
                (SELECT COUNT(*) FROM notification_recipients nr WHERE nr.notification_id = n.id AND nr.read_at IS NOT NULL) AS read_count
         FROM notifications n
         JOIN users creator ON creator.id = n.created_by_user_id
         ORDER BY n.created_at DESC, n.rowid DESC
         LIMIT ? OFFSET ?`
      )
      .all(safeLimit, safeOffset)
      .map(mapAdminNotification);
    return { total, items };
  }
}
