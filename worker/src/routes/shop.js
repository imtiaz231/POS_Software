import { Hono } from 'hono';
import {
  getSettings, log, today, shopAuth, shopActive, shopView, hashPassword, checkPassword,
  readBody, checkImage, saveImage, rmImage, sendImage, jsonBody, MB,
} from '../lib.js';

/* ---------- Account router: /api/shop (no active subscription needed) ---------- */
export const account = new Hono();
account.use('*', shopAuth);

account.get('/me', (c) => c.json({ shop: shopView(c.get('shop')) }));

account.put('/me', async (c) => {
  const db = c.get('db'), shop = c.get('shop');
  const { fields, file } = await readBody(c, 'logo');
  const name = String(fields.name || '').trim(), address = String(fields.address || '').trim();
  if (name.length < 2 || address.length < 3) return c.json({ error: 'Shop name and address are required' }, 400);
  let logo = shop.logo;
  if (file) {
    const img = await checkImage(file, 2 * MB);
    if (img.error) return c.json({ error: img.error }, 400);
    const old = logo;
    logo = await saveImage(c, 'uploads/', img);
    await rmImage(c, 'uploads/', old);
  }
  await db.run('UPDATE shops SET name=?,address=?,logo=? WHERE id=?', name, address, logo, shop.id);
  await log(db, shop.id, 'shop', 'profile_update', name);
  return c.json({ shop: shopView(await db.get('SELECT * FROM shops WHERE id=?', shop.id)) });
});

account.post('/password', async (c) => {
  const db = c.get('db'), shop = c.get('shop');
  const { current = '', password = '' } = await jsonBody(c);
  if (!(await checkPassword(String(current), shop.password_hash))) return c.json({ error: 'Current password is incorrect' }, 400);
  if (String(password).length < 6) return c.json({ error: 'New password must be at least 6 characters' }, 400);
  await db.run('UPDATE shops SET password_hash=?, must_change_password=0 WHERE id=?', await hashPassword(String(password)), shop.id);
  await log(db, shop.id, 'shop', 'password_change', '');
  return c.json({ ok: true, shop: shopView(await db.get('SELECT * FROM shops WHERE id=?', shop.id)) });
});

account.get('/payment-info', async (c) => {
  const s = await getSettings(c.get('db'));
  return c.json({
    price_per_month: +s.price_per_month, max_months: 12,
    hbl_title: s.hbl_title, hbl_account: s.hbl_account,
    jazzcash_title: s.jazzcash_title, jazzcash_number: s.jazzcash_number,
    support_phone: s.support_phone,
  });
});

account.get('/payments', async (c) =>
  c.json(await c.get('db').all('SELECT * FROM payments WHERE shop_id=? ORDER BY id DESC LIMIT 100', c.get('shop').id)));

account.post('/payments', async (c) => {
  const db = c.get('db'), shop = c.get('shop');
  const { fields, file } = await readBody(c, 'screenshot');
  const fail = (m) => c.json({ error: m }, 400);
  const { method } = fields;
  const months = Math.floor(Number(fields.months));
  const txn = String(fields.txn_ref || '').trim();
  if (!['HBL', 'JazzCash'].includes(method)) return fail('Select a payment method');
  if (!(months >= 1 && months <= 12)) return fail('Choose between 1 and 12 months');
  if (txn.length < 4) return fail('Enter the transaction ID / reference');
  if (await db.get("SELECT 1 x FROM payments WHERE shop_id=? AND status='pending'", shop.id)) return fail('You already have a payment pending review');
  let img = null;
  if (file) { img = await checkImage(file, 2 * MB); if (img.error) return fail(img.error); }
  const s = await getSettings(db);
  const amount = months * Number(s.price_per_month);
  const shot = img ? await saveImage(c, 'uploads/', img) : null;
  try {
    await db.run('INSERT INTO payments(shop_id,method,months,amount,txn_ref,screenshot,created_at) VALUES(?,?,?,?,?,?,?)',
      shop.id, method, months, amount, txn, shot, new Date().toISOString());
  } catch (e) { await rmImage(c, 'uploads/', shot); throw e; }
  await log(db, shop.id, 'shop', 'payment_submitted', `${method} ${months} month(s) Rs ${amount} ref ${txn}`);
  return c.json({ ok: true });
});

