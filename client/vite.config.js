import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies API calls to the Express backend on :3001, so frontend
// code can use same-origin relative paths ("/suggest") with no CORS setup and no
// hardcoded host. We proxy only the routes that exist so far; later steps add
// /search, /cache, /metrics under the same scheme.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/suggest': 'http://localhost:3001',
      '/search': 'http://localhost:3001',
    },
  },
});
