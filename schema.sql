-- ============================================================================
-- Roblox Wheel Spin - Cloudflare D1 schema
-- Paste this whole script into: Workers & Pages > D1 SQL Database > (your db) >
-- Console, then press Execute. It is safe to run more than once: tables use
-- IF NOT EXISTS and seed rows use INSERT OR IGNORE, so existing values are kept.
-- ============================================================================

-- Active event entries that appear on the wheel. Usernames are stored lowercase.
CREATE TABLE IF NOT EXISTS qualified_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  roblox_username TEXT NOT NULL UNIQUE,
  tiktok_username TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'portal',
  created_at INTEGER NOT NULL
);

-- One TikTok handle may only back one entry. Manual entries store '' and are exempt.
CREATE UNIQUE INDEX IF NOT EXISTS idx_qualified_tiktok
  ON qualified_entries (tiktok_username)
  WHERE tiktok_username <> '';

-- Players removed by the duplicate trap, with a cooldown timestamp (unix seconds).
CREATE TABLE IF NOT EXISTS disqualified_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  roblox_username TEXT NOT NULL UNIQUE,
  tiktok_username TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT 'multiple_device_entry',
  disqualified_at INTEGER NOT NULL,
  cooldown_until INTEGER NOT NULL
);

-- Permanently banned Roblox usernames. Survives "Wipe D1 Table".
CREATE TABLE IF NOT EXISTS permanent_blacklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  roblox_username TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL DEFAULT 'banned_by_admin',
  banned_at INTEGER NOT NULL
);

-- Key/value settings, wheel state and the verification values.
CREATE TABLE IF NOT EXISTS system_config (
  config_key TEXT PRIMARY KEY,
  config_value TEXT NOT NULL DEFAULT ''
);

-- Marquee alerts shown on the stream display.
CREATE TABLE IF NOT EXISTS live_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_type TEXT NOT NULL DEFAULT 'disqualified',
  roblox_username TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alerts_created ON live_alerts (created_at);
CREATE INDEX IF NOT EXISTS idx_disqualified_cooldown ON disqualified_entries (cooldown_until);

-- ---------------------------------------------------------------------------
-- Seed defaults (wheel state)
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO system_config (config_key, config_value) VALUES ('wheel_command', 'idle');
INSERT OR IGNORE INTO system_config (config_key, config_value) VALUES ('force_reset', 'false');
INSERT OR IGNORE INTO system_config (config_key, config_value) VALUES ('last_landed', '');
INSERT OR IGNORE INTO system_config (config_key, config_value) VALUES ('registration_gate', 'open');

-- Internal counters used to signal the stream display.
INSERT OR IGNORE INTO system_config (config_key, config_value) VALUES ('spin_nonce', '');
INSERT OR IGNORE INTO system_config (config_key, config_value) VALUES ('spin_seed', '0');
INSERT OR IGNORE INTO system_config (config_key, config_value) VALUES ('reset_id', '0');

-- ---------------------------------------------------------------------------
-- Seed verification values. These live only in the database, never in code.
-- Change any of them later with an UPDATE statement in this same console.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO system_config (config_key, config_value) VALUES ('fan_club_name', 'famayumi');
INSERT OR IGNORE INTO system_config (config_key, config_value) VALUES ('fan_journey_phrase', 'fan journey');
INSERT OR IGNORE INTO system_config (config_key, config_value) VALUES ('min_level', '5');
INSERT OR IGNORE INTO system_config (config_key, config_value) VALUES ('cooldown_days', '15');
INSERT OR IGNORE INTO system_config (config_key, config_value) VALUES ('require_handle_match', 'false');
