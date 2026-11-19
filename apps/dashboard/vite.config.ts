import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const web = new URL(process.env.WEBPUSH_WEB_ORIGIN ?? 'http://localhost:5173');
if (web.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(web.hostname)) throw new Error('Only a local HTTP frontend origin is supported.');

export default defineConfig({
  plugins: [react()],
  server: {
    host: web.hostname,
    port: Number(web.port),
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.WEBPUSH_API_PORT ?? 8787}`, changeOrigin: true } },
    headers: { 'Cache-Control': 'no-store' },
  },
  build: { sourcemap: false },
});