/* ---------- Business router: /api (active subscription required) ---------- */
export const biz = new Hono();
biz.use('*', shopAuth, shopActive);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TYPES = ['hardware', 'electronic'];
const EPS = 0.005;
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const parseItems = (v) => {
  if (!Array.isArray(v) || !v.length || v.length > 100) return null;
  const out = [];
  for (const i of v) {
    const name = String((i && i.name) || '').trim().slice(0, 120);
    const qty = Number(i && i.qty), price = Number(i && i.price);
    if (!name || !(qty > 0) || !Number.isFinite(price) || price < 0) return null;
    out.push({ name, qty, price });
  }
  return out;
};
const sumItems = (its) => Math.round(its.reduce((a, i) => a + i.qty * i.price, 0) * 100) / 100;
const nextSeq = async (db, table, shopId) => (await db.get(`SELECT COALESCE(MAX(seq),0)+1 n FROM ${table} WHERE shop_id=?`, shopId)).n;
const nextLedgerSeq = async (db, shopId, type) => (await db.get('SELECT COALESCE(MAX(seq),0)+1 n FROM ledger_entries WHERE shop_id=? AND type=?', shopId, type)).n;
const billNo = (prefix, seq) => `${prefix}-${String(seq).padStart(4, '0')}`;
const withItems = (rows) => rows.map((x) => ({ ...x, items: JSON.parse(x.items) }));
// Two requests at the same instant could pick the same bill number; the UNIQUE index rejects one, so we just try again.
async function retrySeq(fn) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) { if (i >= 3 || !/UNIQUE/i.test(String(e.message))) throw e; }
  }
}
function dateFilter(q, col, where, params) {
  if (DATE.test(q.from || '')) { where.push(`${col}>=?`); params.push(q.from); }
  if (DATE.test(q.to || '')) { where.push(`${col}<=?`); params.push(q.to); }
}

/* ----- Dealers ----- */
biz.get('/dealers', async (c) => c.json(await c.get('db').all(`SELECT d.*, COUNT(b.id) bills, COALESCE(SUM(b.total),0) total
    FROM dealers d LEFT JOIN purchase_bills b ON b.dealer_id=d.id
    WHERE d.shop_id=? GROUP BY d.id ORDER BY d.name COLLATE NOCASE`, c.get('shop').id)));

function dealerInput(b) {
  const type = b.type, name = String(b.name || '').trim(), company = String(b.company || '').trim(), phone = String(b.phone || '').trim();
  if (!TYPES.includes(type)) return { error: 'Select a dealer type (Hardware / Electronic)' };
  if (!name) return { error: 'Enter the dealer name' };
  if (!company) return { error: 'Enter the company name' };
  if (phone.replace(/\D/g, '').length < 7) return { error: 'Enter the dealer phone number' };
  return { type, name, company, phone };
}
biz.post('/dealers', async (c) => {
  const db = c.get('db'), shop = c.get('shop');
  const d = dealerInput(await jsonBody(c));
  if (d.error) return c.json({ error: d.error }, 400);
  const { id } = await db.run('INSERT INTO dealers(shop_id,type,name,company,phone,created_at) VALUES(?,?,?,?,?,?)',
    shop.id, d.type, d.name, d.company, d.phone, new Date().toISOString());
  await log(db, shop.id, 'shop', 'dealer_add', `${d.name} (${d.company}) ${d.type}`);
  return c.json({ id, ...d });
});
biz.put('/dealers/:id', async (c) => {
  const db = c.get('db'), shop = c.get('shop');
  const d = dealerInput(await jsonBody(c));
  if (d.error) return c.json({ error: d.error }, 400);
  const { changes } = await db.run('UPDATE dealers SET type=?,name=?,company=?,phone=? WHERE id=? AND shop_id=?',
    d.type, d.name, d.company, d.phone, c.req.param('id'), shop.id);
  if (!changes) return c.json({ error: 'Dealer not found' }, 404);
  await log(db, shop.id, 'shop', 'dealer_edit', d.name);
  return c.json({ ok: true });
});
biz.delete('/dealers/:id', async (c) => {
  const db = c.get('db'), shop = c.get('shop'), id = c.req.param('id');
  if (await db.get('SELECT 1 x FROM purchase_bills WHERE dealer_id=? AND shop_id=?', id, shop.id))
    return c.json({ error: 'This dealer has bills on record and cannot be deleted' }, 400);
  const d = await db.get('SELECT name FROM dealers WHERE id=? AND shop_id=?', id, shop.id);
  if (!d) return c.json({ error: 'Dealer not found' }, 404);
  await db.run('DELETE FROM dealers WHERE id=?', id);
  await log(db, shop.id, 'shop', 'dealer_delete', d.name);
  return c.json({ ok: true });
});

