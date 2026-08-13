import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = Number(process.env.API_PORT || process.env.PORT || 8787);
const clientPort = Number(process.env.VITE_PORT || 5173);

export default defineConfig({
  plugins: [react()],
  server: {
    port: clientPort,
    strictPort: true,
    proxy: {
      '/api': `http://localhost:${apiPort}`,
    },
  },
});
