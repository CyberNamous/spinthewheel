/*
 * /api/list  (also served as /api/public-list through public-list.js)
 *
 * Public requests (no X-Admin-Token header):
 *   GET   -> qualified names, forceReset, newest alert, wheel signal
 *   POST  -> { action: "landed" | "ack_reset" } used only by the stream display
 *
 * Admin requests (X-Admin-Token header compared with context.env.ADMIN_TOKEN):
 *   GET   -> full dashboard payload
 *   POST  -> { action: "add_manual" | "toggle_gate" | "perm_ban" | "spin" |
 *                       "reset_wheel" | "wipe_tables" }
 */

const NAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;
const MAX_BODY_BYTES = 8192;

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function safeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function readAllConfig(db) {
  const rows = await db.prepare('SELECT config_key, config_value FROM system_config').all();
  const config = {};
  for (const row of rows.results || []) config[row.config_key] = row.config_value;
  return config;
}

function setConfigStatement(db, key, value) {
  return db
    .prepare(
      'INSERT INTO system_config (config_key, config_value) VALUES (?1, ?2) ' +
        'ON CONFLICT(config_key) DO UPDATE SET config_value = excluded.config_value'
    )
    .bind(key, String(value));
}

function newestAlertStatement(db) {
  return db.prepare('SELECT id, alert_type, roblox_username, message, created_at FROM live_alerts ORDER BY id DESC LIMIT 1');
}

async function publicPayload(db) {
  const now = Math.floor(Date.now() / 1000);
  const results = await db.batch([
    db.prepare('SELECT roblox_username FROM qualified_entries ORDER BY id ASC'),
    db.prepare('SELECT config_key, config_value FROM system_config'),
    newestAlertStatement(db),
  ]);
  const config = {};
  for (const row of results[1].results || []) config[row.config_key] = row.config_value;
  const alert = (results[2].results || [])[0] || null;
  return {
    ok: true,
    serverTime: now,
    qualified: (results[0].results || []).map((row) => row.roblox_username),
    forceReset: config.force_reset === 'true',
    resetId: config.reset_id || '0',
    registrationOpen: (config.registration_gate || 'open') !== 'closed',
    wheelCommand: config.wheel_command || 'idle',
    spinNonce: config.spin_nonce || '',
    spinSeed: parseFloat(config.spin_seed || '0') || 0,
    lastLanded: config.last_landed || '',
    alert: alert
      ? {
          id: alert.id,
          type: alert.alert_type,
          roblox: alert.roblox_username,
          message: alert.message,
          createdAt: alert.created_at,
        }
      : null,
  };
}

async function adminPayload(db) {
  const now = Math.floor(Date.now() / 1000);
  const results = await db.batch([
    db.prepare('SELECT id, roblox_username, tiktok_username, source, created_at FROM qualified_entries ORDER BY id DESC'),
    db.prepare(
      'SELECT id, roblox_username, tiktok_username, reason, disqualified_at, cooldown_until FROM disqualified_entries ORDER BY id DESC'
    ),
    db.prepare('SELECT id, roblox_username, reason, banned_at FROM permanent_blacklist ORDER BY id DESC'),
    db.prepare('SELECT config_key, config_value FROM system_config'),
  ]);
  const config = {};
  for (const row of results[3].results || []) config[row.config_key] = row.config_value;
  return {
    ok: true,
    serverTime: now,
    qualified: results[0].results || [],
    disqualified: results[1].results || [],
    blacklist: results[2].results || [],
    state: {
      registrationOpen: (config.registration_gate || 'open') !== 'closed',
      wheelCommand: config.wheel_command || 'idle',
      lastLanded: config.last_landed || '',
      forceReset: config.force_reset === 'true',
      resetId: config.reset_id || '0',
    },
  };
}

async function parseBody(request) {
  const declared = parseInt(request.headers.get('content-length') || '0', 10);
  if (declared > MAX_BODY_BYTES) return null;
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : null;
  } catch (error) {
    return null;
  }
}

function cleanName(value) {
  const name = String(value || '').trim();
  return NAME_PATTERN.test(name) ? name.toLowerCase() : null;
}

function randomSeed() {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] / 4294967296;
}

async function handlePublicPost(db, body) {
  if (body.action === 'ack_reset') {
    await setConfigStatement(db, 'force_reset', 'false').run();
    return json({ ok: true });
  }

  if (body.action === 'landed') {
    const nonce = String(body.nonce || '');
    const name = cleanName(body.name);
    if (!nonce || !name) return json({ ok: false, message: 'Invalid landing report.' }, 400);
    const config = await readAllConfig(db);
    if (config.spin_nonce !== nonce || (config.wheel_command || 'idle') === 'idle') {
      return json({ ok: true, ignored: true });
    }
    const member = await db.prepare('SELECT 1 AS hit FROM qualified_entries WHERE roblox_username = ?1').bind(name).first();
    if (!member) return json({ ok: true, ignored: true });
    await db.batch([setConfigStatement(db, 'last_landed', name), setConfigStatement(db, 'wheel_command', 'idle')]);
    return json({ ok: true });
  }

  return json({ ok: false, message: 'Unknown action.' }, 400);
}

