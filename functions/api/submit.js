/*
 * POST /api/submit
 *
 * Receives { roblox, tiktok, text } from the public portal. The text is the
 * lowercase OCR output produced on the player's own device. Every verification
 * value (fan club name, phrase, minimum level, cooldown) is read from the
 * system_config table, so nothing sensitive is present in this file.
 */

const NAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;
const MAX_BODY_BYTES = 32768;
const MAX_TEXT_LENGTH = 8000;

const CONFIG_KEYS = [
  'registration_gate',
  'fan_club_name',
  'fan_journey_phrase',
  'min_level',
  'cooldown_days',
  'require_handle_match',
];

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function squash(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* Finds the highest level written like "lv.5", "lv 12", "level 7" or "lvl5". */
function extractLevel(text) {
  const pattern = /\b(?:lv|lvl|level)\s*[.:\-]?\s*(\d{1,3})\b/g;
  let best = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const level = parseInt(match[1], 10);
    if (level > best) best = level;
  }
  return best;
}

async function readConfig(db) {
  const placeholders = CONFIG_KEYS.map(() => '?').join(',');
  const rows = await db
    .prepare('SELECT config_key, config_value FROM system_config WHERE config_key IN (' + placeholders + ')')
    .bind(...CONFIG_KEYS)
    .all();
  const config = {};
  for (const row of rows.results || []) config[row.config_key] = row.config_value;
  return config;
}

/* Reads blacklist, cooldown and qualified state in one transactional batch. */
async function readEntryState(db, roblox, tiktok, now) {
  const results = await db.batch([
    db.prepare('SELECT 1 AS hit FROM permanent_blacklist WHERE roblox_username = ?1').bind(roblox),
    db
      .prepare('SELECT cooldown_until FROM disqualified_entries WHERE roblox_username = ?1 AND cooldown_until > ?2')
      .bind(roblox, now),
    db.prepare('SELECT roblox_username FROM qualified_entries WHERE roblox_username = ?1').bind(roblox),
    db
      .prepare('SELECT roblox_username FROM qualified_entries WHERE tiktok_username = ?1 AND roblox_username <> ?2')
      .bind(tiktok, roblox),
  ]);
  return {
    blacklisted: (results[0].results || []).length > 0,
    cooldown: (results[1].results || [])[0] || null,
    alreadyQualified: (results[2].results || []).length > 0,
    handleUsedBy: (results[3].results || [])[0] || null,
  };
}

async function purgeDuplicate(db, roblox, tiktok, now, cooldownDays) {
  const cooldownUntil = now + cooldownDays * 86400;
  const message =
    '⚠️ DISQUALIFIED: Roblox ' + roblox + ' has been removed for attempting multiple device entries!';
  await db.batch([
    db.prepare('DELETE FROM qualified_entries WHERE roblox_username = ?1').bind(roblox),
    db
      .prepare(
        "INSERT INTO disqualified_entries (roblox_username, tiktok_username, reason, disqualified_at, cooldown_until) " +
          "VALUES (?1, ?2, 'multiple_device_entry', ?3, ?4) " +
          'ON CONFLICT(roblox_username) DO UPDATE SET tiktok_username = excluded.tiktok_username, ' +
          "reason = 'multiple_device_entry', disqualified_at = excluded.disqualified_at, cooldown_until = excluded.cooldown_until"
      )
      .bind(roblox, tiktok, now, cooldownUntil),
    db
      .prepare("INSERT INTO live_alerts (alert_type, roblox_username, message, created_at) VALUES ('disqualified', ?1, ?2, ?3)")
      .bind(roblox, message, now),
  ]);
}

function denyForState(state) {
  if (state.blacklisted) {
    return json({ ok: false, code: 'NOT_ALLOWED', message: 'This entry is not permitted.' }, 403);
  }
  if (state.cooldown) {
    const days = Math.max(1, Math.ceil((state.cooldown.cooldown_until - Math.floor(Date.now() / 1000)) / 86400));
    return json(
      {
        ok: false,
        code: 'COOLDOWN',
        message: 'This Roblox username is on a cooldown. Try again in about ' + days + ' day(s).',
      },
      403
    );
  }
  if (state.handleUsedBy) {
    return json(
      {
        ok: false,
        code: 'HANDLE_IN_USE',
        message: 'This TikTok username is already registered with a different Roblox username.',
      },
      409
    );
  }
  return null;
}

