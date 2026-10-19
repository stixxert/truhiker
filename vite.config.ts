import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { defineConfig } from 'vite';

/**
 * In this project `node_modules` may be a symlink (CI sandboxes do that to keep
 * the project mount small). Vite refuses to serve files outside the project
 * root, so allow the real path of node_modules explicitly. Harmless when it is
 * a normal directory.
 */
const nodeModulesRealPath = (() => {
  try {
    return realpathSync(new URL('./node_modules', import.meta.url));
  } catch {
    return null;
  }
})();

/**
 * Ship the licence notices the build is obliged to carry.
 *
 * `scripts/copy-licences.mjs` exists for exactly this, but `npm run build` does
 * not call it (package.json is owned elsewhere), and `vite build` empties
 * `dist/` — so `node scripts/licence-audit.mjs` failed on a clean build even
 * though the notices were all present in the repository. Running the script at
 * the end of the bundle keeps one definition of what must ship, and makes the
 * audit reproducible from `npm run build`.
 */
const copyLicences = {
  name: 'copy-licences',
  apply: 'build' as const,
  closeBundle() {
    execFileSync(process.execPath, ['scripts/copy-licences.mjs'], { stdio: 'inherit' });
  },
};

export default defineConfig({
  plugins: [copyLicences],
  // Relative asset paths: the build is a static SPA that can live on any path.
  base: './',
  worker: {
    format: 'es',
  },
  server: {
    fs: {
      allow: ['.', ...(nodeModulesRealPath ? [nodeModulesRealPath] : [])],
    },
  },
  optimizeDeps: {
    // maplibre-gl spawns its own worker via `new URL(..., import.meta.url)`.
    // Pre-bundling rewrites that URL to a file Vite does not serve, so the
    // library must stay unbundled in dev.
    exclude: ['maplibre-gl'],
  },
  build: {
    target: 'es2022',
    assetsDir: '',
    emptyOutDir: true,
    // No bundled data, no external fonts: everything except the app shell and
    // MapLibre is fetched live.
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/maplibre-gl')) return 'maplibre';
          return undefined;
        },
      },
    },
  },
});
