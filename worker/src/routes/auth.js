import { Hono } from 'hono';
import {
  getSettings, log, signToken, shopView, hashPassword, checkPassword, limited,
  readBody, checkImage, saveImage, rmImage, jsonBody, MB,
} from '../lib.js';

const r = new Hono();

function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('92') && d.length === 12) d = '0' + d.slice(2);
  return d;
}
const validPhone = (d) => d.length >= 10 && d.length <= 13;

r.use('*', async (c, next) => {
  if (await limited(c, 'auth', 80, 15 * 60)) return c.json({ error: 'Too many requests. Please try again later.' }, 429);
  await next();
});

let seeded = false;
async function seedAdmin(c) {
  if (seeded) return;
  const db = c.get('db');
  if (!(await db.get('SELECT 1 x FROM admins LIMIT 1'))) {
    const pw = c.env.ADMIN_PASSWORD;
    if (!pw) return;
    await db.run('INSERT OR IGNORE INTO admins(username,password_hash) VALUES(?,?)', c.env.ADMIN_USERNAME || 'admin', await hashPassword(pw));
  }
  seeded = true;
}

r.post('/register', async (c) => {
  const db = c.get('db');
  const { fields, file } = await readBody(c, 'logo');
  const fail = (m) => c.json({ error: m }, 400);
  const name = String(fields.name || '').trim();
  const address = String(fields.address || '').trim();
  const phone = normPhone(fields.phone);
  const password = String(fields.password || '');
  if (name.length < 2) return fail('Enter the shop name');
  if (address.length < 3) return fail('Enter the shop address');
  if (!validPhone(phone)) return fail('Enter a valid phone number (e.g. 03001234567)');
  if (password.length < 6) return fail('Password must be at least 6 characters');
  let img = null;
  if (file) { img = await checkImage(file, 2 * MB); if (img.error) return fail(img.error); }
  if (await db.get('SELECT 1 x FROM shops WHERE phone=?', phone)) return fail('This phone number is already registered');
  const logo = img ? await saveImage(c, 'uploads/', img) : null;
  let id;
  try {
    id = (await db.run('INSERT INTO shops(name,address,phone,password_hash,logo,created_at) VALUES(?,?,?,?,?,?)',
      name, address, phone, await hashPassword(password), logo, new Date().toISOString())).id;
  } catch (e) {
    await rmImage(c, 'uploads/', logo);
    if (String(e.message).includes('UNIQUE')) return fail('This phone number is already registered');
    throw e;
  }
  await log(db, id, 'shop', 'register', name);
  const shop = await db.get('SELECT * FROM shops WHERE id=?', id);
  return c.json({ token: await signToken(c, 'shop', id), role: 'shop', shop: shopView(shop) });
});

r.post('/login', async (c) => {
  const db = c.get('db');
  await seedAdmin(c);
  const body = await jsonBody(c);
  const identifier = String(body.identifier || '').trim();
  const password = String(body.password || '');
  const bad = () => c.json({ error: 'Incorrect phone/username or password' }, 401);

  const admin = await db.get('SELECT * FROM admins WHERE username=?', identifier);
  if (admin) {
    if (!(await checkPassword(password, admin.password_hash))) return bad();
    return c.json({ token: await signToken(c, 'admin', admin.id), role: 'admin', admin: { username: admin.username } });
  }
  const shop = await db.get('SELECT * FROM shops WHERE phone=?', normPhone(identifier));
  if (!shop || !(await checkPassword(password, shop.password_hash))) return bad();
  const s = await getSettings(db);
  if (s.maintenance_mode === '1') return c.json({ maintenance: true, error: s.maintenance_message }, 503);
  if (shop.status === 'blocked') return c.json({ error: 'Your account is blocked. Please contact the administrator.' }, 403);
  await log(db, shop.id, 'shop', 'login', '');
  return c.json({ token: await signToken(c, 'shop', shop.id), role: 'shop', shop: shopView(shop) });
});

// Public: a shop that forgot its password asks the admin for a reset.
// The response is identical whether or not the phone number exists (no account enumeration).
r.post('/forgot-password', async (c) => {
  const db = c.get('db');
  if (await limited(c, 'forgot', 10, 3600)) return c.json({ error: 'Too many requests. Please try again later.' }, 429);
  const body = await jsonBody(c);
  const phone = normPhone(body.phone);
  const note = String(body.note || '').trim().slice(0, 200);
  if (!validPhone(phone)) return c.json({ error: 'Enter a valid phone number (e.g. 03001234567)' }, 400);
  const shop = await db.get('SELECT id FROM shops WHERE phone=?', phone);
  if (shop && !(await db.get("SELECT 1 x FROM password_requests WHERE shop_id=? AND status='pending'", shop.id))) {
    await db.run('INSERT INTO password_requests(shop_id,note,created_at) VALUES(?,?,?)', shop.id, note, new Date().toISOString());
    await log(db, shop.id, 'shop', 'password_request', note);
  }
  return c.json({ ok: true, message: 'If this phone number is registered, the administrator has been notified and will contact you with a new password.' });
});

export default r;
