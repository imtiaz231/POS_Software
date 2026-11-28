import { sign as jwtSign, verify as jwtVerify } from 'hono/jwt';

/* ---------------- Database (Cloudflare D1) ---------------- */
export function makeDb(DB) {
  return {
    get: (sql, ...p) => DB.prepare(sql).bind(...p).first(),
    all: async (sql, ...p) => (await DB.prepare(sql).bind(...p).all()).results,
    run: async (sql, ...p) => {
      const r = await DB.prepare(sql).bind(...p).run();
      return { id: r.meta.last_row_id, changes: r.meta.changes };
    },
    stmt: (sql, ...p) => DB.prepare(sql).bind(...p),   // for batch (atomic, like a transaction)
    batch: (stmts) => DB.batch(stmts),
  };
}

export const defaults = {
  app_name: 'Shop Manager',
  maintenance_mode: '0',
  maintenance_message: 'The software is under maintenance. Please try again in a little while.',
  price_per_month: '15000',
  hbl_title: '', hbl_account: '',
  jazzcash_title: '', jazzcash_number: '',
  support_phone: '',
};

export async function getSettings(db) {
  const o = { ...defaults };
  for (const r of await db.all('SELECT key,value FROM settings')) if (r.key in defaults) o[r.key] = r.value;
  return o;
}
export const log = (db, shopId, actor, action, details = '') =>
  db.run('INSERT INTO activity_logs(shop_id,actor,action,details,created_at) VALUES(?,?,?,?,?)',
    shopId ?? null, actor, action, String(details).slice(0, 500), new Date().toISOString());

export const today = (c) => new Date().toLocaleDateString('en-CA', { timeZone: c.env.TZ || 'Asia/Karachi' });

export async function jsonBody(c) {
  try { const b = await c.req.json(); return b && typeof b === 'object' ? b : {}; } catch { return {}; }
}

