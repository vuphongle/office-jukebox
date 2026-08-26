import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scryptSync, randomBytes } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.join(__dirname, "..", "data", "jukebox.db");

let globalDb = null;

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function initDb({ dbPath = DEFAULT_DB_PATH, adminUser = process.env.ADMIN_USERNAME || "admin", adminPass = process.env.ADMIN_PASSWORD || "admin123" } = {}) {
  if (dbPath !== ":memory:") {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");
  db.run("PRAGMA busy_timeout = 5000;");

  // Run DDL Migrations
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'blocked')),
      points_balance INTEGER NOT NULL DEFAULT 0 CHECK(points_balance >= 0),
      current_streak INTEGER NOT NULL DEFAULT 0,
      last_checkin_date TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS point_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      delta INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN (
        'daily_checkin', 'streak_bonus', 'vote_spend',
        'vote_refund', 'admin_adjustment', 'airdrop_direct', 'point_drop_claim'
      )),
      reference_id TEXT,
      actor_user_id TEXT REFERENCES users(id),
      reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_point_ledger_user_id ON point_ledger(user_id);
    CREATE INDEX IF NOT EXISTS idx_point_ledger_created_at ON point_ledger(created_at);

    CREATE TABLE IF NOT EXISTS checkins (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      local_date TEXT NOT NULL,
      streak_after INTEGER NOT NULL,
      base_points INTEGER NOT NULL DEFAULT 1,
      bonus_points INTEGER NOT NULL DEFAULT 0,
      checked_in_at TEXT NOT NULL,
      UNIQUE(user_id, local_date)
    );
    CREATE INDEX IF NOT EXISTS idx_checkins_user_date ON checkins(user_id, local_date);

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
      status TEXT NOT NULL DEFAULT 'active',
      vote_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS queue_items (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL DEFAULT 'default_event',
      video_id TEXT NOT NULL,
      title TEXT NOT NULL,
      channel TEXT,
      duration TEXT,
      thumbnail TEXT,
      added_by TEXT NOT NULL,
      requester_id TEXT NOT NULL,
      added_by_user_id TEXT REFERENCES users(id),
      queue_sequence INTEGER NOT NULL,
      vote_score INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      pinned_order INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'playing', 'played', 'removed', 'error')),
      added_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_queue_items_status ON queue_items(status, pinned, pinned_order, vote_score, queue_sequence);

    CREATE TABLE IF NOT EXISTS queue_votes (
      queue_item_id TEXT NOT NULL REFERENCES queue_items(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      points_spent INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      refunded_at TEXT,
      PRIMARY KEY(queue_item_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_queue_votes_item ON queue_votes(queue_item_id);

    CREATE TABLE IF NOT EXISTS point_drops (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      points INTEGER NOT NULL CHECK(points > 0),
      type TEXT NOT NULL CHECK(type IN ('direct', 'claimable')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'closed', 'superseded')),
      created_by_user_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      closed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_point_drops_status ON point_drops(status);

    CREATE TABLE IF NOT EXISTS point_drop_claims (
      drop_id TEXT NOT NULL REFERENCES point_drops(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      points_received INTEGER NOT NULL,
      claimed_at TEXT NOT NULL,
      PRIMARY KEY(drop_id, user_id)
    );
  `);

  // Seed default admin if no admin exists
  const existingAdmin = db.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (!existingAdmin && adminUser && adminPass) {
    const adminId = "admin_root";
    const now = new Date().toISOString();
    const hash = hashPassword(adminPass);
    try {
      db.run(
        `INSERT INTO users (id, username, password_hash, display_name, role, status, points_balance, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'admin', 'active', 0, ?, ?)`,
        [adminId, adminUser.toLowerCase(), hash, "Administrator", now, now]
      );
    } catch {
      // User might already exist with username
    }
  }

  globalDb = db;
  return db;
}

export function getDb() {
  if (!globalDb) {
    return initDb();
  }
  return globalDb;
}

export function closeDb() {
  if (globalDb) {
    globalDb.close();
    globalDb = null;
  }
}
