import { Hono } from 'hono';
import { defaults, getSettings, log, adminAuth, shopView, hashPassword, checkPassword, jsonBody } from '../lib.js';

const r = new Hono();
r.use('*', adminAuth);

// Adds calendar months (Jan 31 + 1 month = Feb 28/29, never spills into March)
function addMonths(date, n) {
  const d = new Date(date), day = d.getDate();
  d.setMonth(d.getMonth() + n);
  if (d.getDate() !== day) d.setDate(0);
  return d;
}
// Works out the new expiry: extends from the current expiry if the shop is still active, otherwise from today
function newExpiry(shop, { months = 0, days = 0 }) {
  let base = shop.expires_at && new Date(shop.expires_at) > new Date() ? new Date(shop.expires_at) : new Date();
  if (months) base = addMonths(base, months);
  if (days) base.setDate(base.getDate() + days);
  return base.toISOString();
}
// Sets a temporary password, forces a change at next login, and closes open requests (atomic batch)
async function setTempPassword(db, shopId, password) {
  await db.batch([
    db.stmt('UPDATE shops SET password_hash=?, must_change_password=1 WHERE id=?', await hashPassword(password), shopId),
    db.stmt("UPDATE password_requests SET status='done', resolved_at=? WHERE shop_id=? AND status='pending'", new Date().toISOString(), shopId),
  ]);
  await log(db, shopId, 'admin', 'password_reset', 'Temporary password set by admin');
}

r.get('/me', (c) => c.json(c.get('admin')));

r.get('/stats', async (c) => {
  const db = c.get('db');
  const shops = await db.all('SELECT status, expires_at FROM shops'), now = Date.now();
  const st = { total: shops.length, active: 0, expired: 0, never_paid: 0, blocked: 0, expiring_soon: 0 };
  for (const s of shops) {
    if (s.status === 'blocked') st.blocked++;
    else if (!s.expires_at) st.never_paid++;
    else if (new Date(s.expires_at) > now) { st.active++; if (new Date(s.expires_at) - now < 7 * 864e5) st.expiring_soon++; }
    else st.expired++;
  }
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  return c.json({
    ...st,
    password_requests: (await db.get("SELECT COUNT(*) c FROM password_requests WHERE status='pending'")).c,
    pending_payments: (await db.get("SELECT COUNT(*) c FROM payments WHERE status='pending'")).c,
    revenue_total: (await db.get("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status='approved'")).s,
    revenue_month: (await db.get("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status='approved' AND reviewed_at>=?", monthStart.toISOString())).s,
    maintenance: (await getSettings(db)).maintenance_mode === '1',
  });
});

r.get('/shops', async (c) => {
  const q = `%${String(c.req.query('q') || '').trim()}%`;
  const rows = await c.get('db').all(`SELECT s.*,
    (SELECT COUNT(*) FROM sale_bills WHERE shop_id=s.id) sales_count,
    (SELECT COUNT(*) FROM purchase_bills WHERE shop_id=s.id) purchase_count
    FROM shops s WHERE s.name LIKE ? OR s.phone LIKE ? ORDER BY s.id DESC LIMIT 500`, q, q);
  return c.json(rows.map((s) => ({ ...shopView(s), sales_count: s.sales_count, purchase_count: s.purchase_count })));
});

r.post('/shops/:id/grant', async (c) => {
  const db = c.get('db'), id = c.req.param('id'), body = await jsonBody(c);
  const months = Math.floor(Number(body.months)) || 0, days = Math.floor(Number(body.days)) || 0;
  if (months ? !(months >= 1 && months <= 60) : !(days >= 1 && days <= 3650))
    return c.json({ error: months ? 'Months must be between 1 and 60' : 'Days must be between 1 and 3650' }, 400);
  const shop = await db.get('SELECT * FROM shops WHERE id=?', id);
  if (!shop) return c.json({ error: 'Shop not found' }, 404);
  const until = newExpiry(shop, months ? { months } : { days });
  await db.run('UPDATE shops SET expires_at=? WHERE id=?', until, id);
  await log(db, id, 'admin', 'access_granted', `${months ? months + ' month(s)' : days + ' day(s)'}, expires ${until.slice(0, 10)}`);
  return c.json({ expires_at: until });
});

r.post('/shops/:id/revoke', async (c) => {
  const db = c.get('db'), id = c.req.param('id');
  await db.run('UPDATE shops SET expires_at=? WHERE id=?', new Date().toISOString(), id);
  await log(db, id, 'admin', 'access_revoked', '');
  return c.json({ ok: true });
});

r.post('/shops/:id/status', async (c) => {
  const db = c.get('db'), id = c.req.param('id'), { status } = await jsonBody(c);
  if (!['active', 'blocked'].includes(status)) return c.json({ error: 'Invalid status' }, 400);
  await db.run('UPDATE shops SET status=? WHERE id=?', status, id);
  await log(db, id, 'admin', status === 'blocked' ? 'shop_blocked' : 'shop_unblocked', '');
  return c.json({ ok: true });
});

r.post('/shops/:id/reset-password', async (c) => {
  const db = c.get('db'), id = c.req.param('id');
  const pw = String((await jsonBody(c)).password || '');
  if (pw.length < 6) return c.json({ error: 'Password must be at least 6 characters' }, 400);
  if (!(await db.get('SELECT 1 x FROM shops WHERE id=?', id))) return c.json({ error: 'Shop not found' }, 404);
  await setTempPassword(db, id, pw);
  return c.json({ ok: true });
});

