import { randomBytes } from "node:crypto";

export class SessionRepository {
  constructor(db) {
    this.db = db;
  }

  create(userId, token = randomBytes(32).toString("hex"), expiresAt = new Date(Date.now() + 30 * 86400000).toISOString()) {
    const now = new Date().toISOString();
    this.db.run(
      "INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
      [token, userId, expiresAt, now]
    );
    return { token, userId, expiresAt, createdAt: now };
  }

  findValid(token) {
    if (!token) return null;
    const now = new Date().toISOString();
    return (
      this.db
        .query(
          `SELECT s.token, s.user_id, s.expires_at, u.username, u.display_name, u.role, u.status, u.points_balance, u.current_streak, u.last_checkin_date
           FROM sessions s
           JOIN users u ON s.user_id = u.id
           WHERE s.token = ? AND s.expires_at > ? AND u.status = 'active'`
        )
        .get(token, now) || null
    );
  }

  findActiveUserByToken(token) {
    const row = this.findValid(token);
    if (!row) return null;
    return {
      id: row.user_id,
      username: row.username,
      display_name: row.display_name,
      role: row.role,
      status: row.status,
      points_balance: row.points_balance,
      current_streak: row.current_streak,
      last_checkin_date: row.last_checkin_date,
    };
  }

  delete(token) {
    if (!token) return;
    this.db.run("DELETE FROM sessions WHERE token = ?", [token]);
  }

  deleteByToken(token) {
    return this.delete(token);
  }

  deleteByUserId(userId) {
    if (!userId) return;
    this.db.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
  }

  pruneExpired() {
    const now = new Date().toISOString();
    this.db.run("DELETE FROM sessions WHERE expires_at <= ?", [now]);
  }
}
