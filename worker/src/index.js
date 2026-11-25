import { Hono } from 'hono';
import { makeDb, getSettings, sendImage } from './lib.js';
import auth from './routes/auth.js';
import { account, biz } from './routes/shop.js';
import admin from './routes/admin.js';

const app = new Hono();

app.use('*', async (c, next) => {
  c.set('db', makeDb(c.env.DB));
  await next();
});
app.use('/api/*', async (c, next) => {
  if (!c.env.JWT_SECRET || c.env.JWT_SECRET === 'c09991e587d39d7e8443a0a21f10fae82b5009b352303e1198e0bae7f1d1a897574b3e31be253454769683142581fcfef23316409b288b45ce03a0e870fe96f7')
    return c.json({ error: 'Server is not configured: set the JWT_SECRET secret.' }, 500);
  await next();
});

app.get('/api/health', (c) => c.json({ ok: true }));
app.get('/api/public/status', async (c) => {
  const s = await getSettings(c.get('db'));
  return c.json({ app_name: s.app_name, maintenance: s.maintenance_mode === '1', message: s.maintenance_message });
});

app.route('/api/auth', auth);
app.route('/api/shop', account);
app.route('/api/admin', admin);
app.route('/api', biz); // must be last (shopAuth + active subscription)

// Public images (shop logos, payment screenshots). Private bill photos use /api/purchases/:id/image
app.get('/uploads/:name', (c) => sendImage(c, 'uploads/', c.req.param('name'), 'public, max-age=604800'));

app.notFound((c) => c.req.path.startsWith('/api/') ? c.json({ error: 'Not found' }, 404) : c.env.ASSETS.fetch(c.req.raw));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Server error' }, 500);
});

export default app;