/* ----- Purchases ----- */
biz.get('/purchases/next', async (c) =>
  c.json({ bill_no: billNo('PB', await nextSeq(c.get('db'), 'purchase_bills', c.get('shop').id)), date: today(c) }));

biz.get('/purchases', async (c) => {
  const db = c.get('db'), q = c.req.query();
  const where = ['b.shop_id=?'], params = [c.get('shop').id];
  dateFilter(q, 'b.bill_date', where, params);
  if (TYPES.includes(q.dealer_type)) { where.push('d.type=?'); params.push(q.dealer_type); }
  if (q.dealer_id) { where.push('b.dealer_id=?'); params.push(Number(q.dealer_id)); }
  const W = where.join(' AND ');
  const rows = await db.all(`SELECT b.*, d.name dealer_name, d.company dealer_company, d.phone dealer_phone, d.type dealer_type
    FROM purchase_bills b JOIN dealers d ON d.id=b.dealer_id WHERE ${W} ORDER BY b.seq DESC LIMIT 1000`, ...params);
  const totals = await db.get(`SELECT COUNT(*) count, COALESCE(SUM(b.total),0) total,
    COALESCE(SUM(CASE WHEN d.type='hardware' THEN b.total END),0) hardware,
    COALESCE(SUM(CASE WHEN d.type='electronic' THEN b.total END),0) electronic
    FROM purchase_bills b JOIN dealers d ON d.id=b.dealer_id WHERE ${W}`, ...params);
  // the file name stays private; the browser only learns whether a photo exists
  return c.json({ rows: rows.map(({ bill_image, ...x }) => ({ ...x, items: JSON.parse(x.items), has_image: !!bill_image })), totals });
});

