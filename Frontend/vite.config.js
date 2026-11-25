import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backendTarget = process.env.VITE_BACKEND_PROXY_TARGET || 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: ['5wqv5khjzb-5173.cnb.run'],
    proxy: {
      '/chat': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/upload-url': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/avatar': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/api': {
        target: backendTarget,
        changeOrigin: true,
        ws: true,
      },
      '/lam': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/readiness': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/ws/lam-client': {
        target: backendTarget,
        changeOrigin: true,
        ws: true,
      },
      '/ws': {
        target: backendTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
