import { randomUUID } from "node:crypto";

export class DropRepository {
  constructor(db) {
    this.db = db;
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

      return { dropId, userCount: activeUsers.length, pointsPerUser: points };
    });

    return tx();
  }

  createClaimableDrop({ title, points, createdBy, createdByUserId }) {
    const creatorId = createdByUserId || createdBy || null;
    const tx = this.db.transaction(() => {
      if (points <= 0) throw new Error("Số điểm phát phải lớn hơn 0");
      if (!title || !title.trim()) throw new Error("Tiêu đề không được để trống");

      const now = new Date().toISOString();
      const dropId = randomUUID();

      // Supersede all previous active claimable drops (Non-stackable rule)
      this.db.run(
        "UPDATE point_drops SET status = 'superseded', closed_at = ? WHERE type = 'claimable' AND status = 'active'",
        [now]
      );

      this.db.run(
        `INSERT INTO point_drops (id, title, points, type, status, created_by_user_id, created_at)
         VALUES (?, ?, ?, 'claimable', 'active', ?, ?)`,
        [dropId, title.trim(), points, creatorId, now]
      );

      return this.findDropById(dropId);
    });

    return tx();
  }

  findDropById(dropId) {
    if (!dropId) return null;
    return this.db.query("SELECT * FROM point_drops WHERE id = ?").get(dropId) || null;
  }

  findById(dropId) {
    return this.findDropById(dropId);
  }

  getActiveClaimableDrop() {
    return (
      this.db
        .query("SELECT * FROM point_drops WHERE type = 'claimable' AND status = 'active' ORDER BY created_at DESC LIMIT 1")
        .get() || null
    );
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

      const user = this.db.query("SELECT * FROM users WHERE id = ?").get(userId);
      if (!user || user.status !== "active") {
        throw new Error("Tài khoản không hợp lệ hoặc bị khóa");
      }

      if (this.hasUserClaimed(dropId, userId)) {
        throw new Error("Bạn đã nhận quà từ đợt này rồi");
      }

      const now = new Date().toISOString();
      this.db.run(
        "INSERT INTO point_drop_claims (drop_id, user_id, points_received, claimed_at) VALUES (?, ?, ?, ?)",
        [dropId, userId, drop.points, now]
      );

      const newBalance = user.points_balance + drop.points;
      this.db.run("UPDATE users SET points_balance = ?, updated_at = ? WHERE id = ?", [newBalance, now, userId]);

      const ledgerId = randomUUID();
      this.db.run(
        `INSERT INTO point_ledger (id, user_id, delta, type, reference_id, actor_user_id, reason, created_at)
         VALUES (?, ?, ?, 'point_drop_claim', ?, NULL, ?, ?)`,
        [ledgerId, userId, drop.points, dropId, `Nhận quà tặng: ${drop.title}`, now]
      );

      return { pointsReceived: drop.points, pointsClaimed: drop.points, newBalance };
    });

    return tx();
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
