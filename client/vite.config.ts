import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API runs on `wrangler dev` (port 8787)
const target = process.env.API_TARGET || 'http://localhost:8787';
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5173, proxy: { '/api': target, '/uploads': target } },
});
