import { Database } from "bun:sqlite";

const DB_PATH = process.env.DB_PATH || "./live-dashboard.db";

export const db = new Database(DB_PATH, { create: true });

// Performance pragmas
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 5000");
db.run("PRAGMA synchronous = NORMAL");

// Activities table
db.run(`
  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    device_name TEXT NOT NULL,
    platform TEXT NOT NULL,
    app_id TEXT NOT NULL,
    app_name TEXT NOT NULL,
    window_title TEXT DEFAULT '',
    title_hash TEXT NOT NULL DEFAULT '',
    time_bucket INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Dedup unique constraint
db.run(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_dedup
  ON activities(device_id, app_id, title_hash, time_bucket)
`);

// Query indexes
db.run(`
  CREATE INDEX IF NOT EXISTS idx_activities_device_started
  ON activities(device_id, started_at DESC)
`);
db.run(`
  CREATE INDEX IF NOT EXISTS idx_activities_started
  ON activities(started_at DESC)
`);
db.run(`
  CREATE INDEX IF NOT EXISTS idx_activities_created
  ON activities(created_at)
`);

// Device states table
db.run(`
  CREATE TABLE IF NOT EXISTS device_states (
    device_id TEXT PRIMARY KEY,
    device_name TEXT NOT NULL,
    platform TEXT NOT NULL,
    app_id TEXT NOT NULL,
    app_name TEXT NOT NULL,
    window_title TEXT DEFAULT '',
    last_seen_at TEXT NOT NULL,
    is_online INTEGER DEFAULT 1
  )
`);

// ── Schema migration: add display_title + extra columns ──

const KNOWN_TABLES = new Set(["activities", "device_states"]);

