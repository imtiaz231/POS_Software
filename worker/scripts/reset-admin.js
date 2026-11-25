// Usage: npm run reset-admin -- <username> <newPassword>
// Creates the admin, or changes its password, in the LIVE Cloudflare D1 database.
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const [u, p] = process.argv.slice(2);
if (!u || !p || p.length < 8) { console.log('Usage: npm run reset-admin -- <username> <password (8+ chars)>'); process.exit(1); }
if (!/^[A-Za-z0-9_.-]+$/.test(u)) { console.log('Username may only contain letters, digits, _ . -'); process.exit(1); }
(async () => {
  const iter = 100000, salt = crypto.getRandomValues(new Uint8Array(16));
  const hex = (b) => Buffer.from(b).toString('hex');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(p), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  const hash = `pbkdf2$${iter}$${hex(salt)}$${hex(bits)}`;
  const sql = `INSERT INTO admins(username,password_hash) VALUES('${u}','${hash}') ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash;`;
  const file = path.join(os.tmpdir(), 'reset-admin.sql');
  fs.writeFileSync(file, sql);
  const target = process.argv.includes('--local') ? '--local' : '--remote';
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'shop-manager-db', target, '--file', file], { stdio: 'inherit', shell: process.platform === 'win32' });
  fs.unlinkSync(file);
  process.exit(r.status || 0);
})();
