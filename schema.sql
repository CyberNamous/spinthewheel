CREATE TABLE IF NOT EXISTS qualified_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  roblox_username TEXT NOT NULL,
  roblox_lower TEXT NOT NULL UNIQUE,
  tiktok_username TEXT NOT NULL,
  tiktok_lower TEXT NOT NULL UNIQUE,
  level INTEGER NOT NULL DEFAULT 0,
  device_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'alive',
  source TEXT NOT NULL DEFAULT 'ocr',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS disqualified_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  roblox_username TEXT NOT NULL,
  roblox_lower TEXT NOT NULL,
  tiktok_username TEXT NOT NULL,
  tiktok_lower TEXT NOT NULL,
  reason TEXT NOT NULL,
  device_hash TEXT NOT NULL DEFAULT '',
  disqualified_at INTEGER NOT NULL,
  cooldown_until INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_disqualified_roblox ON disqualified_entries (roblox_lower);
CREATE INDEX IF NOT EXISTS idx_disqualified_tiktok ON disqualified_entries (tiktok_lower);

CREATE TABLE IF NOT EXISTS permanent_blacklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  username_lower TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL DEFAULT '',
  banned_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS live_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO system_config (key, value) VALUES ('wheel_command', 'idle');
INSERT OR IGNORE INTO system_config (key, value) VALUES ('force_reset', 'false');
INSERT OR IGNORE INTO system_config (key, value) VALUES ('last_landed', '');
INSERT OR IGNORE INTO system_config (key, value) VALUES ('registration_gate', 'open');
INSERT OR IGNORE INTO system_config (key, value) VALUES ('spin_id', '0');
INSERT OR IGNORE INTO system_config (key, value) VALUES ('fan_club_name', 'famayumi');
