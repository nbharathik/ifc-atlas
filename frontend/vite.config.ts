import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Cross-origin isolation headers (COOP + COEP). When both headers
// are present, `self.crossOriginIsolated` flips to `true`, which unlocks
// SharedArrayBuffer. web-ifc then picks its multi-threaded WASM variant
// (`web-ifc-mt.wasm`) automatically, roughly halving IFC parse time on
// medium/large models. `COEP: credentialless` is used instead of
// `require-corp` so cross-origin resources (Google Fonts, etc.) still
// load without explicit CORP headers - they are just served without
// credentials, which is what we want for public assets anyway.
//
// Applied to both dev and preview servers. Production (Docker/Nginx)
// should mirror these headers in the hosting config.
const CROSS_ORIGIN_ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'Cross-Origin-Resource-Policy': 'same-origin',
} as const

function envPort(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// When VITE_PLATFORM=tauri the app is compiled for the Tauri desktop shell.
// Tauri sidecar backend runs on port 8000 (matches backend/run.py default).
const TAURI_BACKEND_PORT = envPort('TAURI_BACKEND_PORT', 8000);
const WEB_BACKEND_PORT = envPort('VITE_BACKEND_PORT', envPort('BACKEND_PORT', 8000));
const isDesktopBuild = process.env.VITE_PLATFORM === 'tauri';
const backendPort = isDesktopBuild ? TAURI_BACKEND_PORT : WEB_BACKEND_PORT;
// Inside docker-compose the backend is a sibling container, not localhost -
// the compose file sets BACKEND_HOST=backend so the dev proxy can reach it.
const backendHost = process.env.BACKEND_HOST?.trim() || 'localhost';

export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['three'],
  },
  // Expose VITE_PLATFORM to the app so platform.ts can detect at compile-time.
  define: {
    '__VITE_PLATFORM__': JSON.stringify(process.env.VITE_PLATFORM ?? 'web'),
  },
  server: {
    // Honor a harness/CI-assigned PORT so the
    // dev server can bind a free port when 5173 is taken; falls back to 5173
    // for a normal `npm run dev`.
    port: envPort('PORT', 5173),
    headers: { ...CROSS_ORIGIN_ISOLATION_HEADERS },
    proxy: {
      '/api': {
        target: `http://${backendHost}:${backendPort}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  preview: {
    port: 4173,
    headers: { ...CROSS_ORIGIN_ISOLATION_HEADERS },
  },
  optimizeDeps: {
    exclude: ['web-ifc'],
  },
  assetsInclude: ['**/*.wasm'],
  build: {
    rollupOptions: {
      output: {
        // Keep the heavy 3D engine out of the entry chunk so the app
        // shell (React + UI) can paint before the viewer dependencies finish
        // downloading. `three`, the @thatopen/* fragment stack and `web-ifc`
        // are bundled into a single long-lived `viewer-engine` chunk that the
        // browser can cache independently of the frequently-changing entry
        // bundle. react/react-dom share one `react-vendor` chunk (split into
        // the SAME chunk - separating them would risk a second React instance
        // / invalid-hook errors). This trims entry-chunk size and lowers
        // FCP/LCP on cold load without changing any runtime behaviour.
        manualChunks: {
          'viewer-engine': [
            'three',
            '@thatopen/components',
            '@thatopen/components-front',
            '@thatopen/fragments',
            'web-ifc',
          ],
          'react-vendor': ['react', 'react-dom'],
        },
      },
    },
  },
})
