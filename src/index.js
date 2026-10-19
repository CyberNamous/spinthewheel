const NAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const ALERT_TTL_MS = 120000;
const MAX_BODY = 20000;
const MAX_SHOT_CHARS = 450000;
const MAX_APPLY_BODY = 520000;
const MAX_PENDING_APPS = 300;
const SPIN_LOCK_MS = 15000;
const LIST_TTL_MS = 3000;
let listCache = { at: 0, body: '' };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  });

const jsonText = (text, status = 200) =>
  new Response(text, {
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

const lev = (a, b) => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
};

const containsFan = (text, fan) => {
  const hay = norm(text);
  if (hay.includes(fan)) return true;
  if (fan.length < 7) return false;
  for (let i = 0; i < hay.length; i++) {
    for (let d = -1; d <= 1; d++) {
      const len = fan.length + d;
      if (i + len <= hay.length && lev(hay.substr(i, len), fan) <= 1) return true;
    }
  }
  return false;
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


const randomHex = (bytes) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

const cleanOcr = (t) =>
  String(t || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s.:+\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);

const cleanLine = (s, n) => String(s || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

const deviceHashFor = async (request) => {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ua = request.headers.get('User-Agent') || '';
  return (await sha256Hex(`${ip}|${ua}`)).slice(0, 32);
};

const readBody = async (request, max) => {
  const raw = await request.text();
  if (raw.length > max) return { error: json({ ok: false, error: 'Payload too large.' }, 413) };
  try {
    return { body: JSON.parse(raw) };
  } catch {
    return { error: json({ ok: false, error: 'Invalid JSON.' }, 400) };
  }
};

const findOpenGiveaway = (env, now) =>
  env.DB.prepare(
    "SELECT id, expires_at FROM giveaways WHERE status = 'open' AND expires_at > ?1 ORDER BY id DESC LIMIT 1"
  ).bind(now).first();

const activeGiveaway = (env) =>
  env.DB.prepare("SELECT id, status, opened_at, expires_at FROM giveaways WHERE status NOT IN ('ended', 'saved') ORDER BY id DESC LIMIT 1").first();

const expireGiveaways = async (env, now) => {
  const r = await env.DB.prepare(
    "UPDATE giveaways SET status = 'closed', token_hash = '' WHERE status = 'open' AND expires_at <= ?1"
  ).bind(now).run();
  if (r.meta.changes > 0) await setConfig(env, 'registration_gate', 'closed').run();
};

const currentOut = async (env) => {
  const { results } = await env.DB.prepare(
    "SELECT key, value FROM system_config WHERE key IN ('out_list', 'wheel_command', 'last_landed')"
  ).all();
  const c = {};
  for (const r of results) c[r.key] = r.value;
  let out = [];
  try {
    out = JSON.parse(c.out_list || '[]');
  } catch {
    out = [];
  }
  out = Array.isArray(out) ? out.filter((n) => typeof n === 'string') : [];
  if (c.wheel_command === 'spin_elim' && c.last_landed && !out.some((n) => n.toLowerCase() === c.last_landed.toLowerCase())) {
    out.push(c.last_landed);
  }
  return out;
};

const pickAlive = (env, gid, out) =>
  env.DB.prepare(
    `SELECT roblox_username, roblox_lower FROM qualified_entries
     WHERE giveaway_id = ?1 AND status = 'alive' AND roblox_lower NOT IN (SELECT lower(value) FROM json_each(?2))
     ORDER BY RANDOM() LIMIT 1`
  ).bind(gid, JSON.stringify(out)).first();

const claimSpin = async (env, now) => {
  const [, claim] = await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO system_config (key, value) VALUES ('last_spin_at', '0')"),
    env.DB.prepare("UPDATE system_config SET value = ?1 WHERE key = 'last_spin_at' AND CAST(value AS INTEGER) <= ?2").bind(
      String(now), now - SPIN_LOCK_MS
    )
  ]);
  return claim.meta.changes === 1;
};

const purgeEndedStatements = (env) => [
  env.DB.prepare("DELETE FROM manual_applications WHERE giveaway_id IN (SELECT id FROM giveaways WHERE status = 'ended')"),
  env.DB.prepare("DELETE FROM qualified_entries WHERE giveaway_id IN (SELECT id FROM giveaways WHERE status = 'ended')"),
  env.DB.prepare("DELETE FROM disqualified_entries WHERE giveaway_id IN (SELECT id FROM giveaways WHERE status = 'ended')"),
  env.DB.prepare("DELETE FROM giveaways WHERE status = 'ended'")
];

const matchesToken = async (request, secret) => {
  if (!secret) return false;
  const auth = request.headers.get('Authorization') || '';
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(supplied)),
    crypto.subtle.digest('SHA-256', enc.encode(secret))
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
};

const STREAM_ACTIONS = new Set([
  'verify', 'spin_winner', 'spin_elim', 'reset_wheel', 'open_giveaway', 'close_registration', 'end_giveaway'
]);

const isOwner = async (request, env) => {
  if (!env.OWNER_TOKEN) return false;
  const auth = request.headers.get('Authorization') || '';
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(supplied)),
    crypto.subtle.digest('SHA-256', enc.encode(env.OWNER_TOKEN))
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
};

