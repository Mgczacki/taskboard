import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `pnpm dev` runs a sandbox server on its own port and passes it here
const api = `127.0.0.1:${process.env.TASKBOARD_PORT || 4317}`;

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': `http://${api}`,
      '/ws': { target: `ws://${api}`, ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