function columnExists(table: string, column: string): boolean {
  if (!KNOWN_TABLES.has(table)) {
    throw new Error(`columnExists: unknown table "${table}"`);
  }
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

// activities.display_title
if (!columnExists("activities", "display_title")) {
  db.run("ALTER TABLE activities ADD COLUMN display_title TEXT DEFAULT ''");
}

// device_states.display_title
if (!columnExists("device_states", "display_title")) {
  db.run("ALTER TABLE device_states ADD COLUMN display_title TEXT DEFAULT ''");
}

// device_states.extra (JSON string for battery, etc.)
if (!columnExists("device_states", "extra")) {
  db.run("ALTER TABLE device_states ADD COLUMN extra TEXT DEFAULT '{}'");
}

// ── Health records table ──

db.run(`
  CREATE TABLE IF NOT EXISTS health_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    type TEXT NOT NULL,
    value REAL NOT NULL,
    unit TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    end_time TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(device_id, type, recorded_at, end_time)
  )
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_health_records_recorded
  ON health_records(recorded_at)
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_health_records_type
  ON health_records(type, recorded_at)
`);
db.run(`
  CREATE INDEX IF NOT EXISTS idx_health_records_device_recorded
  ON health_records(device_id, recorded_at)
`);

// ── Device consent table (privacy/compliance) ──
// consent 的概念与 device_consents 表结构参考了 @nmb1337 在 PR #37 中的
// 设计，特此致谢。此处以 REQUIRE_EXPLICIT_CONSENT 环境变量开关的最小实现
// 落地，默认关闭以保持对现有 agent 的向后兼容。

db.run(`
  CREATE TABLE IF NOT EXISTS device_consents (
    device_id TEXT PRIMARY KEY,
    consent_version INTEGER NOT NULL DEFAULT 1,
    activity_reporting INTEGER NOT NULL DEFAULT 0,
    health_reporting INTEGER NOT NULL DEFAULT 0,
    granted_scopes TEXT NOT NULL DEFAULT '[]',
    granted_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

// ── HMAC hash secret validation ──

const HASH_SECRET = process.env.HASH_SECRET || "";
if (!HASH_SECRET) {
  console.error("[db] FATAL: HASH_SECRET not set. This is required for privacy-safe title hashing.");
  console.error("[db] Generate one with: openssl rand -hex 32");
  process.exit(1);
}

export function hmacTitle(title: string): string {
  const hmac = new Bun.CryptoHasher("sha256", HASH_SECRET);
  hmac.update(title);
  return hmac.digest("hex");
}

// Prepared statements
export const insertActivity = db.prepare(`
  INSERT INTO activities (device_id, device_name, platform, app_id, app_name, window_title, display_title, title_hash, time_bucket, started_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(device_id, app_id, title_hash, time_bucket) DO NOTHING
`);

export const upsertDeviceState = db.prepare(`
  INSERT INTO device_states (device_id, device_name, platform, app_id, app_name, window_title, display_title, last_seen_at, extra, is_online)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT(device_id) DO UPDATE SET
    device_name = excluded.device_name,
    platform = excluded.platform,
    app_id = excluded.app_id,
    app_name = excluded.app_name,
    window_title = excluded.window_title,
    display_title = excluded.display_title,
    last_seen_at = excluded.last_seen_at,
    extra = excluded.extra,
    is_online = 1
`);

export const getAllDeviceStates = db.prepare(`
  SELECT * FROM device_states ORDER BY last_seen_at DESC
`);

export const getRecentActivities = db.prepare(`
  SELECT * FROM activities ORDER BY started_at DESC LIMIT 20
`);

export const getTimelineByRange = db.prepare(`
  SELECT * FROM activities
  WHERE started_at >= ? AND started_at < ?
  ORDER BY started_at ASC
`);

export const getTimelineByRangeAndDevice = db.prepare(`
  SELECT * FROM activities
  WHERE device_id = ? AND started_at >= ? AND started_at < ?
  ORDER BY started_at ASC
`);

export const markOfflineDevices = db.prepare(`
  UPDATE device_states SET is_online = 0
  WHERE is_online = 1
  AND (last_seen_at IS NULL OR last_seen_at = '' OR datetime(last_seen_at) IS NULL
       OR datetime(last_seen_at) < datetime('now', '-1 minute'))
`);

export const cleanupOldActivities = db.prepare(`
  DELETE FROM activities WHERE created_at < datetime('now', '-7 days')
`);

export const upsertDeviceConsent = db.prepare(`
  INSERT INTO device_consents (
    device_id,
    consent_version,
    activity_reporting,
    health_reporting,
    granted_scopes,
    granted_at,
    updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(device_id) DO UPDATE SET
    consent_version = excluded.consent_version,
    activity_reporting = excluded.activity_reporting,
    health_reporting = excluded.health_reporting,
    granted_scopes = excluded.granted_scopes,
    granted_at = excluded.granted_at,
    updated_at = excluded.updated_at
`);

const getDeviceConsentById = db.prepare(`
  SELECT
    device_id,
    consent_version,
    activity_reporting,
    health_reporting,
    granted_scopes,
    granted_at,
    updated_at
  FROM device_consents
  WHERE device_id = ?
  LIMIT 1
`);

type DeviceConsentRow = {
  device_id: string;
  consent_version: number;
  activity_reporting: number;
  health_reporting: number;
  granted_scopes: string;
  granted_at: string;
  updated_at: string;
};

const REQUIRE_EXPLICIT_CONSENT = /^(1|true|yes)$/i.test(
  process.env.REQUIRE_EXPLICIT_CONSENT || ""
);

export function isExplicitConsentRequired(): boolean {
  return REQUIRE_EXPLICIT_CONSENT;
}

export function getDeviceConsent(deviceId: string): DeviceConsentRow | null {
  return (getDeviceConsentById.get(deviceId) as DeviceConsentRow | undefined) || null;
}

export function canReportActivity(deviceId: string): boolean {
  if (!REQUIRE_EXPLICIT_CONSENT) return true;
  const consent = getDeviceConsent(deviceId);
  return !!consent && consent.activity_reporting === 1;
}

export function canReportHealth(deviceId: string): boolean {
  if (!REQUIRE_EXPLICIT_CONSENT) return true;
  const consent = getDeviceConsent(deviceId);
  return !!consent && consent.health_reporting === 1;
}

export function cleanupUnconfiguredDeviceData(allowedDeviceIds: string[]): {
  deviceStatesDeleted: number;
  activitiesDeleted: number;
  healthRecordsDeleted: number;
} {
  if (allowedDeviceIds.length === 0) {
    return {
      deviceStatesDeleted: 0,
      activitiesDeleted: 0,
      healthRecordsDeleted: 0,
    };
  }

  const placeholders = allowedDeviceIds.map(() => "?").join(", ");

  const deleteDeviceStates = db.prepare(
    `DELETE FROM device_states WHERE device_id NOT IN (${placeholders})`
  );
  const deleteActivities = db.prepare(
    `DELETE FROM activities WHERE device_id NOT IN (${placeholders})`
  );
  const deleteHealthRecords = db.prepare(
    `DELETE FROM health_records WHERE device_id NOT IN (${placeholders})`
  );

  const tx = db.transaction((ids: string[]) => {
    const deviceStatesDeleted = deleteDeviceStates.run(...ids).changes;
    const activitiesDeleted = deleteActivities.run(...ids).changes;
    const healthRecordsDeleted = deleteHealthRecords.run(...ids).changes;
    return { deviceStatesDeleted, activitiesDeleted, healthRecordsDeleted };
  });

  return tx(allowedDeviceIds);
}


// ── 使用时长统计 ──
db.run(`
  CREATE TABLE IF NOT EXISTS usage_stats (
    device_id TEXT NOT NULL,
    date TEXT NOT NULL,
    app_id TEXT NOT NULL,
    app_name TEXT NOT NULL,
    minutes REAL NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (device_id, date, app_id)
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_stats(date, device_id)`);

// ── 事件（供"我这边"轮询做通知） ──
db.run(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    device_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    meta TEXT DEFAULT '{}'
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_id, id)`);

export const upsertUsage = db.prepare(`
  INSERT INTO usage_stats (device_id, date, app_id, app_name, minutes, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(device_id, date, app_id) DO UPDATE SET
    app_name = excluded.app_name, minutes = excluded.minutes, updated_at = excluded.updated_at
`);

export const getUsageByDate = db.prepare(`
  SELECT device_id, app_id, app_name, minutes FROM usage_stats
  WHERE date = ? AND (? = '' OR device_id = ?)
  ORDER BY minutes DESC LIMIT 60
`);

export const insertEvent = db.prepare(`
  INSERT INTO events (created_at, device_id, kind, title, body, meta, notify) VALUES (?, ?, ?, ?, ?, ?, ?)
`);

export const getEventsSince = db.prepare(`
  SELECT id, created_at, device_id, kind, title, body, notify FROM events
  WHERE id > ? ORDER BY id ASC LIMIT ?
`);

export const listDeviceStates = db.prepare(`SELECT * FROM device_states`);

export const getLastEventByKind = db.prepare(`
  SELECT created_at FROM events WHERE device_id = ? AND kind = ? ORDER BY id DESC LIMIT 1
`);


// ── 屏幕时间（亮屏/解锁），口径对齐系统 UsageStats ──
db.run(`
  CREATE TABLE IF NOT EXISTS screen_time (
    device_id TEXT NOT NULL,
    date TEXT NOT NULL,
    screen_minutes REAL,
    unlocked_minutes REAL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (device_id, date)
  )
`);
export const upsertScreenTime = db.prepare(`
  INSERT INTO screen_time (device_id, date, screen_minutes, unlocked_minutes, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(device_id, date) DO UPDATE SET
    screen_minutes = COALESCE(excluded.screen_minutes, screen_time.screen_minutes),
    unlocked_minutes = COALESCE(excluded.unlocked_minutes, screen_time.unlocked_minutes),
    updated_at = excluded.updated_at
`);
export const getScreenTime = db.prepare(`SELECT screen_minutes, unlocked_minutes FROM screen_time WHERE device_id = ? AND date = ?`);


// ── 区间统计（周/月视图） ──
export const getUsageDaily = db.prepare(`
  SELECT date, SUM(minutes) AS total_minutes FROM usage_stats
  WHERE date >= ? AND date <= ? AND (? = '' OR device_id = ?)
  GROUP BY date ORDER BY date ASC
`);

export const getUsageTopInRange = db.prepare(`
  SELECT app_id, app_name, SUM(minutes) AS minutes FROM usage_stats
  WHERE date >= ? AND date <= ? AND (? = '' OR device_id = ?)
  GROUP BY app_id ORDER BY minutes DESC LIMIT 80
`);

export const getScreenTimeRange = db.prepare(`
  SELECT date, SUM(screen_minutes) AS screen_minutes, SUM(unlocked_minutes) AS unlocked_minutes
  FROM screen_time WHERE date >= ? AND date <= ? AND (? = '' OR device_id = ?)
  GROUP BY date ORDER BY date ASC
`);

export default db;