async function gatekeep(env, config, body, now) {
  if (config.registration_gate !== 'open') {
    return { error: json({ ok: false, code: 'closed', error: 'No giveaway is open for registration right now.' }, 403) };
  }
  const giveaway = await findOpenGiveaway(env, now);
  if (!giveaway) {
    return { error: json({ ok: false, code: 'closed', error: 'Registration is closed right now.' }, 403) };
  }
  const roblox = String(body.roblox || '').trim();
  const tiktok = String(body.tiktok || '').trim();
  if (!NAME_RE.test(roblox) || !NAME_RE.test(tiktok)) {
    return { error: json({ ok: false, error: 'Usernames must be 3-20 letters, numbers or underscores.' }, 400) };
  }
  const rl = roblox.toLowerCase();
  const tl = tiktok.toLowerCase();
  const [banned, disq] = await env.DB.batch([
    env.DB.prepare('SELECT 1 AS hit FROM permanent_blacklist WHERE username_lower IN (?1, ?2) LIMIT 1').bind(rl, tl),
    env.DB.prepare(
      'SELECT 1 AS hit FROM disqualified_entries WHERE giveaway_id = ?1 AND (roblox_lower = ?2 OR tiktok_lower = ?3) LIMIT 1'
    ).bind(giveaway.id, rl, tl)
  ]);
  if (banned.results.length) {
    return { error: json({ ok: false, code: 'banned', error: 'This account is permanently banned from the wheel.' }, 403) };
  }
  if (disq.results.length) {
    return { error: json({ ok: false, code: 'disqualified', error: 'This account was disqualified from this giveaway.' }, 403) };
  }
  return { giveaway, roblox, tiktok, rl, tl };
}

const insertEntry = async (env, gid, roblox, rl, tiktok, tl, level, device, source, now) => {
  try {
    const r = await env.DB.prepare(
      `INSERT INTO qualified_entries (giveaway_id, roblox_username, roblox_lower, tiktok_username, tiktok_lower, level, device_hash, status, source, created_at)
       SELECT ?8, ?1, ?2, ?3, ?4, ?5, ?6, 'alive', ?9, ?7
       WHERE NOT EXISTS (SELECT 1 FROM qualified_entries WHERE giveaway_id = ?8 AND (roblox_lower = ?2 OR tiktok_lower = ?4))
         AND NOT EXISTS (SELECT 1 FROM disqualified_entries WHERE giveaway_id = ?8 AND (roblox_lower = ?2 OR tiktok_lower = ?4))`
    ).bind(roblox, rl, tiktok, tl, level, device, now, gid, source).run();
    return r.meta.changes === 1;
  } catch (err) {
    if (String(err && err.message).includes('UNIQUE')) return false;
    throw err;
  }
};

