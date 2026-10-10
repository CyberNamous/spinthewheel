const NAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const COOLDOWN_MS = 15 * 24 * 60 * 60 * 1000;
const ALERT_TTL_MS = 120000;
const MAX_BODY = 20000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  });

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const sha256Hex = async (text) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const parseLevel = (text) => {
  const levels = [...text.matchAll(/\b(?:level|lvl|lv)\.?\s*[:\-]?\s*(\d{1,3})\b/gi)].map((m) => Number(m[1]));
  return levels.length ? Math.max(...levels) : 0;
};

const setConfig = (env, key, value) =>
  env.DB.prepare(
    'INSERT INTO system_config (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(key, value);

const bumpSpin = (env) =>
  env.DB.prepare(
    "INSERT INTO system_config (key, value) VALUES ('spin_id', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)"
  );

const readConfig = async (env) => {
  const { results } = await env.DB.prepare('SELECT key, value FROM system_config').all();
  const config = {};
  for (const row of results) config[row.key] = row.value;
  return config;
};

const isAdmin = async (request, env, url) => {
  if (!env.ADMIN_TOKEN) return false;
  const auth = request.headers.get('Authorization') || '';
  const supplied = auth.startsWith('Bearer ')
    ? auth.slice(7)
    : request.headers.get('X-Admin-Token') || url.searchParams.get('token') || '';
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(supplied)),
    crypto.subtle.digest('SHA-256', enc.encode(env.ADMIN_TOKEN))
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
};

