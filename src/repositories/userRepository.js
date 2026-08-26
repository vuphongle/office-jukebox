import { randomUUID } from "node:crypto";

export class UserRepository {
  constructor(db) {
    this.db = db;
  }

  create({ username, passwordHash, displayName, role = "user" }) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const cleanUsername = username.toLowerCase().trim();
    const cleanDisplayName = (displayName || cleanUsername).trim();

    this.db.run(
      `INSERT INTO users (id, username, password_hash, display_name, role, status, points_balance, current_streak, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', 0, 0, ?, ?)`,
      [id, cleanUsername, passwordHash, cleanDisplayName, role, now, now]
    );

    return this.findById(id);
  }

  findById(id) {
    if (!id) return null;
    return this.db.query("SELECT * FROM users WHERE id = ?").get(id) || null;
  }

  findByUsername(username) {
    if (!username) return null;
    return this.db.query("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username.toLowerCase().trim()) || null;
  }

  updatePoints(userId, delta, { type, referenceId = null, actorUserId = null, reason = "" } = {}) {
    const tx = this.db.transaction(() => {
      const user = this.findById(userId);
      if (!user) throw new Error("Không tìm thấy người dùng");

      const newBalance = user.points_balance + delta;
      if (newBalance < 0) throw new Error("Số dư điểm không đủ");

      const now = new Date().toISOString();
      this.db.run(
        "UPDATE users SET points_balance = ?, updated_at = ? WHERE id = ?",
        [newBalance, now, userId]
      );

      const ledgerId = randomUUID();
      this.db.run(
        `INSERT INTO point_ledger (id, user_id, delta, type, reference_id, actor_user_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [ledgerId, userId, delta, type, referenceId, actorUserId, reason, now]
      );

      return { ...user, points_balance: newBalance, ledgerId };
    });

    return tx.immediate();
  }

  updateStatus(userId, status) {
    if (!["active", "blocked"].includes(status)) throw new Error("Trạng thái không hợp lệ");
    const now = new Date().toISOString();
    this.db.run("UPDATE users SET status = ?, updated_at = ? WHERE id = ?", [status, now, userId]);
    if (status === "blocked") {
      this.db.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
    }
    return this.findById(userId);
  }

  updateRole(userId, role) {
    if (!["user", "admin"].includes(role)) throw new Error("Vai trò không hợp lệ");
    const now = new Date().toISOString();
    this.db.run("UPDATE users SET role = ?, updated_at = ? WHERE id = ?", [role, now, userId]);
    return this.findById(userId);
  }

  listUsers({ search = "", status = "", limit = 50, offset = 0 } = {}) {
    let where = "WHERE 1=1";
    const params = [];

    if (search) {
      where += " AND (username LIKE ? OR display_name LIKE ?)";
      params.push(`%${search}%`, `%${search}%`);
    }
    if (status && ["active", "blocked"].includes(status)) {
      where += " AND status = ?";
      params.push(status);
    }

    const countRow = this.db.query(`SELECT COUNT(*) as total FROM users ${where}`).get(...params);
    const total = countRow ? countRow.total : 0;

    const rows = this.db.query(
      `SELECT id, username, display_name, role, status, points_balance, current_streak, last_checkin_date, created_at, updated_at
       FROM users ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    return { total, users: rows };
  }
}
