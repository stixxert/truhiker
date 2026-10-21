#!/usr/bin/env node
/**
 * preflight.mjs — say the useful thing before a build fails cryptically.
 *
 * When dependencies are missing, Vite fails as
 *
 *     Error: ENOENT: no such file or directory, mkdir '…/node_modules/.vite-temp'
 *
 * which names a temp directory and not the cause: `node_modules` is not there at
 * all (a fresh clone, or a tree whose install happened somewhere else). This says
 * "run npm ci" instead, and it runs first in `npm run build` and `npm run verify`.
 *
 * Deliberately dependency-free: `node:` built-ins only, so it works in exactly the
 * situation it exists for.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const REQUIRED = ['vite', 'typescript', 'vitest'];

const problems = [];
if (!existsSync('node_modules')) {
  problems.push('node_modules is missing');
} else {
  const require = createRequire(import.meta.url);
  for (const name of REQUIRED) {
    try {
      require.resolve(name);
    } catch {
      problems.push(`\`${name}\` is not installed`);
    }
  }
}

// The map needs its data too; tools/ensure-data.mjs verifies or fetches it, and is
// the next step in the build. Mention it here so the order is obvious in one place.
if (!existsSync('data')) {
  problems.push(
    'data/ is missing (it is build output, not committed — D24):\n' +
      '    run `OSM_PBF=… npm run data:build`, or set TRUHIKER_DATA_URL to a published copy',
  );
}

if (problems.length > 0) {
  console.error(
    `preflight: this checkout cannot build yet.\n` +
      problems.map((problem) => `  - ${problem}`).join('\n') +
      `\n\nRun \`npm ci\` in this directory first (it installs exactly what package-lock\n` +
      `pins), then \`npm run build\`.\n`,
  );
  process.exit(1);
}
