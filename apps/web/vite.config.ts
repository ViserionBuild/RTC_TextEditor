import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const relay = process.env.RELAY_URL ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': relay,
      '/ws': { target: relay.replace(/^http/, 'ws'), ws: true },
    },
  },
});