r.get('/payments', async (c) => {
  const q = c.req.query('status');
  const st = ['pending', 'approved', 'rejected'].includes(q) ? q : null;
  return c.json(await c.get('db').all(`SELECT p.*, s.name shop_name, s.phone shop_phone FROM payments p JOIN shops s ON s.id=p.shop_id
    ${st ? 'WHERE p.status=?' : ''} ORDER BY p.id DESC LIMIT 300`, ...(st ? [st] : [])));
});

r.post('/payments/:id/approve', async (c) => {
  const db = c.get('db');
  const p = await db.get('SELECT * FROM payments WHERE id=?', c.req.param('id'));
  if (!p || p.status !== 'pending') return c.json({ error: 'Payment is not pending' }, 400);
  const shop = await db.get('SELECT * FROM shops WHERE id=?', p.shop_id);
  await db.batch([
    db.stmt("UPDATE payments SET status='approved', reviewed_at=? WHERE id=?", new Date().toISOString(), p.id),
    db.stmt('UPDATE shops SET expires_at=? WHERE id=?', newExpiry(shop, { months: p.months }), p.shop_id),
  ]);
  await log(db, p.shop_id, 'admin', 'payment_approved', `${p.method} Rs ${p.amount} (${p.months} month(s))`);
  return c.json({ ok: true });
});

r.post('/payments/:id/reject', async (c) => {
  const db = c.get('db');
  const p = await db.get('SELECT * FROM payments WHERE id=?', c.req.param('id'));
  if (!p || p.status !== 'pending') return c.json({ error: 'Payment is not pending' }, 400);
  const note = String((await jsonBody(c)).note || '').slice(0, 200);
  await db.run("UPDATE payments SET status='rejected', note=?, reviewed_at=? WHERE id=?", note, new Date().toISOString(), p.id);
  await log(db, p.shop_id, 'admin', 'payment_rejected', note);
  return c.json({ ok: true });
});

r.get('/password-requests', async (c) => {
  const q = c.req.query('status');
  const st = ['pending', 'done', 'dismissed'].includes(q) ? q : null;
  return c.json(await c.get('db').all(`SELECT q.*, s.name shop_name, s.phone shop_phone FROM password_requests q JOIN shops s ON s.id=q.shop_id
    ${st ? 'WHERE q.status=?' : ''} ORDER BY q.id DESC LIMIT 300`, ...(st ? [st] : [])));
});
r.post('/password-requests/:id/resolve', async (c) => {
  const db = c.get('db');
  const q = await db.get('SELECT * FROM password_requests WHERE id=?', c.req.param('id'));
  if (!q || q.status !== 'pending') return c.json({ error: 'Request is not pending' }, 400);
  const pw = String((await jsonBody(c)).password || '');
  if (pw.length < 6) return c.json({ error: 'Password must be at least 6 characters' }, 400);
  await setTempPassword(db, q.shop_id, pw);
  return c.json({ ok: true });
});
r.post('/password-requests/:id/dismiss', async (c) => {
  const db = c.get('db');
  const q = await db.get('SELECT * FROM password_requests WHERE id=?', c.req.param('id'));
  if (!q || q.status !== 'pending') return c.json({ error: 'Request is not pending' }, 400);
  await db.run("UPDATE password_requests SET status='dismissed', resolved_at=? WHERE id=?", new Date().toISOString(), q.id);
  return c.json({ ok: true });
});

r.get('/settings', async (c) => c.json(await getSettings(c.get('db'))));
r.put('/settings', async (c) => {
  const db = c.get('db'), body = await jsonBody(c);
  const before = await getSettings(db);
  const stmts = [];
  for (const k of Object.keys(defaults)) {
    if (body[k] === undefined) continue;
    let v = String(body[k]).slice(0, 500);
    if (k.startsWith('price_')) v = String(Math.max(0, Math.floor(Number(v)) || 0));
    if (k === 'maintenance_mode') v = v === '1' ? '1' : '0';
    stmts.push(db.stmt('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, v));
  }
  if (stmts.length) await db.batch(stmts);
  if (body.maintenance_mode !== undefined && String(body.maintenance_mode) !== before.maintenance_mode)
    await log(db, null, 'admin', body.maintenance_mode === '1' ? 'maintenance_on' : 'maintenance_off', '');
  return c.json(await getSettings(db));
});

r.post('/password', async (c) => {
  const db = c.get('db'), body = await jsonBody(c);
  const a = await db.get('SELECT * FROM admins WHERE id=?', c.get('admin').id);
  if (!(await checkPassword(String(body.current || ''), a.password_hash))) return c.json({ error: 'Current password is incorrect' }, 400);
  if (String(body.password || '').length < 8) return c.json({ error: 'New password must be at least 8 characters' }, 400);
  await db.run('UPDATE admins SET password_hash=? WHERE id=?', await hashPassword(String(body.password)), a.id);
  return c.json({ ok: true });
});

r.get('/activity', async (c) => {
  const sid = Number(c.req.query('shop_id')) || null;
  return c.json(await c.get('db').all(`SELECT a.*, s.name shop_name FROM activity_logs a LEFT JOIN shops s ON s.id=a.shop_id
    ${sid ? 'WHERE a.shop_id=?' : ''} ORDER BY a.id DESC LIMIT 500`, ...(sid ? [sid] : [])));
});

export default r;