async function handleAdminPost(db, body) {
  const now = Math.floor(Date.now() / 1000);

  switch (body.action) {
    case 'add_manual': {
      const roblox = cleanName(body.roblox);
      if (!roblox) {
        return json({ ok: false, message: 'Usernames may only use letters, numbers and underscores (3-20 characters).' }, 400);
      }
      const banned = await db.prepare('SELECT 1 AS hit FROM permanent_blacklist WHERE roblox_username = ?1').bind(roblox).first();
      if (banned) return json({ ok: false, message: roblox + ' is on the permanent blacklist.' }, 403);

      /* An admin override lifts an existing cooldown, then the unique key still blocks true duplicates. */
      const results = await db.batch([
        db.prepare('DELETE FROM disqualified_entries WHERE roblox_username = ?1').bind(roblox),
        db
          .prepare("INSERT OR IGNORE INTO qualified_entries (roblox_username, tiktok_username, source, created_at) VALUES (?1, '', 'manual', ?2)")
          .bind(roblox, now),
      ]);
      const inserted = results[1].meta && results[1].meta.changes > 0;
      if (!inserted) return json({ ok: false, message: roblox + ' is already on the wheel.' }, 409);
      return json({ ok: true, message: roblox + ' added to the wheel.' });
    }

    case 'toggle_gate': {
      const open = body.open === true || body.open === 'true';
      await setConfigStatement(db, 'registration_gate', open ? 'open' : 'closed').run();
      return json({ ok: true, message: open ? 'Registration opened.' : 'Registration closed.' });
    }

    case 'perm_ban': {
      const roblox = cleanName(body.roblox);
      if (!roblox) return json({ ok: false, message: 'Invalid username.' }, 400);
      await db.batch([
        db
          .prepare('INSERT OR IGNORE INTO permanent_blacklist (roblox_username, reason, banned_at) VALUES (?1, ?2, ?3)')
          .bind(roblox, 'banned_by_admin', now),
        db.prepare('DELETE FROM qualified_entries WHERE roblox_username = ?1').bind(roblox),
        db.prepare('DELETE FROM disqualified_entries WHERE roblox_username = ?1').bind(roblox),
      ]);
      return json({ ok: true, message: roblox + ' was permanently banned.' });
    }

    case 'spin': {
      const mode = body.mode === 'eliminate' ? 'eliminate' : body.mode === 'winner' ? 'winner' : null;
      if (!mode) return json({ ok: false, message: 'Unknown spin mode.' }, 400);
      const count = await db.prepare('SELECT COUNT(*) AS total FROM qualified_entries').first();
      if (!count || !count.total) return json({ ok: false, message: 'There are no players on the wheel.' }, 409);
      await db.batch([
        setConfigStatement(db, 'wheel_command', mode),
        setConfigStatement(db, 'spin_nonce', crypto.randomUUID()),
        setConfigStatement(db, 'spin_seed', randomSeed()),
        setConfigStatement(db, 'last_landed', ''),
      ]);
      return json({ ok: true, message: mode === 'winner' ? 'Winner spin sent to the stream.' : 'Elimination spin sent to the stream.' });
    }

    case 'reset_wheel': {
      const config = await readAllConfig(db);
      const nextReset = (parseInt(config.reset_id || '0', 10) || 0) + 1;
      await db.batch([
        setConfigStatement(db, 'force_reset', 'true'),
        setConfigStatement(db, 'reset_id', nextReset),
        setConfigStatement(db, 'wheel_command', 'idle'),
        setConfigStatement(db, 'last_landed', ''),
      ]);
      return json({ ok: true, message: 'Wheel reset. The stream will reload from the database.' });
    }

    case 'wipe_tables': {
      const config = await readAllConfig(db);
      const nextReset = (parseInt(config.reset_id || '0', 10) || 0) + 1;
      await db.batch([
        db.prepare('DELETE FROM qualified_entries'),
        db.prepare('DELETE FROM disqualified_entries'),
        db.prepare('DELETE FROM live_alerts'),
        setConfigStatement(db, 'force_reset', 'true'),
        setConfigStatement(db, 'reset_id', nextReset),
        setConfigStatement(db, 'wheel_command', 'idle'),
        setConfigStatement(db, 'last_landed', ''),
      ]);
      return json({ ok: true, message: 'Event tables wiped. The permanent blacklist was kept.' });
    }

    default:
      return json({ ok: false, message: 'Unknown action.' }, 400);
  }
}

async function route(context) {
  const db = context.env.DB;
  if (!db) return json({ ok: false, message: 'Database binding is not configured.' }, 500);

  const request = context.request;
  const suppliedToken = request.headers.get('x-admin-token');
  const isAdminRequest = suppliedToken !== null;

  try {
    if (isAdminRequest) {
      const expected = context.env.ADMIN_TOKEN;
      if (!expected) return json({ ok: false, message: 'ADMIN_TOKEN is not configured on the server.' }, 500);
      if (!safeEqual(suppliedToken, expected)) return json({ ok: false, message: 'Unauthorized.' }, 401);

      if (request.method === 'GET') return json(await adminPayload(db));
      if (request.method === 'POST') {
        const body = await parseBody(request);
        if (!body) return json({ ok: false, message: 'Invalid request body.' }, 400);
        return await handleAdminPost(db, body);
      }
      return json({ ok: false, message: 'Method not allowed.' }, 405);
    }

    if (request.method === 'GET') return json(await publicPayload(db));
    if (request.method === 'POST') {
      const body = await parseBody(request);
      if (!body) return json({ ok: false, message: 'Invalid request body.' }, 400);
      return await handlePublicPost(db, body);
    }
    return json({ ok: false, message: 'Method not allowed.' }, 405);
  } catch (error) {
    return json({ ok: false, message: 'Server error.' }, 500);
  }
}

export async function onRequest(context) {
  return route(context);
}