export async function onRequestPost(context) {
  const db = context.env.DB;
  if (!db) return json({ ok: false, code: 'SERVER', message: 'Database binding is not configured.' }, 500);

  try {
    const declaredLength = parseInt(context.request.headers.get('content-length') || '0', 10);
    if (declaredLength > MAX_BODY_BYTES) {
      return json({ ok: false, code: 'TOO_LARGE', message: 'Submission is too large.' }, 413);
    }

    /* The registration gate is checked first so closed events do no further work. */
    const config = await readConfig(db);
    if ((config.registration_gate || 'open') === 'closed') {
      return json({ ok: false, code: 'CLOSED', message: 'Registration is currently closed.' }, 403);
    }

    let payload;
    try {
      payload = await context.request.json();
    } catch (error) {
      return json({ ok: false, code: 'BAD_REQUEST', message: 'Invalid submission.' }, 400);
    }

    const roblox = String((payload && payload.roblox) || '').trim();
    const tiktok = String((payload && payload.tiktok) || '').trim();
    if (!NAME_PATTERN.test(roblox) || !NAME_PATTERN.test(tiktok)) {
      return json(
        {
          ok: false,
          code: 'BAD_NAME',
          message: 'Usernames may only use letters, numbers and underscores (3-20 characters).',
        },
        400
      );
    }

    const text = normalizeText(String((payload && payload.text) || '').slice(0, MAX_TEXT_LENGTH));
    const robloxKey = roblox.toLowerCase();
    const tiktokKey = tiktok.toLowerCase();

    /* Verification against values stored in the database. */
    const clubName = normalizeText(config.fan_club_name);
    const phrase = normalizeText(config.fan_journey_phrase);
    const minLevel = parseInt(config.min_level, 10) || 5;
    const cooldownDays = parseInt(config.cooldown_days, 10) || 15;
    const squashedText = squash(text);

    const phraseFound = phrase.length > 0 && (text.includes(phrase) || squashedText.includes(squash(phrase)));
    const clubFound = clubName.length > 0 && (text.includes(clubName) || squashedText.includes(squash(clubName)));
    const level = extractLevel(text);
    const handleOk =
      (config.require_handle_match || 'false') !== 'true' || squashedText.includes(squash(tiktokKey));

    if (!phraseFound || !clubFound || !handleOk) {
      return json(
        {
          ok: false,
          code: 'VERIFY_FAILED',
          message: 'Verification Failed. The screenshot does not show the required fan club details.',
        },
        422
      );
    }
    if (level < minLevel) {
      return json(
        {
          ok: false,
          code: 'LEVEL_TOO_LOW',
          message: 'Verification Failed. Your fan club level must be Level ' + minLevel + ' or higher.',
        },
        422
      );
    }

    /* Duplicate queue trap. Two passes cover a concurrent first submission. */
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const now = Math.floor(Date.now() / 1000);
      const state = await readEntryState(db, robloxKey, tiktokKey, now);

      if (state.alreadyQualified && !state.blacklisted && !state.cooldown) {
        await purgeDuplicate(db, robloxKey, tiktokKey, now, cooldownDays);
        return json(
          {
            ok: false,
            code: 'DUPLICATE_DISQUALIFIED',
            message:
              'Multiple entries were detected for this Roblox username. You have been removed from the wheel and placed on a ' +
              cooldownDays +
              '-day cooldown.',
          },
          409
        );
      }

      const denied = denyForState(state);
      if (denied) return denied;

      /* The guarded insert is a single statement, so the checks and the write cannot interleave. */
      const insert = await db
        .prepare(
          "INSERT INTO qualified_entries (roblox_username, tiktok_username, source, created_at) " +
            "SELECT ?1, ?2, 'portal', ?3 " +
            'WHERE NOT EXISTS (SELECT 1 FROM permanent_blacklist WHERE roblox_username = ?1) ' +
            'AND NOT EXISTS (SELECT 1 FROM disqualified_entries WHERE roblox_username = ?1 AND cooldown_until > ?3) ' +
            'AND NOT EXISTS (SELECT 1 FROM qualified_entries WHERE roblox_username = ?1) ' +
            "AND NOT EXISTS (SELECT 1 FROM qualified_entries WHERE tiktok_username = ?2 AND ?2 <> '')"
        )
        .bind(robloxKey, tiktokKey, now)
        .run();

      if (insert.meta && insert.meta.changes > 0) {
        return json({ ok: true, code: 'ENTERED', message: 'You are in! Good luck on the wheel.' });
      }
    }

    return json({ ok: false, code: 'BUSY', message: 'Too many simultaneous entries. Please try again.' }, 503);
  } catch (error) {
    return json({ ok: false, code: 'SERVER', message: 'Server error. Please try again in a moment.' }, 500);
  }
}

export async function onRequest() {
  return json({ ok: false, code: 'METHOD', message: 'Use POST.' }, 405);
}
