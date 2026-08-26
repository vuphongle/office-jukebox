import { randomUUID } from "node:crypto";

export class LedgerRepository {
  constructor(db) {
    this.db = db;
  }

  record({ userId, delta, type, referenceId = null, actorUserId = null, reason = "" }) {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO point_ledger (id, user_id, delta, type, reference_id, actor_user_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, delta, type, referenceId, actorUserId, reason, now]
    );
    return id;
  }

  listByUser(userId, { limit = 50, offset = 0, direction = "all" } = {}) {
    let deltaCondition = "";
    if (direction === "earned") deltaCondition = " AND delta > 0";
    if (direction === "spent") deltaCondition = " AND delta < 0";

    const countRow = this.db
      .query(`SELECT COUNT(*) as total FROM point_ledger WHERE user_id = ?${deltaCondition}`)
      .get(userId);
    const total = countRow ? countRow.total : 0;

    const rows = this.db
      .query(
        `SELECT id, user_id, delta, type, reference_id, actor_user_id, reason, created_at
         FROM point_ledger
         WHERE user_id = ?${deltaCondition}
         ORDER BY created_at DESC, rowid DESC
         LIMIT ? OFFSET ?`
      )
      .all(userId, limit, offset);

    return { total, ledger: rows };
  }

  findByUserId(userId) {
    return this.db
      .query(
        `SELECT id, user_id, delta, type, reference_id, actor_user_id, reason, created_at
         FROM point_ledger
         WHERE user_id = ?
         ORDER BY created_at DESC, rowid DESC`
      )
      .all(userId);
  }

  listAll({ search = "", type = "", limit = 50, offset = 0 } = {}) {
    let where = "WHERE 1=1";
    const params = [];

    if (search) {
      where += " AND (u.username LIKE ? OR u.display_name LIKE ? OR pl.reason LIKE ?)";
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (type) {
      where += " AND pl.type = ?";
      params.push(type);
    }

    const countRow = this.db
      .query(
        `SELECT COUNT(*) as total
         FROM point_ledger pl
         JOIN users u ON pl.user_id = u.id
         ${where}`
      )
      .get(...params);
    const total = countRow ? countRow.total : 0;

    const rows = this.db
      .query(
        `SELECT pl.id, pl.user_id, u.username, u.display_name, pl.delta, pl.type, pl.reference_id, pl.actor_user_id, pl.reason, pl.created_at
         FROM point_ledger pl
         JOIN users u ON pl.user_id = u.id
         ${where}
         ORDER BY pl.created_at DESC, pl.rowid DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);

    return { total, ledger: rows };
  }
}
