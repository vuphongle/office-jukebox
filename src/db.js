import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "./password.js";

// Keep the historical named export for callers that imported it from db.js;
// the implementation now has one canonical home in password.js.
export { hashPassword };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = process.env.JUKEBOX_DB_PATH || path.join(__dirname, "..", "data", "jukebox.db");

let globalDb = null;

export function initDb({ dbPath = DEFAULT_DB_PATH, adminUser = process.env.ADMIN_USERNAME || "", adminPass = process.env.ADMIN_PASSWORD || "" } = {}) {
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
    INSERT OR IGNORE INTO events (id, name, timezone, status, vote_enabled, created_at)
    VALUES ('default_event', 'Sự kiện mặc định', 'Asia/Ho_Chi_Minh', 'active', 1, CURRENT_TIMESTAMP);

    CREATE TABLE IF NOT EXISTS queue_items (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL DEFAULT 'default_event' REFERENCES events(id),
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
      vote_rank_sequence INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      pinned_order INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'playing', 'played', 'removed', 'error')),
      added_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      finish_reason TEXT,
      played_seconds INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_queue_items_status ON queue_items(status, pinned, pinned_order, vote_score, queue_sequence);
    CREATE INDEX IF NOT EXISTS idx_queue_items_playback_history ON queue_items(event_id, status, finished_at DESC);
    CREATE INDEX IF NOT EXISTS idx_queue_items_added_user_history ON queue_items(added_by_user_id, status, finished_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_items_one_playing ON queue_items(event_id) WHERE status = 'playing';

    -- Rank XP is a separate, append-only activity economy. It must never be
    -- mixed with point_ledger, which is the spendable wallet for voting.
    CREATE TABLE IF NOT EXISTS user_rank_profiles (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      xp_total INTEGER NOT NULL DEFAULT 0 CHECK(xp_total >= 0),
      rank_level INTEGER NOT NULL DEFAULT 1 CHECK(rank_level >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_rank_profiles_xp ON user_rank_profiles(xp_total DESC, user_id);

    CREATE TABLE IF NOT EXISTS rank_activity_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL DEFAULT 'default_event' REFERENCES events(id),
      activity_type TEXT NOT NULL,
      delta_xp INTEGER NOT NULL CHECK(delta_xp >= 0),
      source_id TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE(user_id, event_id, activity_type, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rank_activity_user_event_created
      ON rank_activity_ledger(user_id, event_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_rank_activity_event_created
      ON rank_activity_ledger(event_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS rank_chat_windows (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL DEFAULT 'default_event' REFERENCES events(id),
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      unique_message_count INTEGER NOT NULL DEFAULT 0,
      active_bucket_count INTEGER NOT NULL DEFAULT 0,
      spam_score REAL NOT NULL DEFAULT 0,
      quality_score REAL,
      quality_confidence REAL,
      xp_awarded INTEGER NOT NULL DEFAULT 0,
      evaluated_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, event_id, window_start)
    );
    CREATE INDEX IF NOT EXISTS idx_rank_chat_windows_event_start
      ON rank_chat_windows(event_id, window_start DESC);
    CREATE INDEX IF NOT EXISTS idx_rank_chat_windows_user_start
      ON rank_chat_windows(user_id, window_start DESC);

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

    CREATE TABLE IF NOT EXISTS chat_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      event_id TEXT NOT NULL DEFAULT 'default_event' REFERENCES events(id),
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      sender_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      text TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_ai INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_event_seq
      ON chat_messages(event_id, seq DESC);

    CREATE TABLE IF NOT EXISTS chat_ai_summaries (
      event_id TEXT PRIMARY KEY REFERENCES events(id),
      content TEXT NOT NULL DEFAULT '',
      covered_through_seq INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_ai_memories (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL DEFAULT 'default_event' REFERENCES events(id),
      memory_key TEXT NOT NULL,
      memory_type TEXT NOT NULL CHECK(memory_type IN ('fact', 'preference', 'decision', 'topic')),
      content TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'deleted')),
      source_message_ids TEXT NOT NULL DEFAULT '[]',
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT,
      UNIQUE(event_id, memory_key)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_ai_memories_event_status
      ON chat_ai_memories(event_id, status, pinned DESC, updated_at DESC);
  `);

  // Existing databases created before repeat voting need a persistent
  // tie-breaker for the moment each song reaches its current score.
  const queueItemColumns = db.query("PRAGMA table_info(queue_items)").all();
  if (!queueItemColumns.some((column) => column.name === "vote_rank_sequence")) {
    db.run("ALTER TABLE queue_items ADD COLUMN vote_rank_sequence INTEGER NOT NULL DEFAULT 0");
  }
  if (!queueItemColumns.some((column) => column.name === "finish_reason")) {
    db.run("ALTER TABLE queue_items ADD COLUMN finish_reason TEXT");
  }
  if (!queueItemColumns.some((column) => column.name === "played_seconds")) {
    db.run("ALTER TABLE queue_items ADD COLUMN played_seconds INTEGER");
  }
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_queue_items_vote_order
     ON queue_items(status, pinned, pinned_order, vote_score DESC, vote_rank_sequence, queue_sequence)`
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_queue_items_playback_history
     ON queue_items(event_id, status, finished_at DESC)`
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_queue_items_added_user_history
     ON queue_items(added_by_user_id, status, finished_at DESC)`
  );

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