// Creates a purchase bill. Accepts JSON, or multipart/form-data with an optional "bill_image" photo of the supplier's paper bill.
biz.post('/purchases', async (c) => {
  const db = c.get('db'), shop = c.get('shop');
  const { fields, file } = await readBody(c, 'bill_image');
  const fail = (m) => c.json({ error: m }, 400);
  let rawItems = fields.items;
  if (typeof rawItems === 'string') { try { rawItems = JSON.parse(rawItems); } catch { rawItems = null; } }   // multipart sends items as text
  const its = parseItems(rawItems);
  if (!its) return fail('Enter a valid name, quantity and price for every item');
  const dealer = await db.get('SELECT * FROM dealers WHERE id=? AND shop_id=?', Number(fields.dealer_id), shop.id);
  if (!dealer) return fail('Select a dealer');
  let img = null;
  if (file) {
    img = await checkImage(file, 8 * MB, 'The bill photo is not a valid image (use PNG, JPG or WEBP)');
    if (img.error) return fail(img.error);
  }
  const total = sumItems(its), date = today(c);
  const photo = img ? await saveImage(c, 'bills/', img) : null;
  let out;
  try {
    out = await retrySeq(async () => {
      const seq = await nextSeq(db, 'purchase_bills', shop.id), no = billNo('PB', seq);
      const { id } = await db.run('INSERT INTO purchase_bills(shop_id,seq,bill_no,dealer_id,bill_date,items,total,bill_image,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        shop.id, seq, no, dealer.id, date, JSON.stringify(its), total, photo, new Date().toISOString());
      return { id, seq, bill_no: no };
    });
  } catch (e) { await rmImage(c, 'bills/', photo); throw e; }
  await log(db, shop.id, 'shop', 'purchase_add', `${out.bill_no} | ${dealer.name} | Rs ${total}${photo ? ' | bill photo attached' : ''}`);
  return c.json({ ...out, bill_date: date, total, has_image: !!photo });
});

// Attach a photo to an existing purchase bill, or replace the current one
biz.post('/purchases/:id/image', async (c) => {
  const db = c.get('db'), shop = c.get('shop');
  const bill = await db.get('SELECT id, bill_no, bill_image FROM purchase_bills WHERE id=? AND shop_id=?', c.req.param('id'), shop.id);
  if (!bill) return c.json({ error: 'Bill not found' }, 404);
  const { file } = await readBody(c, 'bill_image');
  const bad = 'Choose a valid image (PNG, JPG or WEBP)';
  if (!file) return c.json({ error: bad }, 400);
  const img = await checkImage(file, 8 * MB, bad);
  if (img.error) return c.json({ error: img.error }, 400);
  const name = await saveImage(c, 'bills/', img);
  await db.run('UPDATE purchase_bills SET bill_image=? WHERE id=?', name, bill.id);
  await rmImage(c, 'bills/', bill.bill_image);                // remove the replaced file
  await log(db, shop.id, 'shop', 'purchase_image', `${bill.bill_no}${bill.bill_image ? ' (replaced)' : ''}`);
  return c.json({ ok: true, has_image: true });
});

// Bill photos are private: only the shop that owns the bill can download them
biz.get('/purchases/:id/image', async (c) => {
  const bill = await c.get('db').get('SELECT bill_image FROM purchase_bills WHERE id=? AND shop_id=?', c.req.param('id'), c.get('shop').id);
  if (!bill || !bill.bill_image) return c.json({ error: 'No photo is attached to this bill' }, 404);
  return sendImage(c, 'bills/', bill.bill_image, 'private, max-age=3600');
});

/* ----- Sales ----- */
biz.get('/sales/next', async (c) =>
  c.json({ bill_no: billNo('SB', await nextSeq(c.get('db'), 'sale_bills', c.get('shop').id)), date: today(c) }));

biz.get('/sales', async (c) => {
  const db = c.get('db'), q = c.req.query();
  const where = ['shop_id=?', 'voided=0'], params = [c.get('shop').id];
  dateFilter(q, 'bill_date', where, params);
  if (TYPES.includes(q.category)) { where.push('category=?'); params.push(q.category); }
  const W = where.join(' AND ');
  const rows = await db.all(`SELECT * FROM sale_bills WHERE ${W} ORDER BY seq DESC LIMIT 1000`, ...params);
  const totals = await db.get(`SELECT COUNT(*) count, COALESCE(SUM(total),0) total, COALESCE(SUM(profit),0) profit,
    COALESCE(SUM(CASE WHEN category='hardware' THEN total END),0) hardware,
    COALESCE(SUM(CASE WHEN category='electronic' THEN total END),0) electronic
    FROM sale_bills WHERE ${W}`, ...params);
  return c.json({ rows: withItems(rows), totals });
});

biz.post('/sales', async (c) => {
  const db = c.get('db'), shop = c.get('shop'), body = await jsonBody(c);
  const its = parseItems(body.items);
  if (!its) return c.json({ error: 'Enter a valid name, quantity and price for every item' }, 400);
  if (!TYPES.includes(body.category)) return c.json({ error: 'Select Hardware or Electronic' }, 400);
  const profit = body.profit === '' || body.profit == null ? 0 : Number(body.profit);
  if (!Number.isFinite(profit)) return c.json({ error: 'Enter profit as a valid number' }, 400);
  const total = sumItems(its), date = today(c);
  const out = await retrySeq(async () => {
    const seq = await nextSeq(db, 'sale_bills', shop.id), no = billNo('SB', seq);
    const { id } = await db.run('INSERT INTO sale_bills(shop_id,seq,bill_no,bill_date,category,items,total,profit,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      shop.id, seq, no, date, body.category, JSON.stringify(its), total, profit, new Date().toISOString());
    return { id, seq, bill_no: no };
  });
  await log(db, shop.id, 'shop', 'sale_add', `${out.bill_no} | ${body.category} | Rs ${total} | profit ${profit}`);
  return c.json({ ...out, bill_date: date, total, profit });
});

/* ----- Customers and credit ledger (udhaar / khata) ----- */
function custPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('92') && d.length === 12) d = '0' + d.slice(2);
  return d;
}
// Amount the customer still owes (credits minus payments, ignoring voided entries)
const balanceOf = async (db, shopId, customerId) => r2((await db.get(
  "SELECT COALESCE(SUM(CASE type WHEN 'credit' THEN amount ELSE -amount END),0) b FROM ledger_entries WHERE shop_id=? AND customer_id=? AND voided=0",
  shopId, customerId)).b);