/* ---------------- Passwords (PBKDF2 via WebCrypto: fast on Workers) ---------------- */
const enc = new TextEncoder();
const ITER = 100000;
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)));
async function derive(pw, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}
export async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITER}$${hex(salt)}$${hex(await derive(String(pw), salt, ITER))}`;
}
export async function checkPassword(pw, stored) {
  const [alg, it, salt, hash] = String(stored || '').split('$');
  if (alg !== 'pbkdf2' || !salt || !hash) return false;
  const got = hex(await derive(String(pw), unhex(salt), Number(it)));
  if (got.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

/* ---------------- Login tokens ---------------- */
// Uses the JWT_SECRET secret if it is set; otherwise a random secret is created once and kept privately in the D1 database.
let cachedSecret = null;
async function jwtSecret(c) {
  if (c.env.JWT_SECRET && String(c.env.JWT_SECRET).length >= 16) return String(c.env.JWT_SECRET);
  if (cachedSecret) return cachedSecret;
  const db = c.get('db');
  let row = await db.get("SELECT value FROM settings WHERE key='jwt_secret'");
  if (!row) {
    await db.run("INSERT OR IGNORE INTO settings(key,value) VALUES('jwt_secret',?)", hex(crypto.getRandomValues(new Uint8Array(32))));
    row = await db.get("SELECT value FROM settings WHERE key='jwt_secret'");
  }
  return (cachedSecret = row.value);
}
export const signToken = async (c, role, id) =>
  jwtSign({ role, id, exp: Math.floor(Date.now() / 1000) + 12 * 3600 }, await jwtSecret(c), 'HS256');
async function parseToken(c) {
  const h = c.req.header('authorization') || '';
  if (!h.startsWith('Bearer ')) return null;
  try { return await jwtVerify(h.slice(7), await jwtSecret(c), 'HS256'); } catch { return null; }
}

export const hasAccess = (s) => s.status !== 'blocked' && !!s.expires_at && new Date(s.expires_at) > new Date();
export function shopView(s) {
  const access = hasAccess(s);
  return {
    id: s.id, name: s.name, address: s.address, phone: s.phone,
    logo: s.logo ? '/uploads/' + s.logo : null,
    status: s.status, expires_at: s.expires_at, access,
    daysLeft: access ? Math.ceil((new Date(s.expires_at) - Date.now()) / 864e5) : 0,
    must_change: !!s.must_change_password,
    created_at: s.created_at,
  };
}

export async function adminAuth(c, next) {
  const t = await parseToken(c);
  if (!t || t.role !== 'admin') return c.json({ error: 'Admin login required' }, 401);
  const a = await c.get('db').get('SELECT id,username FROM admins WHERE id=?', t.id);
  if (!a) return c.json({ error: 'Invalid session' }, 401);
  c.set('admin', a);
  await next();
}
// Shop login + maintenance + block check (no subscription check)
export async function shopAuth(c, next) {
  const t = await parseToken(c);
  if (!t || t.role !== 'shop') return c.json({ error: 'Login required' }, 401);
  const db = c.get('db');
  const shop = await db.get('SELECT * FROM shops WHERE id=?', t.id);
  if (!shop) return c.json({ error: 'Invalid session' }, 401);
  const s = await getSettings(db);
  if (s.maintenance_mode === '1') return c.json({ maintenance: true, error: s.maintenance_message }, 503);
  if (shop.status === 'blocked') return c.json({ blocked: true, error: 'Your account is blocked. Please contact the administrator.' }, 403);
  c.set('shop', shop);
  await next();
}
// Requires an active subscription
export async function shopActive(c, next) {
  if (!hasAccess(c.get('shop'))) return c.json({ subscription: true, error: 'Your subscription is not active. Please make a payment to get access.' }, 402);
  await next();
}

/* ---------------- Rate limiting (stored in D1) ---------------- */
export async function limited(c, name, max, windowSec) {
  const db = c.get('db');
  const ip = c.req.header('cf-connecting-ip') || 'local';
  const win = Math.floor(Date.now() / (windowSec * 1000));
  const exp = (win + 1) * windowSec;
  const r = await db.get(
    'INSERT INTO rate_limits(key,count,exp) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count',
    `${name}:${ip}:${win}`, exp);
  if (Math.random() < 0.02) await db.run('DELETE FROM rate_limits WHERE exp < ?', Math.floor(Date.now() / 1000));
  return r.count > max;
}

/* ---------------- Images (Cloudflare R2) ---------------- */
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
export const MB = 1024 * 1024;

// Reads JSON or multipart/form-data. Returns { fields, file } (file = the one named `fileField`, if any)
export async function readBody(c, fileField) {
  const ct = c.req.header('content-type') || '';
  if (ct.includes('multipart/form-data')) {
    let fd;
    try { fd = await c.req.formData(); } catch { return { fields: {}, file: null }; }
    const fields = {}; let file = null;
    for (const [k, v] of fd.entries()) {
      if (typeof v === 'string') fields[k] = v;
      else if (k === fileField && v.size > 0) file = v;
    }
    return { fields, file };
  }
  return { fields: await jsonBody(c), file: null };
}

// Checks size, declared type and the real file signature. Returns { error } or { bytes, ext }
export async function checkImage(file, maxBytes, badMsg = 'The file is not a valid image (use PNG, JPG or WEBP)') {
  if (file.size > maxBytes) return { error: 'The image is too large (logo and screenshot: 2 MB, bill photo: 8 MB)' };
  if (!EXT[file.type]) return { error: 'Only PNG, JPG or WEBP images are allowed' };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const jpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b);
  const ascii = (a, b) => String.fromCharCode(...bytes.subarray(a, b));
  const webp = ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
  if (!(jpg || png || webp)) return { error: badMsg };
  return { bytes, ext: EXT[file.type] };
}
/* Photos are kept in R2 when the FILES bucket is connected; otherwise they are stored in the D1 database (table `files`).
   prefix: 'uploads/' (public logos and payment screenshots) or 'bills/' (private) */
const D1_MAX = 1400000;   // D1 allows about 2 MB per row; base64 adds a third
const b64enc = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const b64dec = (str) => Uint8Array.from(atob(str), (ch) => ch.charCodeAt(0));
const safeName = (n) => String(n).replace(/[^a-z0-9.]/gi, '');

export async function saveImage(c, prefix, img) {
  const name = hex(crypto.getRandomValues(new Uint8Array(14))) + img.ext;
  if (c.env.FILES) {
    await c.env.FILES.put(prefix + name, img.bytes, { httpMetadata: { contentType: MIME[img.ext] } });
  } else {
    if (img.bytes.length > D1_MAX) {
      const e = new Error('too big'); e.userMessage = 'The image is too large (maximum about 1.4 MB). Please choose a smaller photo.'; throw e;
    }
    await c.get('db').run('INSERT INTO files(key,type,data) VALUES(?,?,?)', prefix + name, MIME[img.ext], b64enc(img.bytes));
  }
  return name;
}
export const rmImage = async (c, prefix, name) => {
  if (!name) return;
  try {
    if (c.env.FILES) await c.env.FILES.delete(prefix + safeName(name));
    else await c.get('db').run('DELETE FROM files WHERE key=?', prefix + safeName(name));
  } catch {}
};
export async function sendImage(c, prefix, name, cache) {
  const key = prefix + safeName(name);
  const h = new Headers({ 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
  if (c.env.FILES) {
    const obj = await c.env.FILES.get(key);
    if (!obj) return c.json({ error: 'Not found' }, 404);
    obj.writeHttpMetadata(h); h.set('Cache-Control', cache);
    return new Response(obj.body, { headers: h });
  }
  const row = await c.get('db').get('SELECT type, data FROM files WHERE key=?', key);
  if (!row) return c.json({ error: 'Not found' }, 404);
  h.set('Content-Type', row.type);
  return new Response(b64dec(row.data), { headers: h });
}
