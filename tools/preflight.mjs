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
import { existsSync, statSync } from 'node:fs';

const REQUIRED = ['vite', 'typescript', 'vitest'];

const dependencyProblems = [];
if (!existsSync('node_modules')) {
  dependencyProblems.push('node_modules is missing');
} else {
  const require = createRequire(import.meta.url);
  for (const name of REQUIRED) {
    try {
      require.resolve(name);
    } catch {
      dependencyProblems.push(`\`${name}\` is not installed`);
    }
  }
}

/** A path that names an extract we could build from, not a directory or a typo. */
function isBuildableExtract(path) {
  if (typeof path !== 'string' || path.trim() === '') return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// The map needs its data too; tools/ensure-data.mjs verifies or fetches it, and is
// the next step in the build. Mention it here so the order is obvious in one place.
//
// A missing `data/` is only a problem when **nothing in this build can produce it**.
// Three things can, and all three are environment rather than filesystem: a PBF to
// build from (`$OSM_PBF`, the producer), a published copy to fetch
// (`$TRUHIKER_DATA_URL`, the consumer), or a Workers build container, whose build
// step produces it from the Geofabrik extract (`$WORKERS_CI`, D23). Failing on the
// directory alone made those paths impossible — creating `data/` is the next step of
// the build, so it never got the chance to run.
const willProduceData =
  (process.env.TRUHIKER_DATA_URL ?? '').trim() !== '' ||
  (process.env.WORKERS_CI ?? '').trim() !== '' ||
  isBuildableExtract(process.env.OSM_PBF);

const dataProblems = [];
if (!existsSync('data') && !willProduceData) {
  dataProblems.push(
    'data/ is missing (it is build output, not committed — D24):\n' +
      '    run `npm run refresh:shops` (downloads the Geofabrik extract and builds it),\n' +
      '    `OSM_PBF=… npm run data:build` to reuse a local extract, or set\n' +
      '    TRUHIKER_DATA_URL to a published copy',
  );
}

const problems = [...dependencyProblems, ...dataProblems];

if (problems.length > 0) {
  // The way out depends on what is missing. Dependencies are installed once and
  // persist; `data/` is build output that `npm run build` creates (and `npm test`
  // merely reads). Naming the wrong step is how the old message sent a build
  // container to `npm ci` when it had nothing to install.
  const advice =
    dependencyProblems.length > 0
      ? '\n\nRun `npm ci` in this directory first (it installs exactly what package-lock\n' +
        'pins), then `npm run build`.\n'
      : '\n\n`npm run build` creates `data/` before it bundles anything; `npm test` only\n' +
        'reads what is already there.\n';

  console.error(
    `preflight: this checkout cannot build yet.\n` +
      problems.map((problem) => `  - ${problem}`).join('\n') +
      advice,
  );
  process.exit(1);
}