async function handleSubmit(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);
  const config = await readConfig(env);
  const { body, error } = await readBody(request, MAX_BODY);
  if (error) return error;
  const now = Date.now();

  const gate = await gatekeep(env, config, body, now);
  if (gate.error) return gate.error;
  const { giveaway, roblox, tiktok, rl, tl } = gate;

  const ocr = cleanOcr(body.ocrText);
  const level = parseLevel(ocr);
  if (level < 1) {
    return json({ ok: false, code: 'level', error: 'A fan level of 1 or higher is required.' }, 422);
  }
  const fan = norm(config.fan_club_name);
  if (!fan || !containsFan(ocr, fan)) {
    return json({ ok: false, code: 'fanclub', error: 'The fan club name was not found in the screenshot.' }, 422);
  }

  const device = await deviceHashFor(request);
  if (await insertEntry(env, giveaway.id, roblox, rl, tiktok, tl, level, device, 'ocr', now)) {
    return json({ ok: true, message: `You're in, ${roblox}. Watch the wheel on stream.` });
  }

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO disqualified_entries (giveaway_id, roblox_username, roblox_lower, tiktok_username, tiktok_lower, reason, device_hash, disqualified_at)
       SELECT ?1, ?2, ?3, ?4, ?5, 'duplicate-submission', ?6, ?7
       WHERE NOT EXISTS (SELECT 1 FROM disqualified_entries WHERE giveaway_id = ?1 AND roblox_lower = ?3 AND tiktok_lower = ?5)`
    ).bind(giveaway.id, roblox, rl, tiktok, tl, device, now),
    env.DB.prepare(
      `INSERT INTO disqualified_entries (giveaway_id, roblox_username, roblox_lower, tiktok_username, tiktok_lower, reason, device_hash, disqualified_at)
       SELECT giveaway_id, roblox_username, roblox_lower, tiktok_username, tiktok_lower, 'duplicate-submission', device_hash, ?4
       FROM qualified_entries
       WHERE giveaway_id = ?1 AND (roblox_lower = ?2 OR tiktok_lower = ?3) AND NOT (roblox_lower = ?2 AND tiktok_lower = ?3)`
    ).bind(giveaway.id, rl, tl, now),
    env.DB.prepare(
      `INSERT INTO live_alerts (message, created_at)
       SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM qualified_entries WHERE giveaway_id = ?3 AND (roblox_lower = ?4 OR tiktok_lower = ?5))`
    ).bind(`🚨 MULTI-DEVICE CHEAT CAUGHT: ${roblox} / ${tiktok} removed from the wheel`, now, giveaway.id, rl, tl),
    env.DB.prepare('DELETE FROM qualified_entries WHERE giveaway_id = ?1 AND (roblox_lower = ?2 OR tiktok_lower = ?3)').bind(
      giveaway.id, rl, tl
    )
  ]);
  return json(
    { ok: false, code: 'duplicate', error: 'Duplicate submission detected. You were removed from this giveaway.' },
    409
  );
}

async function handleApply(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);
  const config = await readConfig(env);
  const { body, error } = await readBody(request, MAX_APPLY_BODY);
  if (error) return error;
  const now = Date.now();

  const gate = await gatekeep(env, config, body, now);
  if (gate.error) return gate.error;
  const { giveaway, roblox, tiktok, rl, tl } = gate;

  const shot = String(body.screenshot || '');
  if (shot.length > MAX_SHOT_CHARS || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(shot)) {
    return json({ ok: false, error: 'The screenshot is missing or too large.' }, 400);
  }

  const onWheel = await env.DB.prepare(
    'SELECT 1 AS hit FROM qualified_entries WHERE giveaway_id = ?1 AND (roblox_lower = ?2 OR tiktok_lower = ?3) LIMIT 1'
  ).bind(giveaway.id, rl, tl).first();
  if (onWheel) return json({ ok: false, code: 'entered', error: 'You are already on the wheel.' }, 409);

  const key = randomHex(16);
  const device = await deviceHashFor(request);
  const r = await env.DB.prepare(
    `INSERT INTO manual_applications (giveaway_id, roblox_username, roblox_lower, tiktok_username, tiktok_lower, note, reason, ocr_excerpt, device_hash, screenshot, check_key, status, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending', ?12
     WHERE (SELECT COUNT(*) FROM manual_applications WHERE giveaway_id = ?1 AND status = 'pending') < ?13`
  ).bind(
    giveaway.id, roblox, rl, tiktok, tl,
    cleanLine(body.note, 300), cleanLine(body.reason, 200), cleanOcr(body.ocrText).slice(0, 600),
    device, shot, key, now, MAX_PENDING_APPS
  ).run();
  if (r.meta.changes !== 1) {
    return json({ ok: false, code: 'busy', error: 'Too many manual applications are waiting right now. Please try again in a few minutes.' }, 429);
  }
  return json({ ok: true, id: r.meta.last_row_id, key });
}

async function handleApplyStatus(request, env, url) {
  if (request.method !== 'GET') return json({ ok: false, error: 'Method not allowed.' }, 405);
  const id = Number(url.searchParams.get('id'));
  const key = String(url.searchParams.get('key') || '');
  if (!Number.isInteger(id) || !/^[a-f0-9]{16,64}$/.test(key)) return json({ ok: false, error: 'Bad request.' }, 400);
  const row = await env.DB.prepare('SELECT status, reject_reason FROM manual_applications WHERE id = ?1 AND check_key = ?2')
    .bind(id, key).first();
  if (!row) return json({ ok: true, status: 'removed', reason: '' });
  return json({ ok: true, status: row.status, reason: row.reject_reason || '' });
}

async function handleRegistration(request, env) {
  if (request.method !== 'GET') return json({ ok: false, error: 'Method not allowed.' }, 405);
  const config = await readConfig(env);
  const open = config.registration_gate === 'open' && !!(await findOpenGiveaway(env, Date.now()));
  return json({ ok: true, open });
}

async function handlePublicList(request, env) {
  if (request.method !== 'GET') return json({ ok: false, error: 'Method not allowed.' }, 405);
  const now = Date.now();
  if (listCache.body && now - listCache.at < LIST_TTL_MS) return jsonText(listCache.body);
  const [entries, alerts, cfg, live] = await env.DB.batch([
    env.DB.prepare(
      "SELECT roblox_username AS name, status FROM qualified_entries WHERE giveaway_id IN (SELECT id FROM giveaways WHERE status NOT IN ('ended', 'saved')) ORDER BY id ASC"
    ),
    env.DB.prepare('SELECT id, message, created_at FROM live_alerts WHERE created_at > ?1 ORDER BY id DESC LIMIT 5').bind(
      now - ALERT_TTL_MS
    ),
    env.DB.prepare(
      "SELECT key, value FROM system_config WHERE key IN ('wheel_command','force_reset','last_landed','spin_id','registration_gate','out_list')"
    ),
    env.DB.prepare("SELECT status, expires_at FROM giveaways WHERE status NOT IN ('ended', 'saved') ORDER BY id DESC LIMIT 1")
  ]);
  const c = {};
  for (const row of cfg.results) c[row.key] = row.value;
  const g = live.results[0];
  const registration = !g ? 'none' : g.status === 'open' && g.expires_at > now && c.registration_gate === 'open' ? 'open' : 'closed';
  let outList = [];
  try {
    outList = JSON.parse(c.out_list || '[]');
  } catch {
    outList = [];
  }
  const payload = JSON.stringify({
    ok: true,
    registration,
    out: Array.isArray(outList) ? outList : [],
    entries: entries.results,
    alerts: alerts.results,
    command: c.wheel_command || 'idle',
    spin_id: Number(c.spin_id || 0),
    target: c.last_landed || '',
    force_reset: c.force_reset === 'true',
    gate: c.registration_gate || 'open'
  });
  listCache = { at: now, body: payload };
  return jsonText(payload);
}

async function handleOwnerAction(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);
  if (!(await isOwner(request, env))) return json({ ok: false, error: 'Unauthorized.' }, 401);
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  if (body.action === 'verify') return json({ ok: true });
  if (body.action !== 'metrics') return json({ ok: false, error: 'Unknown action.' }, 400);

  const now = Date.now();
  const g = await env.DB.prepare(
    "SELECT id, status, opened_at, expires_at, ended_at FROM giveaways WHERE status != 'saved' ORDER BY id DESC LIMIT 1"
  ).first();
  const gid = g ? g.id : 0;
  const [totals, timeline, apps, disq, shared, levels, counts, cfg, alerts] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(status = 'alive'), 0) AS alive,
              COALESCE(SUM(status = 'winner'), 0) AS winners,
              COALESCE(SUM(source = 'ocr'), 0) AS ocr,
              COALESCE(SUM(source = 'manual'), 0) AS manual,
              COALESCE(SUM(source = 'manual-approved'), 0) AS approved,
              COALESCE(ROUND(AVG(CASE WHEN level > 0 THEN level END), 1), 0) AS avg_level,
              COALESCE(MAX(level), 0) AS max_level
       FROM qualified_entries WHERE giveaway_id = ?1`
    ).bind(gid),
    env.DB.prepare(
      'SELECT (created_at / 300000) * 300000 AS t, COUNT(*) AS n FROM qualified_entries WHERE giveaway_id = ?1 GROUP BY t ORDER BY t ASC LIMIT 400'
    ).bind(gid),
    env.DB.prepare('SELECT status, COUNT(*) AS n FROM manual_applications WHERE giveaway_id = ?1 GROUP BY status').bind(gid),
    env.DB.prepare('SELECT reason, COUNT(*) AS n FROM disqualified_entries WHERE giveaway_id = ?1 GROUP BY reason ORDER BY n DESC').bind(gid),
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM (SELECT device_hash FROM qualified_entries WHERE giveaway_id = ?1 AND device_hash != '' GROUP BY device_hash HAVING COUNT(*) > 1)"
    ).bind(gid),
    env.DB.prepare(
      `SELECT CASE WHEN level >= 50 THEN '50+' WHEN level >= 20 THEN '20-49' WHEN level >= 10 THEN '10-19' WHEN level >= 5 THEN '5-9' ELSE 'unscanned' END AS band,
              COUNT(*) AS n
       FROM qualified_entries WHERE giveaway_id = ?1 GROUP BY band`
    ).bind(gid),
    env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM qualified_entries) AS qualified,
              (SELECT COUNT(*) FROM disqualified_entries) AS disqualified,
              (SELECT COUNT(*) FROM manual_applications) AS applications,
              (SELECT COUNT(*) FROM giveaways) AS giveaways,
              (SELECT COUNT(*) FROM giveaways WHERE status = 'saved') AS saved,
              (SELECT COUNT(*) FROM live_alerts) AS alerts,
              (SELECT COUNT(*) FROM permanent_blacklist) AS bans,
              (SELECT COALESCE(SUM(LENGTH(screenshot)), 0) FROM manual_applications) AS screenshot_bytes`
    ),
    env.DB.prepare("SELECT key, value FROM system_config WHERE key IN ('wheel_command','spin_id','last_landed','registration_gate')"),
    env.DB.prepare('SELECT message, created_at FROM live_alerts ORDER BY id DESC LIMIT 5')
  ]);
  const c = {};
  for (const row of cfg.results) c[row.key] = row.value;
  const appStatus = {};
  for (const row of apps.results) appStatus[row.status] = row.n;
  let effective = g ? g.status : 'none';
  if (g && g.status === 'open' && g.expires_at <= now) effective = 'expired';
  return json({
    ok: true,
    now,
    giveaway: g ? { ...g, effective } : null,
    entries: totals.results[0],
    timeline: timeline.results,
    applications: appStatus,
    disqualified: disq.results,
    shared_devices: shared.results[0] ? shared.results[0].n : 0,
    levels: levels.results,
    storage: counts.results[0],
    wheel: {
      command: c.wheel_command || 'idle',
      spins: Number(c.spin_id || 0),
      last_landed: c.last_landed || '',
      gate: c.registration_gate || 'open'
    },
    alerts: alerts.results
  });
}

async function handleStreamAction(request, env, url) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);
  const allowed = (await matchesToken(request, env.STREAM_TOKEN)) || (await matchesToken(request, env.ADMIN_TOKEN));
  if (!allowed) return json({ ok: false, error: 'Unauthorized.' }, 401);
  let body;
  try {
    body = await request.clone().json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON.' }, 400);
  }
  if (!STREAM_ACTIONS.has(body.action)) {
    return json({ ok: false, error: 'That action is only available in the admin panel.' }, 403);
  }
  if (body.action === 'verify') return json({ ok: true });
  return handleAdminAction(request, env, url, true);
}

async function handleAdminAction(request, env, url, authed = false) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);
  if (!authed && !(await isAdmin(request, env, url))) return json({ ok: false, error: 'Unauthorized.' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON.' }, 400);
  }
  const now = Date.now();
  const noGiveaway = () => json({ ok: false, error: 'There is no active giveaway. Open one first.' }, 409);

  switch (body.action) {
    case 'verify':
      return json({ ok: true });

    case 'get_state': {
      await expireGiveaways(env, now);
      const latest = await env.DB.prepare(
        "SELECT id, status, opened_at, expires_at, ended_at FROM giveaways WHERE status != 'saved' ORDER BY id DESC LIMIT 1"
      ).first();
      const gid = latest ? latest.id : 0;
      const [mq, md, ma, mal, wheelCfg, savedFp] = await env.DB.batch([
        env.DB.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM qualified_entries'),
        env.DB.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM disqualified_entries'),
        env.DB.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM manual_applications'),
        env.DB.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM live_alerts'),
        env.DB.prepare(
          "SELECT key, value FROM system_config WHERE key IN ('spin_id','wheel_command','last_landed','force_reset') ORDER BY key"
        ),
        env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS m FROM giveaways WHERE status = 'saved'")
      ]);
      const fp = [
        gid, latest ? latest.status : 'none', mq.results[0].m, md.results[0].m, ma.results[0].m, mal.results[0].m,
        wheelCfg.results.map((r) => r.value).join('~'),
        `${savedFp.results[0].n}:${savedFp.results[0].m}`
      ].join('.');
      if (!body.force && body.fp && body.fp === fp) {
        return json({ ok: true, unchanged: true, fp, giveaway: latest || null, now });
      }
      const [q, d, b, a, apps, savedList] = await env.DB.batch([
        env.DB.prepare(
          'SELECT id, roblox_username, tiktok_username, level, status, source, device_hash, created_at FROM qualified_entries WHERE giveaway_id = ?1 ORDER BY id ASC'
        ).bind(gid),
        env.DB.prepare(
          'SELECT id, roblox_username, tiktok_username, reason, disqualified_at FROM disqualified_entries WHERE giveaway_id = ?1 ORDER BY id DESC LIMIT 500'
        ).bind(gid),
        env.DB.prepare('SELECT id, username, reason, banned_at FROM permanent_blacklist ORDER BY id DESC LIMIT 500'),
        env.DB.prepare('SELECT id, message, created_at FROM live_alerts ORDER BY id DESC LIMIT 20'),
        env.DB.prepare(
          `SELECT a.id, a.roblox_username, a.tiktok_username, a.note, a.reason, a.ocr_excerpt, a.device_hash, a.created_at,
                  EXISTS (SELECT 1 FROM qualified_entries q WHERE q.giveaway_id = a.giveaway_id AND (q.roblox_lower = a.roblox_lower OR q.tiktok_lower = a.tiktok_lower)) AS dup
           FROM manual_applications a WHERE a.giveaway_id = ?1 AND a.status = 'pending' ORDER BY a.id ASC LIMIT 300`
        ).bind(gid),
        env.DB.prepare(
          `SELECT g.id, g.opened_at, g.ended_at,
                  (SELECT COUNT(*) FROM qualified_entries q WHERE q.giveaway_id = g.id) AS entries,
                  (SELECT COUNT(*) FROM disqualified_entries x WHERE x.giveaway_id = g.id) AS disqualified,
                  (SELECT COUNT(*) FROM manual_applications m WHERE m.giveaway_id = g.id AND m.status = 'pending') AS pending
           FROM giveaways g WHERE g.status = 'saved' ORDER BY g.id DESC LIMIT 20`
        )
      ]);
      return json({
        ok: true,
        fp,
        giveaway: latest || null,
        qualified: q.results,
        disqualified: d.results,
        blacklist: b.results,
        alerts: a.results,
        applications: apps.results,
        saved: savedList.results,
        config: await readConfig(env),
        now
      });
    }

    case 'open_giveaway': {
      if (await activeGiveaway(env)) {
        return json({ ok: false, error: 'A giveaway is already active. End it before opening a new one.' }, 409);
      }
      const expires = now + TOKEN_TTL_MS;
      await env.DB.batch([
        ...purgeEndedStatements(env),
        env.DB.prepare("INSERT INTO giveaways (token_hash, status, opened_at, expires_at) VALUES ('', 'open', ?1, ?2)").bind(
          now, expires
        ),
        setConfig(env, 'registration_gate', 'open'),
        setConfig(env, 'wheel_command', 'idle'),
        setConfig(env, 'last_landed', ''),
        setConfig(env, 'force_reset', 'true'),
        setConfig(env, 'last_spin_at', '0'),
        setConfig(env, 'out_list', '[]')
      ]);
      return json({ ok: true, expires_at: expires });
    }

    case 'close_registration': {
      const g = await activeGiveaway(env);
      if (!g) return noGiveaway();
      await env.DB.batch([
        env.DB.prepare("UPDATE giveaways SET status = 'closed', token_hash = '' WHERE id = ?1 AND status = 'open'").bind(g.id),
        setConfig(env, 'registration_gate', 'closed')
      ]);
      return json({ ok: true });
    }

    case 'end_giveaway': {
      const g = await activeGiveaway(env);
      if (!g) return noGiveaway();
      await env.DB.batch([
        env.DB.prepare("UPDATE giveaways SET status = 'ended', token_hash = '', ended_at = ?2 WHERE id = ?1").bind(g.id, now),
        env.DB.prepare(
          "UPDATE manual_applications SET status = 'rejected', reject_reason = 'The giveaway ended.', screenshot = '', decided_at = ?2 WHERE giveaway_id = ?1 AND status = 'pending'"
        ).bind(g.id, now),
        setConfig(env, 'registration_gate', 'closed'),
        setConfig(env, 'wheel_command', 'idle'),
        setConfig(env, 'last_landed', ''),
        setConfig(env, 'force_reset', 'true'),
        setConfig(env, 'last_spin_at', '0'),
        setConfig(env, 'out_list', '[]')
      ]);
      return json({ ok: true });
    }

    case 'save_and_new': {
      const g = await activeGiveaway(env);
      if (!g) return noGiveaway();
      const [won, cfgRows] = await env.DB.batch([
        env.DB.prepare("SELECT COUNT(*) AS n FROM qualified_entries WHERE giveaway_id = ?1 AND status = 'winner'").bind(g.id),
        env.DB.prepare("SELECT key, value FROM system_config WHERE key IN ('wheel_command', 'out_list')")
      ]);
      const cfgMap = {};
      for (const r of cfgRows.results) cfgMap[r.key] = r.value;
      let outCount = 0;
      try {
        outCount = JSON.parse(cfgMap.out_list || '[]').length;
      } catch {
        outCount = 0;
      }
      if (won.results[0].n > 0 || outCount > 0 || ['spin_winner', 'spin_elim'].includes(cfgMap.wheel_command)) {
        return json({ ok: false, code: 'spun', error: 'The wheel has already been spun for this giveaway. End it instead, or reset the wheel first.' }, 409);
      }
      const carry = body.carry === true;
      const expires = now + TOKEN_TTL_MS;
      const NEW = '(SELECT MAX(id) FROM giveaways)';
      const stmts = [
        ...purgeEndedStatements(env),
        env.DB.prepare("UPDATE giveaways SET status = 'saved', token_hash = '', ended_at = ?2 WHERE id = ?1").bind(g.id, now),
        env.DB.prepare("INSERT INTO giveaways (token_hash, status, opened_at, expires_at) VALUES ('', 'open', ?1, ?2)").bind(now, expires)
      ];
      const copyAt = stmts.length;
      if (carry) {
        stmts.push(
          env.DB.prepare(
            `INSERT INTO qualified_entries (giveaway_id, roblox_username, roblox_lower, tiktok_username, tiktok_lower, level, device_hash, status, source, created_at)
             SELECT ${NEW}, roblox_username, roblox_lower, tiktok_username, tiktok_lower, level, device_hash, 'alive', source, created_at
             FROM qualified_entries WHERE giveaway_id = ?1`
          ).bind(g.id),
          env.DB.prepare(
            `INSERT INTO disqualified_entries (giveaway_id, roblox_username, roblox_lower, tiktok_username, tiktok_lower, reason, device_hash, disqualified_at)
             SELECT ${NEW}, roblox_username, roblox_lower, tiktok_username, tiktok_lower, reason, device_hash, disqualified_at
             FROM disqualified_entries WHERE giveaway_id = ?1`
          ).bind(g.id),
          env.DB.prepare(`UPDATE manual_applications SET giveaway_id = ${NEW} WHERE giveaway_id = ?1 AND status = 'pending'`).bind(g.id)
        );
      }
      stmts.push(
        setConfig(env, 'registration_gate', 'open'),
        setConfig(env, 'wheel_command', 'idle'),
        setConfig(env, 'last_landed', ''),
        setConfig(env, 'force_reset', 'true'),
        setConfig(env, 'last_spin_at', '0'),
        setConfig(env, 'out_list', '[]')
      );
      const results = await env.DB.batch(stmts);
      return json({
        ok: true,
        expires_at: expires,
        carried: carry
          ? {
              entries: results[copyAt].meta.changes,
              disqualified: results[copyAt + 1].meta.changes,
              applications: results[copyAt + 2].meta.changes
            }
          : null
      });
    }

    case 'migrate_in': {
      const target = await activeGiveaway(env);
      if (!target) return noGiveaway();
      const sid = Number(body.id);
      if (!Number.isInteger(sid)) return json({ ok: false, error: 'Invalid session.' }, 400);
      const src = await env.DB.prepare("SELECT id FROM giveaways WHERE id = ?1 AND status = 'saved'").bind(sid).first();
      if (!src) return json({ ok: false, error: 'That saved session no longer exists.' }, 404);
      const [dq, ent] = await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO disqualified_entries (giveaway_id, roblox_username, roblox_lower, tiktok_username, tiktok_lower, reason, device_hash, disqualified_at)
           SELECT ?1, s.roblox_username, s.roblox_lower, s.tiktok_username, s.tiktok_lower, s.reason, s.device_hash, s.disqualified_at
           FROM disqualified_entries s
           WHERE s.giveaway_id = ?2
             AND NOT EXISTS (SELECT 1 FROM disqualified_entries x WHERE x.giveaway_id = ?1 AND (x.roblox_lower = s.roblox_lower OR x.tiktok_lower = s.tiktok_lower))
             AND NOT EXISTS (SELECT 1 FROM qualified_entries t WHERE t.giveaway_id = ?1 AND (t.roblox_lower = s.roblox_lower OR t.tiktok_lower = s.tiktok_lower))`
        ).bind(target.id, sid),
        env.DB.prepare(
          `INSERT INTO qualified_entries (giveaway_id, roblox_username, roblox_lower, tiktok_username, tiktok_lower, level, device_hash, status, source, created_at)
           SELECT ?1, s.roblox_username, s.roblox_lower, s.tiktok_username, s.tiktok_lower, s.level, s.device_hash, 'alive', s.source, s.created_at
           FROM qualified_entries s
           WHERE s.giveaway_id = ?2
             AND NOT EXISTS (SELECT 1 FROM qualified_entries t WHERE t.giveaway_id = ?1 AND (t.roblox_lower = s.roblox_lower OR t.tiktok_lower = s.tiktok_lower))
             AND NOT EXISTS (SELECT 1 FROM disqualified_entries x WHERE x.giveaway_id = ?1 AND (x.roblox_lower = s.roblox_lower OR x.tiktok_lower = s.tiktok_lower))
             AND s.roblox_lower NOT IN (SELECT username_lower FROM permanent_blacklist)
             AND s.tiktok_lower NOT IN (SELECT username_lower FROM permanent_blacklist)`
        ).bind(target.id, sid)
      ]);
      return json({ ok: true, entries: ent.meta.changes, disqualified: dq.meta.changes });
    }

    case 'delete_saved': {
      const sid = Number(body.id);
      if (!Number.isInteger(sid)) return json({ ok: false, error: 'Invalid session.' }, 400);
      const src = await env.DB.prepare("SELECT id FROM giveaways WHERE id = ?1 AND status = 'saved'").bind(sid).first();
      if (!src) return json({ ok: false, error: 'That saved session no longer exists.' }, 404);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM manual_applications WHERE giveaway_id = ?1').bind(sid),
        env.DB.prepare('DELETE FROM qualified_entries WHERE giveaway_id = ?1').bind(sid),
        env.DB.prepare('DELETE FROM disqualified_entries WHERE giveaway_id = ?1').bind(sid),
        env.DB.prepare("DELETE FROM giveaways WHERE id = ?1 AND status = 'saved'").bind(sid)
      ]);
      return json({ ok: true });
    }

    case 'purge_ended':
      await env.DB.batch(purgeEndedStatements(env));
      return json({ ok: true });

    case 'spin_winner': {
      const g = await activeGiveaway(env);
      if (!g) return noGiveaway();
      const out = await currentOut(env);
      const pick = await pickAlive(env, g.id, out);
      if (!pick) return json({ ok: false, error: 'No survivors left to crown.' }, 409);
      if (!(await claimSpin(env, now))) return json({ ok: false, error: 'A spin is already in progress. Wait a few seconds.' }, 409);
      await env.DB.batch([
        env.DB.prepare("UPDATE qualified_entries SET status = 'winner' WHERE giveaway_id = ?1 AND roblox_lower = ?2").bind(
          g.id, pick.roblox_lower
        ),
        setConfig(env, 'out_list', JSON.stringify(out)),
        setConfig(env, 'wheel_command', 'spin_winner'),
        setConfig(env, 'last_landed', pick.roblox_username),
        setConfig(env, 'force_reset', 'false'),
        bumpSpin(env)
      ]);
      return json({ ok: true, winner: pick.roblox_username });
    }

    case 'spin_elim': {
      const g = await activeGiveaway(env);
      if (!g) return noGiveaway();
      const out = await currentOut(env);
      const pick = await pickAlive(env, g.id, out);
      if (!pick) return json({ ok: false, error: 'Nobody is left to knock out.' }, 409);
      if (!(await claimSpin(env, now))) return json({ ok: false, error: 'A spin is already in progress. Wait a few seconds.' }, 409);
      await env.DB.batch([
        setConfig(env, 'out_list', JSON.stringify(out)),
        setConfig(env, 'wheel_command', 'spin_elim'),
        setConfig(env, 'last_landed', pick.roblox_username),
        setConfig(env, 'force_reset', 'false'),
        bumpSpin(env)
      ]);
      return json({ ok: true, target: pick.roblox_username });
    }

    case 'reset_wheel':
      await env.DB.batch([
        env.DB.prepare("UPDATE qualified_entries SET status = 'alive'"),
        setConfig(env, 'wheel_command', 'idle'),
        setConfig(env, 'last_landed', ''),
        setConfig(env, 'force_reset', 'true'),
        setConfig(env, 'last_spin_at', '0'),
        setConfig(env, 'out_list', '[]')
      ]);
      return json({ ok: true });

    case 'perm_ban': {
      const username = String(body.username || '').trim();
      if (!NAME_RE.test(username)) return json({ ok: false, error: 'Invalid username.' }, 400);
      const lower = username.toLowerCase();
      await env.DB.batch([
        env.DB.prepare(
          'INSERT OR IGNORE INTO permanent_blacklist (username, username_lower, reason, banned_at) VALUES (?1, ?2, ?3, ?4)'
        ).bind(username, lower, cleanLine(body.reason || 'admin ban', 200), now),
        env.DB.prepare('DELETE FROM qualified_entries WHERE roblox_lower = ?1 OR tiktok_lower = ?1').bind(lower),
        env.DB.prepare("DELETE FROM manual_applications WHERE status = 'pending' AND (roblox_lower = ?1 OR tiktok_lower = ?1)").bind(lower)
      ]);
      return json({ ok: true });
    }

    case 'disqualify': {
      const allowed = ['multiple entries', 'fake screenshot', 'other'];
      const reasonKey = allowed.includes(body.reason) ? body.reason : 'other';
      const reason = `manual: ${reasonKey}`;
      let existing = null;
      let gid = 0;
      let ru;
      let rl;
      if (body.id !== undefined && body.id !== null && body.id !== '' && Number.isInteger(Number(body.id))) {
        existing = await env.DB.prepare('SELECT * FROM qualified_entries WHERE id = ?1').bind(Number(body.id)).first();
        if (!existing) return json({ ok: false, error: 'That entry no longer exists.' }, 404);
        gid = existing.giveaway_id;
        ru = existing.roblox_username;
        rl = existing.roblox_lower;
      } else {
        const g = await activeGiveaway(env);
        if (!g) return noGiveaway();
        gid = g.id;
        ru = String(body.roblox || '').trim();
        if (!NAME_RE.test(ru)) return json({ ok: false, error: 'Enter a valid Roblox username.' }, 400);
        rl = ru.toLowerCase();
        existing = await env.DB.prepare('SELECT * FROM qualified_entries WHERE giveaway_id = ?1 AND roblox_lower = ?2').bind(gid, rl).first();
      }
      const tu = existing ? existing.tiktok_username : '(unknown)';
      const tl = existing ? existing.tiktok_lower : '(unknown)';
      const device = existing ? existing.device_hash || '' : '';
      const statements = [
        env.DB.prepare(
          `INSERT INTO disqualified_entries (giveaway_id, roblox_username, roblox_lower, tiktok_username, tiktok_lower, reason, device_hash, disqualified_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
        ).bind(gid, ru, rl, tu, tl, reason, device, now),
        env.DB.prepare("DELETE FROM manual_applications WHERE giveaway_id = ?1 AND status = 'pending' AND (roblox_lower = ?2 OR tiktok_lower = ?3)").bind(gid, rl, tl),
        env.DB.prepare('INSERT INTO live_alerts (message, created_at) VALUES (?1, ?2)').bind(`🚨 DISQUALIFIED: ${ru} (${reasonKey})`, now)
      ];
      if (existing) statements.push(env.DB.prepare('DELETE FROM qualified_entries WHERE id = ?1').bind(existing.id));
      await env.DB.batch(statements);
      return json({ ok: true });
    }

    case 'manual_add': {
      const g = await activeGiveaway(env);
      if (!g) return noGiveaway();
      const roblox = String(body.roblox || '').trim();
      const tiktok = String(body.tiktok || '').trim();
      if (!NAME_RE.test(roblox) || !NAME_RE.test(tiktok)) {
        return json({ ok: false, error: 'Both usernames must be 3-20 letters, numbers or underscores.' }, 400);
      }
      const rl = roblox.toLowerCase();
      const tl = tiktok.toLowerCase();
      await env.DB.prepare('DELETE FROM disqualified_entries WHERE giveaway_id = ?1 AND (roblox_lower = ?2 OR tiktok_lower = ?3)')
        .bind(g.id, rl, tl).run();
      if (!(await insertEntry(env, g.id, roblox, rl, tiktok, tl, 0, '', 'manual', now))) {
        return json({ ok: false, error: 'That user is already on the wheel.' }, 409);
      }
      return json({ ok: true });
    }

    case 'remove_entry': {
      const id = Number(body.id);
      if (!Number.isInteger(id)) return json({ ok: false, error: 'Invalid id.' }, 400);
      await env.DB.prepare('DELETE FROM qualified_entries WHERE id = ?1').bind(id).run();
      return json({ ok: true });
    }

    case 'get_screenshot': {
      const id = Number(body.id);
      if (!Number.isInteger(id)) return json({ ok: false, error: 'Invalid id.' }, 400);
      const row = await env.DB.prepare("SELECT screenshot FROM manual_applications WHERE id = ?1 AND status = 'pending'").bind(id).first();
      if (!row) return json({ ok: false, error: 'That application is no longer pending.' }, 404);
      return json({ ok: true, screenshot: row.screenshot });
    }

    case 'app_accept': {
      const id = Number(body.id);
      if (!Number.isInteger(id)) return json({ ok: false, error: 'Invalid id.' }, 400);
      const app = await env.DB.prepare("SELECT * FROM manual_applications WHERE id = ?1 AND status = 'pending'").bind(id).first();
      if (!app) return json({ ok: false, error: 'That application is no longer pending.' }, 404);
      const [banned, disq] = await env.DB.batch([
        env.DB.prepare('SELECT 1 AS hit FROM permanent_blacklist WHERE username_lower IN (?1, ?2) LIMIT 1').bind(app.roblox_lower, app.tiktok_lower),
        env.DB.prepare(
          'SELECT 1 AS hit FROM disqualified_entries WHERE giveaway_id = ?1 AND (roblox_lower = ?2 OR tiktok_lower = ?3) LIMIT 1'
        ).bind(app.giveaway_id, app.roblox_lower, app.tiktok_lower)
      ]);
      if (banned.results.length) return json({ ok: false, error: 'This player is permanently banned.' }, 409);
      if (disq.results.length) return json({ ok: false, error: 'This player was disqualified from this giveaway.' }, 409);
      const added = await insertEntry(
        env, app.giveaway_id, app.roblox_username, app.roblox_lower, app.tiktok_username, app.tiktok_lower, 0, app.device_hash, 'manual-approved', now
      );
      if (!added) return json({ ok: false, error: 'Duplicate: that player is already on the wheel.' }, 409);
      await env.DB.batch([
        env.DB.prepare("UPDATE manual_applications SET status = 'accepted', screenshot = '', decided_at = ?2 WHERE id = ?1").bind(id, now),
        env.DB.prepare(
          "DELETE FROM manual_applications WHERE giveaway_id = ?1 AND status = 'pending' AND (roblox_lower = ?2 OR tiktok_lower = ?3)"
        ).bind(app.giveaway_id, app.roblox_lower, app.tiktok_lower)
      ]);
      return json({ ok: true });
    }

    case 'app_reject': {
      const id = Number(body.id);
      if (!Number.isInteger(id)) return json({ ok: false, error: 'Invalid id.' }, 400);
      const app = await env.DB.prepare("SELECT giveaway_id, roblox_lower, tiktok_lower FROM manual_applications WHERE id = ?1 AND status = 'pending'").bind(id).first();
      if (!app) return json({ ok: false, error: 'That application is no longer pending.' }, 404);
      await env.DB.prepare(
        "UPDATE manual_applications SET status = 'rejected', reject_reason = ?2, screenshot = '', decided_at = ?3 WHERE giveaway_id = ?1 AND status = 'pending' AND (roblox_lower = ?4 OR tiktok_lower = ?5)"
      ).bind(app.giveaway_id, cleanLine(body.reason, 150), now, app.roblox_lower, app.tiktok_lower).run();
      return json({ ok: true });
    }

    case 'app_remove_username': {
      const username = String(body.username || '').trim();
      if (!NAME_RE.test(username)) return json({ ok: false, error: 'Invalid username.' }, 400);
      const lower = username.toLowerCase();
      const r = await env.DB.prepare("DELETE FROM manual_applications WHERE status = 'pending' AND (roblox_lower = ?1 OR tiktok_lower = ?1)").bind(lower).run();
      return json({ ok: true, removed: r.meta.changes });
    }

    case 'app_remove_device': {
      const device = String(body.device_hash || '');
      if (!/^[a-f0-9]{8,64}$/.test(device)) return json({ ok: false, error: 'Invalid device tag.' }, 400);
      const r = await env.DB.prepare("DELETE FROM manual_applications WHERE status = 'pending' AND device_hash = ?1").bind(device).run();
      return json({ ok: true, removed: r.meta.changes });
    }

    case 'app_clear_all': {
      const r = await env.DB.prepare("DELETE FROM manual_applications WHERE status = 'pending'").run();
      return json({ ok: true, removed: r.meta.changes });
    }

    case 'clear_alerts':
      await env.DB.prepare('DELETE FROM live_alerts').run();
      return json({ ok: true });

    case 'wipe_d1':
      await env.DB.batch([
        env.DB.prepare('DELETE FROM qualified_entries'),
        env.DB.prepare('DELETE FROM disqualified_entries'),
        env.DB.prepare('DELETE FROM manual_applications'),
        env.DB.prepare('DELETE FROM giveaways'),
        env.DB.prepare('DELETE FROM live_alerts'),
        setConfig(env, 'registration_gate', 'closed'),
        setConfig(env, 'wheel_command', 'idle'),
        setConfig(env, 'last_landed', ''),
        setConfig(env, 'force_reset', 'true'),
        setConfig(env, 'spin_id', '0'),
        setConfig(env, 'last_spin_at', '0'),
        setConfig(env, 'out_list', '[]')
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
      if (url.pathname === '/api/registration') return await handleRegistration(request, env);
      if (url.pathname === '/api/apply') return await handleApply(request, env);
      if (url.pathname === '/api/apply-status') return await handleApplyStatus(request, env, url);
      if (url.pathname === '/api/public-list') return await handlePublicList(request, env);
      if (url.pathname === '/api/stream-action') {
        try {
          const res = await handleStreamAction(request, env, url);
          if (res.status === 200) listCache.at = 0;
          return res;
        } catch (err) {
          console.error('Stream action error:', err && err.stack ? err.stack : err);
          return json({ ok: false, error: 'Something went wrong. Try again, or use the admin panel.' }, 500);
        }
      }
      if (url.pathname === '/api/owner-action') {
        try {
          return await handleOwnerAction(request, env);
        } catch (err) {
          console.error('Owner action error:', err && err.stack ? err.stack : err);
          return json({ ok: false, error: `Database error: ${String((err && err.message) || err).slice(0, 220)}` }, 500);
        }
      }
      if (url.pathname === '/api/admin-action') {
        try {
          const res = await handleAdminAction(request, env, url);
          if (res.status === 200) listCache.at = 0;
          return res;
        } catch (err) {
          console.error('Admin action error:', err && err.stack ? err.stack : err);
          return json({ ok: false, error: `Database error: ${String((err && err.message) || err).slice(0, 220)}` }, 500);
        }
      }
      if (url.pathname.startsWith('/api/')) return json({ ok: false, error: 'Not found.' }, 404);
      return await env.ASSETS.fetch(request);
    } catch (err) {
      console.error('Unhandled error:', err && err.stack ? err.stack : err);
      return json({ ok: false, error: 'Server error.' }, 500);
    }
  }
};