async function handleSubmit(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);

  const config = await readConfig(env);
  if (config.registration_gate !== 'open') {
    return json({ ok: false, code: 'closed', error: 'Registration is closed.' }, 403);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ ok: false, error: 'Payload too large.' }, 413);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'Invalid JSON.' }, 400);
  }

  const roblox = String(body.roblox || '').trim();
  const tiktok = String(body.tiktok || '').trim();
  if (!NAME_RE.test(roblox) || !NAME_RE.test(tiktok)) {
    return json({ ok: false, error: 'Usernames must be 3-20 letters, numbers or underscores.' }, 400);
  }
  const rl = roblox.toLowerCase();
  const tl = tiktok.toLowerCase();
  const now = Date.now();

  const [banned, cooling] = await env.DB.batch([
    env.DB.prepare('SELECT 1 AS hit FROM permanent_blacklist WHERE username_lower IN (?1, ?2) LIMIT 1').bind(rl, tl),
    env.DB.prepare(
      'SELECT cooldown_until FROM disqualified_entries WHERE (roblox_lower = ?1 OR tiktok_lower = ?2) AND cooldown_until > ?3 ORDER BY cooldown_until DESC LIMIT 1'
    ).bind(rl, tl, now)
  ]);
  if (banned.results.length) {
    return json({ ok: false, code: 'banned', error: 'This account is permanently banned from the wheel.' }, 403);
  }
  if (cooling.results.length) {
    const days = Math.ceil((cooling.results[0].cooldown_until - now) / 86400000);
    return json({ ok: false, code: 'cooldown', error: `This account is on cooldown for ${days} more day(s).` }, 403);
  }

  const ocr = String(body.ocrText || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s.:+\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
  const level = parseLevel(ocr);
  if (level < 5) {
    return json({ ok: false, code: 'level', error: 'A fan level of 5 or higher is required.' }, 422);
  }
  const fan = norm(config.fan_club_name);
  if (!fan || !norm(ocr).includes(fan)) {
    return json({ ok: false, code: 'fanclub', error: 'The fan club name was not found in the screenshot.' }, 422);
  }

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ua = request.headers.get('User-Agent') || '';
  const deviceHash = (await sha256Hex(`${ip}|${ua}`)).slice(0, 32);

  try {
    const result = await env.DB.prepare(
      `INSERT INTO qualified_entries (roblox_username, roblox_lower, tiktok_username, tiktok_lower, level, device_hash, status, source, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'alive', 'ocr', ?7
       WHERE NOT EXISTS (SELECT 1 FROM qualified_entries WHERE roblox_lower = ?2 OR tiktok_lower = ?4)`
    ).bind(roblox, rl, tiktok, tl, level, deviceHash, now).run();
    if (result.meta.changes === 1) {
      return json({ ok: true, message: `You're in, ${roblox}. Watch the wheel on stream.` });
    }
  } catch (err) {
    if (!String(err && err.message).includes('UNIQUE')) throw err;
  }

  const cooldown = now + COOLDOWN_MS;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO disqualified_entries (roblox_username, roblox_lower, tiktok_username, tiktok_lower, reason, device_hash, disqualified_at, cooldown_until)
       VALUES (?1, ?2, ?3, ?4, 'duplicate-submission', ?5, ?6, ?7)`
    ).bind(roblox, rl, tiktok, tl, deviceHash, now, cooldown),
    env.DB.prepare(
      `INSERT INTO disqualified_entries (roblox_username, roblox_lower, tiktok_username, tiktok_lower, reason, device_hash, disqualified_at, cooldown_until)
       SELECT roblox_username, roblox_lower, tiktok_username, tiktok_lower, 'duplicate-submission', device_hash, ?3, ?4
       FROM qualified_entries
       WHERE (roblox_lower = ?1 OR tiktok_lower = ?2) AND NOT (roblox_lower = ?1 AND tiktok_lower = ?2)`
    ).bind(rl, tl, now, cooldown),
    env.DB.prepare('DELETE FROM qualified_entries WHERE roblox_lower = ?1 OR tiktok_lower = ?2').bind(rl, tl),
    env.DB.prepare('INSERT INTO live_alerts (message, created_at) VALUES (?1, ?2)').bind(
      `🚨 MULTI-DEVICE CHEAT CAUGHT: ${roblox} / ${tiktok} removed from the wheel`,
      now
    )
  ]);
  return json(
    { ok: false, code: 'duplicate', error: 'Duplicate submission detected. You were removed and are on a 15-day cooldown.' },
    409
  );
}

async function handlePublicList(request, env) {
  if (request.method !== 'GET') return json({ ok: false, error: 'Method not allowed.' }, 405);
  const now = Date.now();
  const [entries, alerts, cfg] = await env.DB.batch([
    env.DB.prepare('SELECT roblox_username AS name, status FROM qualified_entries ORDER BY id ASC'),
    env.DB.prepare('SELECT id, message, created_at FROM live_alerts WHERE created_at > ?1 ORDER BY id DESC LIMIT 5').bind(
      now - ALERT_TTL_MS
    ),
    env.DB.prepare(
      "SELECT key, value FROM system_config WHERE key IN ('wheel_command','force_reset','last_landed','spin_id','registration_gate')"
    )
  ]);
  const c = {};
  for (const row of cfg.results) c[row.key] = row.value;
  return json({
    ok: true,
    entries: entries.results,
    alerts: alerts.results,
    command: c.wheel_command || 'idle',
    spin_id: Number(c.spin_id || 0),
    target: c.last_landed || '',
    force_reset: c.force_reset === 'true',
    gate: c.registration_gate || 'open'
  });
}

async function handleAdminAction(request, env, url) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);
  if (!(await isAdmin(request, env, url))) return json({ ok: false, error: 'Unauthorized.' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON.' }, 400);
  }
  const now = Date.now();

  switch (body.action) {
    case 'verify':
      return json({ ok: true });

    case 'get_state': {
      const [q, d, b, a] = await env.DB.batch([
        env.DB.prepare(
          'SELECT id, roblox_username, tiktok_username, level, status, source, device_hash, created_at FROM qualified_entries ORDER BY id ASC'
        ),
        env.DB.prepare(
          'SELECT id, roblox_username, tiktok_username, reason, disqualified_at, cooldown_until FROM disqualified_entries ORDER BY id DESC LIMIT 500'
        ),
        env.DB.prepare('SELECT id, username, reason, banned_at FROM permanent_blacklist ORDER BY id DESC LIMIT 500'),
        env.DB.prepare('SELECT id, message, created_at FROM live_alerts ORDER BY id DESC LIMIT 20')
      ]);
      return json({
        ok: true,
        qualified: q.results,
        disqualified: d.results,
        blacklist: b.results,
        alerts: a.results,
        config: await readConfig(env),
        now
      });
    }

    case 'spin_winner': {
      const pick = await env.DB.prepare(
        "SELECT roblox_username, roblox_lower FROM qualified_entries WHERE status = 'alive' ORDER BY RANDOM() LIMIT 1"
      ).first();
      if (!pick) return json({ ok: false, error: 'No alive entries left to crown.' }, 409);
      await env.DB.batch([
        env.DB.prepare("UPDATE qualified_entries SET status = 'winner' WHERE roblox_lower = ?1").bind(pick.roblox_lower),
        setConfig(env, 'wheel_command', 'spin_winner'),
        setConfig(env, 'last_landed', pick.roblox_username),
        setConfig(env, 'force_reset', 'false'),
        bumpSpin(env)
      ]);
      return json({ ok: true, winner: pick.roblox_username });
    }

    case 'spin_elim': {
      const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM qualified_entries WHERE status = 'alive'").first();
      if (!count || count.n < 1) return json({ ok: false, error: 'No alive entries to spin.' }, 409);
      await env.DB.batch([
        setConfig(env, 'wheel_command', 'spin_elim'),
        setConfig(env, 'last_landed', ''),
        setConfig(env, 'force_reset', 'false'),
        bumpSpin(env)
      ]);
      return json({ ok: true });
    }

    case 'reset_wheel':
      await env.DB.batch([
        env.DB.prepare("UPDATE qualified_entries SET status = 'alive'"),
        setConfig(env, 'wheel_command', 'idle'),
        setConfig(env, 'last_landed', ''),
        setConfig(env, 'force_reset', 'true')
      ]);
      return json({ ok: true });

    case 'set_gate': {
      const value = body.value === 'closed' ? 'closed' : 'open';
      await setConfig(env, 'registration_gate', value).run();
      return json({ ok: true, gate: value });
    }

    case 'perm_ban': {
      const username = String(body.username || '').trim();
      if (!NAME_RE.test(username)) return json({ ok: false, error: 'Invalid username.' }, 400);
      const lower = username.toLowerCase();
      await env.DB.batch([
        env.DB.prepare(
          'INSERT OR IGNORE INTO permanent_blacklist (username, username_lower, reason, banned_at) VALUES (?1, ?2, ?3, ?4)'
        ).bind(username, lower, String(body.reason || 'admin ban').slice(0, 200), now),
        env.DB.prepare('DELETE FROM qualified_entries WHERE roblox_lower = ?1 OR tiktok_lower = ?1').bind(lower)
      ]);
      return json({ ok: true });
    }

    case 'disqualify': {
      const allowed = ['multiple entries', 'fake screenshot', 'other'];
      const reasonKey = allowed.includes(body.reason) ? body.reason : 'other';
      const reason = `manual: ${reasonKey}`;
      const cooldown = now + COOLDOWN_MS;
      let existing = null;
      if (Number.isInteger(Number(body.id)) && body.id !== undefined && body.id !== null && body.id !== '') {
        existing = await env.DB.prepare('SELECT * FROM qualified_entries WHERE id = ?1').bind(Number(body.id)).first();
        if (!existing) return json({ ok: false, error: 'That entry no longer exists.' }, 404);
      } else {
        const typed = String(body.roblox || '').trim();
        if (!NAME_RE.test(typed)) return json({ ok: false, error: 'Enter a valid Roblox username.' }, 400);
        existing = await env.DB.prepare('SELECT * FROM qualified_entries WHERE roblox_lower = ?1').bind(typed.toLowerCase()).first();
        if (!existing) {
          await env.DB.batch([
            env.DB.prepare(
              `INSERT INTO disqualified_entries (roblox_username, roblox_lower, tiktok_username, tiktok_lower, reason, device_hash, disqualified_at, cooldown_until)
               VALUES (?1, ?2, '(unknown)', '(unknown)', ?3, '', ?4, ?5)`
            ).bind(typed, typed.toLowerCase(), reason, now, cooldown),
            env.DB.prepare('INSERT INTO live_alerts (message, created_at) VALUES (?1, ?2)').bind(
              `🚨 DISQUALIFIED: ${typed} (${reasonKey})`,
              now
            )
          ]);
          return json({ ok: true });
        }
      }
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO disqualified_entries (roblox_username, roblox_lower, tiktok_username, tiktok_lower, reason, device_hash, disqualified_at, cooldown_until)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
        ).bind(existing.roblox_username, existing.roblox_lower, existing.tiktok_username, existing.tiktok_lower, reason, existing.device_hash || '', now, cooldown),
        env.DB.prepare('DELETE FROM qualified_entries WHERE id = ?1').bind(existing.id),
        env.DB.prepare('INSERT INTO live_alerts (message, created_at) VALUES (?1, ?2)').bind(
          `🚨 DISQUALIFIED: ${existing.roblox_username} (${reasonKey})`,
          now
        )
      ]);
      return json({ ok: true });
    }

    case 'manual_add': {
      const roblox = String(body.roblox || '').trim();
      const tiktok = String(body.tiktok || '').trim();
      if (!NAME_RE.test(roblox) || !NAME_RE.test(tiktok)) {
        return json({ ok: false, error: 'Both usernames must be 3-20 letters, numbers or underscores.' }, 400);
      }
      const rl = roblox.toLowerCase();
      const tl = tiktok.toLowerCase();
      try {
        const [, ins] = await env.DB.batch([
          env.DB.prepare('DELETE FROM disqualified_entries WHERE roblox_lower = ?1 OR tiktok_lower = ?2').bind(rl, tl),
          env.DB.prepare(
            `INSERT INTO qualified_entries (roblox_username, roblox_lower, tiktok_username, tiktok_lower, level, device_hash, status, source, created_at)
             SELECT ?1, ?2, ?3, ?4, 0, '', 'alive', 'manual', ?5
             WHERE NOT EXISTS (SELECT 1 FROM qualified_entries WHERE roblox_lower = ?2 OR tiktok_lower = ?4)`
          ).bind(roblox, rl, tiktok, tl, now)
        ]);
        if (ins.meta.changes !== 1) return json({ ok: false, error: 'That user is already on the wheel.' }, 409);
      } catch (err) {
        if (String(err && err.message).includes('UNIQUE')) {
          return json({ ok: false, error: 'That user is already on the wheel.' }, 409);
        }
        throw err;
      }
      return json({ ok: true });
    }

    case 'remove_entry': {
      const id = Number(body.id);
      if (!Number.isInteger(id)) return json({ ok: false, error: 'Invalid id.' }, 400);
      await env.DB.prepare('DELETE FROM qualified_entries WHERE id = ?1').bind(id).run();
      return json({ ok: true });
    }

    case 'clear_alerts':
      await env.DB.prepare('DELETE FROM live_alerts').run();
      return json({ ok: true });

    case 'wipe_d1':
      await env.DB.batch([
        env.DB.prepare('DELETE FROM qualified_entries'),
        env.DB.prepare('DELETE FROM disqualified_entries'),
        env.DB.prepare('DELETE FROM live_alerts'),
        setConfig(env, 'wheel_command', 'idle'),
        setConfig(env, 'last_landed', ''),
        setConfig(env, 'force_reset', 'true'),
        setConfig(env, 'spin_id', '0')
      ]);
      return json({ ok: true });

    default:
      return json({ ok: false, error: 'Unknown action.' }, 400);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/submit') return await handleSubmit(request, env);
      if (url.pathname === '/api/public-list') return await handlePublicList(request, env);
      if (url.pathname === '/api/admin-action') return await handleAdminAction(request, env, url);
      if (url.pathname.startsWith('/api/')) return json({ ok: false, error: 'Not found.' }, 404);
      return await env.ASSETS.fetch(request);
    } catch (err) {
      console.error('Unhandled error:', err && err.stack ? err.stack : err);
      return json({ ok: false, error: 'Server error.' }, 500);
    }
  }
};
