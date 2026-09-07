import { randomUUID } from "node:crypto";
import {
  CLAIMABLE_DROP_DURATION_PRESETS,
  DEFAULT_CLAIMABLE_DROP_DURATION_HOURS,
} from "../engagement.js";

export class DropRepository {
  constructor(db, { notificationRepo = null, getNotificationsEnabled = () => true } = {}) {
    this.db = db;
    this.notificationRepo = notificationRepo;
    this.getNotificationsEnabled = getNotificationsEnabled;
  }

  createDirectAirdrop({ points, reason, title, createdBy, createdByUserId }) {
    const creatorId = createdByUserId || createdBy || null;
    const dropTitle = reason || title || "Airdrop từ Admin";
    const tx = this.db.transaction(() => {
      if (points <= 0) throw new Error("Số điểm phát phải lớn hơn 0");
      const dropId = randomUUID();
      const now = new Date().toISOString();

      const activeUsers = this.db.query("SELECT id FROM users WHERE status = 'active'").all();
      if (!activeUsers.length) return { dropId, userCount: 0, pointsPerUser: points };

      this.db.run(
        "UPDATE users SET points_balance = points_balance + ?, updated_at = ? WHERE status = 'active'",
        [points, now]
      );

      this.db.run(
        `INSERT INTO point_drops (id, title, points, type, status, created_by_user_id, created_at, closed_at)
         VALUES (?, ?, ?, 'direct', 'closed', ?, ?, ?)`,
        [dropId, dropTitle, points, creatorId, now, now]
      );

      for (const u of activeUsers) {
        const ledgerId = randomUUID();
        this.db.run(
          `INSERT INTO point_ledger (id, user_id, delta, type, reference_id, actor_user_id, reason, created_at)
           VALUES (?, ?, ?, 'airdrop_direct', ?, ?, ?, ?)`,
          [ledgerId, u.id, points, dropId, creatorId, dropTitle, now]
        );
      }

      const notifications = [];
      if (this.getNotificationsEnabled() && this.notificationRepo) {
        for (const u of activeUsers) {
          const notification = this.notificationRepo.createForUserInTransaction({
            userId: u.id,
            createdByUserId: creatorId || u.id,
            title: "Bạn vừa nhận được airdrop",
            body: `Ban Tổ Chức đã cộng +${points} điểm cho bạn${dropTitle ? `: ${dropTitle}` : "."}`,
            sourceType: "airdrop_direct",
            sourceKey: `point_drop:${dropId}:${u.id}`,
          });
          if (notification) notifications.push({ userId: u.id, notification });
        }
      }

      return { dropId, userCount: activeUsers.length, pointsPerUser: points, notifications };
    });

    return tx.immediate();
  }

  createClaimableDrop({
    title,
    points,
    createdBy,
    createdByUserId,
    durationHours = DEFAULT_CLAIMABLE_DROP_DURATION_HOURS,
    now = new Date(),
  }) {
    const creatorId = createdByUserId || createdBy || null;
    const tx = this.db.transaction(() => {
      if (points <= 0) throw new Error("Số điểm phát phải lớn hơn 0");
      if (!title || !title.trim()) throw new Error("Tiêu đề không được để trống");
      const hours = Number(durationHours);
      if (!CLAIMABLE_DROP_DURATION_PRESETS.includes(hours)) {
        throw new Error(`Thời hạn chỉ được chọn: ${CLAIMABLE_DROP_DURATION_PRESETS.join(", ")} giờ.`);
      }

      const createdAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
      const expiresAt = new Date(Date.parse(createdAt) + hours * 60 * 60 * 1000).toISOString();
      const dropId = randomUUID();

      // Supersede all previous active claimable drops (Non-stackable rule)
      this.db.run(
        `UPDATE point_drops
         SET status = 'superseded', closed_at = ?, closed_by_user_id = ?, close_reason = 'superseded'
         WHERE type = 'claimable' AND status = 'active'`,
        [createdAt, creatorId]
      );

      this.db.run(
        `INSERT INTO point_drops
         (id, title, points, type, status, created_by_user_id, created_at, expires_at)
         VALUES (?, ?, ?, 'claimable', 'active', ?, ?, ?)`,
        [dropId, title.trim(), points, creatorId, createdAt, expiresAt]
      );

      return this.findDropById(dropId);
    });

    return tx.immediate();
  }

  findDropById(dropId) {
    if (!dropId) return null;
    return this.db.query("SELECT * FROM point_drops WHERE id = ?").get(dropId) || null;
  }

  findById(dropId) {
    return this.findDropById(dropId);
  }

  getActiveClaimableDrop({ now = new Date() } = {}) {
    this.expireDueClaimableDrops(now);
    return this.db
      .query("SELECT * FROM point_drops WHERE type = 'claimable' AND status = 'active' ORDER BY created_at DESC LIMIT 1")
      .get() || null;
  }

