import { defineConfig } from 'vite';

// In local dev, /api/rpc is proxied straight to the Aevum RPC (or AEVUM_RPC_URL). On Vercel, api/rpc.js handles it.
const target = process.env.AEVUM_RPC_URL || 'https://rpc-test.qday.info';
export default defineConfig({
  server: {
    proxy: {
      '/api/rpc': { target, changeOrigin: true, rewrite: () => '/' },
    },
  },
});
