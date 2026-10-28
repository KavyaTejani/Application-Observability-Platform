import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

// In development the browser talks only to Vite; API and health calls are proxied to Express
// so the session cookie is same-origin, exactly as in production where Express serves the UI.
const apiTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // `source` bundles workspace packages (e.g. @aop/validation) from their TypeScript source.
  resolve: { conditions: ['source', ...defaultClientConditions] },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': apiTarget,
      '/health': apiTarget,
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Content blockers filter script URLs with tracking-style words, even first-party ones,
        // so shared chunks named after such modules get a neutral name.
        chunkFileNames: (chunk) =>
          /telemetry|metrics|analytics|track|beacon/i.test(chunk.name)
            ? 'assets/shared-[hash].js'
            : 'assets/[name]-[hash].js',
      },
    },
  },
});
