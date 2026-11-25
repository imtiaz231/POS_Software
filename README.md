# Shop Manager (Cloudflare edition)

Runs fully on Cloudflare: Workers (API) + D1 (database) + R2 (photos) + static assets (React app).

## One-time setup (from your PC)
```sh
npm install
npx wrangler login
npx wrangler d1 create shop-manager-db      # copy the database_id into wrangler.jsonc
npx wrangler r2 bucket create shop-manager-files
npm run db:remote                            # creates the tables
npx wrangler secret put JWT_SECRET           # any long random text (32+ chars)
npx wrangler secret put ADMIN_USERNAME       # e.g. admin
npx wrangler secret put ADMIN_PASSWORD       # 8+ characters
npm run deploy
```
The admin account is created automatically on the first login.

## Later
- Update the app: `npm run deploy`
- Forgot admin password: `npm run reset-admin -- admin NewPassword123`
- Local test: copy `.dev.vars.example` to `.dev.vars`, then `npm run db:local` and `npm run dev` (open http://localhost:8787).