const findCustomer = (c) => c.get('db').get('SELECT * FROM customers WHERE id=? AND shop_id=?', c.req.param('id'), c.get('shop').id);

const LEDGER_SQL = (saleRef) => `INSERT INTO ledger_entries(shop_id,customer_id,type,seq,ref_no,entry_date,items,note,amount,sale_bill_id,created_at)
  VALUES(?,?,?,?,?,?,?,?,?,${saleRef},?)`;
const refNo = (type, seq) => `${type === 'credit' ? 'CR' : 'PY'}-${String(seq).padStart(4, '0')}`;

function customerInput(b) {
  const name = String(b.name || '').trim(), phone = custPhone(b.phone), address = String(b.address || '').trim().slice(0, 150);
  if (name.length < 2) return { error: 'Enter the customer name' };
  if (phone.length < 7 || phone.length > 15) return { error: 'Enter a valid customer phone number' };
  return { name, phone, address };
}
const DUPLICATE = 'A customer with this phone number already exists';

biz.get('/customers', async (c) => {
  const db = c.get('db'), sid = c.get('shop').id;
  const q = String(c.req.query('q') || '').trim(), due = c.req.query('due') === '1';
  const where = ['c.shop_id=?'], params = [sid];
  if (q) { where.push('(c.name LIKE ? OR c.phone LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const rows = await db.all(`SELECT c.id, c.name, c.phone, c.address,
      ROUND(COALESCE(SUM(CASE WHEN e.voided=0 THEN CASE e.type WHEN 'credit' THEN e.amount ELSE -e.amount END END),0),2) balance,
      MAX(CASE WHEN e.voided=0 THEN e.entry_date END) last_activity
    FROM customers c LEFT JOIN ledger_entries e ON e.customer_id=c.id
    WHERE ${where.join(' AND ')} GROUP BY c.id ${due ? 'HAVING balance > 0.005' : ''}
    ORDER BY ${due ? 'balance DESC' : 'c.name COLLATE NOCASE'} LIMIT 500`, ...params);
  const sum = await db.get(`SELECT COALESCE(SUM(b),0) outstanding, COUNT(*) due_customers FROM (
      SELECT SUM(CASE type WHEN 'credit' THEN amount ELSE -amount END) b FROM ledger_entries
      WHERE shop_id=? AND voided=0 GROUP BY customer_id HAVING b > 0.005)`, sid);
  const total = (await db.get('SELECT COUNT(*) n FROM customers WHERE shop_id=?', sid)).n;
  return c.json({ rows, summary: { outstanding: r2(sum.outstanding), due_customers: sum.due_customers, customers: total } });
});

biz.post('/customers', async (c) => {
  const db = c.get('db'), shop = c.get('shop');
  const cu = customerInput(await jsonBody(c));
  if (cu.error) return c.json({ error: cu.error }, 400);
  try {
    const { id } = await db.run('INSERT INTO customers(shop_id,name,phone,address,created_at) VALUES(?,?,?,?,?)',
      shop.id, cu.name, cu.phone, cu.address, new Date().toISOString());
    await log(db, shop.id, 'shop', 'customer_add', `${cu.name} ${cu.phone}`);
    return c.json({ id, ...cu });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return c.json({ error: DUPLICATE }, 400);
    throw e;
  }
});

biz.put('/customers/:id', async (c) => {
  const db = c.get('db'), shop = c.get('shop');
  const cu = customerInput(await jsonBody(c));
  if (cu.error) return c.json({ error: cu.error }, 400);
  try {
    const { changes } = await db.run('UPDATE customers SET name=?, phone=?, address=? WHERE id=? AND shop_id=?', cu.name, cu.phone, cu.address, c.req.param('id'), shop.id);
    if (!changes) return c.json({ error: 'Customer not found' }, 404);
    await log(db, shop.id, 'shop', 'customer_edit', cu.name);
    return c.json({ ok: true });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return c.json({ error: DUPLICATE }, 400);
    throw e;
  }
});

biz.delete('/customers/:id', async (c) => {
  const db = c.get('db'), shop = c.get('shop');
  const cu = await findCustomer(c);
  if (!cu) return c.json({ error: 'Customer not found' }, 404);
  if (await db.get('SELECT 1 x FROM ledger_entries WHERE customer_id=?', cu.id))
    return c.json({ error: 'This customer has ledger history and cannot be deleted' }, 400);
  await db.run('DELETE FROM customers WHERE id=?', cu.id);
  await log(db, shop.id, 'shop', 'customer_delete', cu.name);
  return c.json({ ok: true });
});

// Full account statement (oldest first) with a running balance
biz.get('/customers/:id', async (c) => {
  const db = c.get('db'), shop = c.get('shop');
  const cu = await findCustomer(c);
  if (!cu) return c.json({ error: 'Customer not found' }, 404);
  const entries = await db.all(`SELECT e.*, s.bill_no sale_bill_no FROM ledger_entries e
    LEFT JOIN sale_bills s ON s.id=e.sale_bill_id WHERE e.customer_id=? AND e.shop_id=? ORDER BY e.id`, cu.id, shop.id);
  let run = 0, credit = 0, paid = 0;
  const out = entries.map((e) => {
    if (!e.voided) {
      run = r2(run + (e.type === 'credit' ? e.amount : -e.amount));
      if (e.type === 'credit') credit += e.amount; else paid += e.amount;
    }
    return { ...e, items: e.items ? JSON.parse(e.items) : null, running_balance: run };
  });
  return c.json({
    customer: { id: cu.id, name: cu.name, phone: cu.phone, address: cu.address, created_at: cu.created_at },
    balance: run, total_credit: r2(credit), total_paid: r2(paid), entries: out,
  });
});

// Customer takes goods on credit. Optionally: part-payment now, and also record it as a sale bill.
biz.post('/customers/:id/credit', async (c) => {
  const db = c.get('db'), shop = c.get('shop'), body = await jsonBody(c);
  const cu = await findCustomer(c);
  if (!cu) return c.json({ error: 'Customer not found' }, 404);
  const its = parseItems(body.items);
  if (!its) return c.json({ error: 'Enter a valid name, quantity and price for every item' }, 400);
  const total = sumItems(its);
  const paidNow = body.paid_now === '' || body.paid_now == null ? 0 : r2(body.paid_now);
  if (!Number.isFinite(paidNow) || paidNow < 0 || paidNow > total + EPS)
    return c.json({ error: 'The amount paid now must be between 0 and the bill total' }, 400);
  const recordSale = !!body.record_sale;
  let category = null, profit = 0;
  if (recordSale) {
    category = body.category;
    if (!TYPES.includes(category)) return c.json({ error: 'Select Hardware or Electronic' }, 400);
    profit = body.profit === '' || body.profit == null ? 0 : Number(body.profit);
    if (!Number.isFinite(profit)) return c.json({ error: 'Enter profit as a valid number' }, 400);
  }
  const note = String(body.note || '').trim().slice(0, 200);
  const date = today(c), now = new Date().toISOString();

  // All rows are written in ONE atomic batch: either everything is saved or nothing.
  const out = await retrySeq(async () => {
    const stmts = [];
    let saleSeq = null, saleNo = null;
    if (recordSale) {
      saleSeq = await nextSeq(db, 'sale_bills', shop.id);
      saleNo = billNo('SB', saleSeq);
      stmts.push(db.stmt('INSERT INTO sale_bills(shop_id,seq,bill_no,bill_date,category,items,total,profit,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        shop.id, saleSeq, saleNo, date, category, JSON.stringify(its), total, profit, now));
    }
    const crSeq = await nextLedgerSeq(db, shop.id, 'credit'), crRef = refNo('credit', crSeq);
    const saleRef = recordSale ? '(SELECT id FROM sale_bills WHERE shop_id=? AND seq=?)' : 'NULL';
    const crParams = [shop.id, cu.id, 'credit', crSeq, crRef, date, JSON.stringify(its), note, total];
    if (recordSale) crParams.push(shop.id, saleSeq);
    crParams.push(now);
    stmts.push(db.stmt(LEDGER_SQL(saleRef), ...crParams));
    let payment = null;
    if (paidNow > 0) {
      const pySeq = await nextLedgerSeq(db, shop.id, 'payment'), pyRef = refNo('payment', pySeq);
      stmts.push(db.stmt(LEDGER_SQL('NULL'), shop.id, cu.id, 'payment', pySeq, pyRef, date, null, 'Paid at the time of purchase', paidNow, now));
      payment = { ref_no: pyRef };
    }
    const res = await db.batch(stmts);
    const crIdx = recordSale ? 1 : 0;
    return {
      credit: { id: res[crIdx].meta.last_row_id, ref_no: crRef },
      payment: payment && { id: res[crIdx + 1].meta.last_row_id, ...payment },
      sale_bill_no: saleNo,
    };
  });
  await log(db, shop.id, 'shop', 'credit_add', `${cu.name} | ${out.credit.ref_no} | Rs ${total}${paidNow ? ' | paid now Rs ' + paidNow : ''}`);
  return c.json({ ...out, total, balance: await balanceOf(db, shop.id, cu.id) });
});

// Customer pays (part or all of) what they owe. The balance can never go below zero.
biz.post('/customers/:id/payment', async (c) => {
  const db = c.get('db'), shop = c.get('shop'), body = await jsonBody(c);
  const cu = await findCustomer(c);
  if (!cu) return c.json({ error: 'Customer not found' }, 404);
  const amount = r2(body.amount);
  if (!(amount > 0)) return c.json({ error: 'Enter a payment amount greater than zero' }, 400);
  const bal = await balanceOf(db, shop.id, cu.id);
  if (amount > bal + EPS) return c.json({ error: `This payment (Rs ${amount}) is more than the balance due (Rs ${bal})` }, 400);
  const note = String(body.note || '').trim().slice(0, 200);
  const e = await retrySeq(async () => {
    const seq = await nextLedgerSeq(db, shop.id, 'payment'), ref = refNo('payment', seq);
    const { id } = await db.run(LEDGER_SQL('NULL'), shop.id, cu.id, 'payment', seq, ref, today(c), null, note, amount, new Date().toISOString());
    return { id, ref_no: ref };
  });
  await log(db, shop.id, 'shop', 'payment_add', `${cu.name} | ${e.ref_no} | Rs ${amount}`);
  return c.json({ ...e, balance: r2(bal - amount) });
});

// Entries are never deleted. A mistake is voided with a reason and stays visible in the statement.
biz.post('/ledger/:id/void', async (c) => {
  const db = c.get('db'), shop = c.get('shop'), body = await jsonBody(c);
  const e = await db.get('SELECT * FROM ledger_entries WHERE id=? AND shop_id=?', c.req.param('id'), shop.id);
  if (!e) return c.json({ error: 'Entry not found' }, 404);
  if (e.voided) return c.json({ error: 'This entry is already voided' }, 400);
  const reason = String(body.reason || '').trim().slice(0, 200);
  if (reason.length < 3) return c.json({ error: 'Enter a reason (at least 3 characters)' }, 400);
  if (e.type === 'credit' && (await balanceOf(db, shop.id, e.customer_id)) - e.amount < -EPS)
    return c.json({ error: 'Cannot void this credit because the payments received would exceed what is left. Void the related payment first.' }, 400);
  const stmts = [db.stmt('UPDATE ledger_entries SET voided=1, void_reason=? WHERE id=?', reason, e.id)];
  if (e.sale_bill_id) stmts.push(db.stmt('UPDATE sale_bills SET voided=1 WHERE id=?', e.sale_bill_id)); // cancel the linked sale too
  await db.batch(stmts);
  await log(db, shop.id, 'shop', 'entry_void', `${e.ref_no} | ${reason}`);
  return c.json({ ok: true, balance: await balanceOf(db, shop.id, e.customer_id) });
});

/* ----- Summary & reports ----- */
biz.get('/summary', async (c) => {
  const db = c.get('db'), sid = c.get('shop').id, t = today(c), month = t.slice(0, 7) + '-01';
  const P = (from) => db.get('SELECT COUNT(*) count, COALESCE(SUM(total),0) total FROM purchase_bills WHERE shop_id=? AND bill_date>=?', sid, from);
  const S = (from) => db.get('SELECT COUNT(*) count, COALESCE(SUM(total),0) total, COALESCE(SUM(profit),0) profit FROM sale_bills WHERE shop_id=? AND voided=0 AND bill_date>=?', sid, from);
  const [pt, st, pm, sm, pa, sa, receivable] = await Promise.all([
    P(t), S(t), P(month), S(month), P('0000-00-00'), S('0000-00-00'),
    db.get(`SELECT COALESCE(SUM(b),0) total, COUNT(*) customers FROM (
      SELECT SUM(CASE type WHEN 'credit' THEN amount ELSE -amount END) b FROM ledger_entries
      WHERE shop_id=? AND voided=0 GROUP BY customer_id HAVING b > 0.005)`, sid),
  ]);
  return c.json({ today: { purchases: pt, sales: st }, month: { purchases: pm, sales: sm }, all: { purchases: pa, sales: sa }, receivable });
});

biz.get('/reports/daily', async (c) => {
  const db = c.get('db'), sid = c.get('shop').id, q = c.req.query();
  const d = new Date(); d.setDate(d.getDate() - 30);
  const from = DATE.test(q.from || '') ? q.from : d.toLocaleDateString('en-CA', { timeZone: c.env.TZ || 'Asia/Karachi' });
  const to = DATE.test(q.to || '') ? q.to : today(c);
  const sales = await db.all('SELECT bill_date date, COUNT(*) sale_count, SUM(total) sales, SUM(profit) profit FROM sale_bills WHERE shop_id=? AND voided=0 AND bill_date BETWEEN ? AND ? GROUP BY bill_date', sid, from, to);
  const purch = await db.all('SELECT bill_date date, COUNT(*) purchase_count, SUM(total) purchases FROM purchase_bills WHERE shop_id=? AND bill_date BETWEEN ? AND ? GROUP BY bill_date', sid, from, to);
  const m = {};
  for (const s of sales) m[s.date] = { date: s.date, sale_count: s.sale_count, sales: s.sales, profit: s.profit, purchase_count: 0, purchases: 0 };
  for (const p of purch) m[p.date] = { date: p.date, sale_count: 0, sales: 0, profit: 0, ...(m[p.date] || {}), purchase_count: p.purchase_count, purchases: p.purchases };
  return c.json(Object.values(m).sort((a, b) => b.date.localeCompare(a.date)));
});

biz.get('/activity', async (c) =>
  c.json(await c.get('db').all('SELECT id,action,details,created_at FROM activity_logs WHERE shop_id=? ORDER BY id DESC LIMIT 300', c.get('shop').id)));