  findActiveClaimable() {
    return this.getActiveClaimableDrop();
  }

  hasUserClaimed(dropId, userId) {
    if (!dropId || !userId) return false;
    const row = this.db
      .query("SELECT 1 FROM point_drop_claims WHERE drop_id = ? AND user_id = ?")
      .get(dropId, userId);
    return !!row;
  }

  claimDrop(dropIdOrObj, userIdArg) {
    let dropId = dropIdOrObj;
    let userId = userIdArg;
    if (typeof dropIdOrObj === "object" && dropIdOrObj !== null) {
      dropId = dropIdOrObj.dropId;
      userId = dropIdOrObj.userId;
    }

    const tx = this.db.transaction(() => {
      const drop = this.findDropById(dropId);
      if (!drop || drop.type !== "claimable" || drop.status !== "active") {
        throw new Error("Đợt nhận điểm này đã kết thúc hoặc không tồn tại");
      }

      const now = new Date();
      if (drop.expires_at && Date.parse(drop.expires_at) <= now.getTime()) {
        this.db.run(
          `UPDATE point_drops
           SET status = 'closed', closed_at = ?, close_reason = 'expired'
           WHERE id = ? AND status = 'active'`,
          [now.toISOString(), dropId]
        );
        return { expired: true };
      }

      const user = this.db.query("SELECT * FROM users WHERE id = ?").get(userId);
      if (!user || user.status !== "active") {
        throw new Error("Tài khoản không hợp lệ hoặc bị khóa");
      }

      if (this.hasUserClaimed(dropId, userId)) {
        throw new Error("Bạn đã nhận quà từ đợt này rồi");
      }

      const nowIso = now.toISOString();
      this.db.run(
        "INSERT INTO point_drop_claims (drop_id, user_id, points_received, claimed_at) VALUES (?, ?, ?, ?)",
        [dropId, userId, drop.points, nowIso]
      );

      const newBalance = user.points_balance + drop.points;
      this.db.run("UPDATE users SET points_balance = ?, updated_at = ? WHERE id = ?", [newBalance, nowIso, userId]);

      const ledgerId = randomUUID();
      this.db.run(
        `INSERT INTO point_ledger (id, user_id, delta, type, reference_id, actor_user_id, reason, created_at)
         VALUES (?, ?, ?, 'point_drop_claim', ?, NULL, ?, ?)`,
        [ledgerId, userId, drop.points, dropId, `Nhận quà tặng: ${drop.title}`, nowIso]
      );

      return { pointsReceived: drop.points, pointsClaimed: drop.points, newBalance };
    });

    const result = tx.immediate();
    if (result?.expired) throw new Error("Đợt nhận điểm này đã hết hạn");
    return result;
  }

  cancelClaimableDrop(dropId, closedByUserId, reason = "Admin hủy đợt phát điểm") {
    const tx = this.db.transaction(() => {
      const drop = this.findDropById(dropId);
      if (!drop || drop.type !== "claimable") throw new Error("Không tìm thấy đợt nhận điểm.");
      if (drop.status !== "active") throw new Error("Đợt nhận điểm này đã đóng.");
      const now = new Date().toISOString();
      const closeReason = `cancelled:${String(reason || "Admin hủy đợt phát điểm").slice(0, 200)}`;
      this.db.run(
        `UPDATE point_drops
         SET status = 'closed', closed_at = ?, closed_by_user_id = ?, close_reason = ?
         WHERE id = ? AND status = 'active'`,
        [now, closedByUserId || null, closeReason, dropId]
      );
      return this.findDropById(dropId);
    });
    return tx.immediate();
  }

  expireDueClaimableDrops(now = new Date()) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const tx = this.db.transaction(() => {
      const due = this.db
        .query(
          `SELECT * FROM point_drops
           WHERE type = 'claimable' AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?
           ORDER BY expires_at ASC`
        )
        .all(timestamp);
      if (due.length) {
        this.db.run(
          `UPDATE point_drops
           SET status = 'closed', closed_at = ?, close_reason = 'expired'
           WHERE type = 'claimable' AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`,
          [timestamp, timestamp]
        );
      }
      return due.map((drop) => ({ ...drop, status: "closed", closed_at: timestamp, close_reason: "expired" }));
    });
    return tx.immediate();
  }

  listDrops({ limit = 50, offset = 0 } = {}) {
    const countRow = this.db.query("SELECT COUNT(*) as total FROM point_drops").get();
    const total = countRow ? countRow.total : 0;

    const rows = this.db
      .query(
        `SELECT pd.*, u.username as created_by_username,
         (SELECT COUNT(*) FROM point_drop_claims WHERE drop_id = pd.id) as claim_count
         FROM point_drops pd
         LEFT JOIN users u ON pd.created_by_user_id = u.id
         ORDER BY pd.created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(limit, offset);

    return { total, drops: rows };
  }
}
