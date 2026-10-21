#!/usr/bin/env node
/**
 * ensure-data.mjs — generated data is produced by the build, never committed (D24).
 *
 * The rule this file enforces:
 *
 *   - a **binary** artefact under `data/` is a build output. It is never in git;
 *     `.gitignore` says so and the gate fails if one is tracked.
 *   - the **provenance** file next to it (`data/shops.osm.json`) *is* committed.
 *     It carries the SHA-256, the byte size and the counts — that is the pin a
 *     rebuild has to reproduce, and it is what makes a silent data swap visible.
 *
 * Two modes, one script, because both run at build time:
 *
 *   producer — a PBF is available (`--from-pbf <file>` or `$OSM_PBF`). The
 *              artefact is (re)built from the upstream extract and the
 *              provenance is rewritten by `tools/build-shops.mjs`. This is what
 *              the deploy container does (D23).
 *   consumer — no PBF. Reuse a local artefact that matches the pin, or fetch the
 *              published copy (`$TRUHIKER_DATA_URL`) and verify it. This is what
 *              a checkout does, and it is deliberately allowed to fail: a build
 *              with no artefact and no source is not a build we ship.
 *
 * Never silently accepted: a mismatched checksum, a wrong byte count, a missing
 * provenance, or an empty artefact. Shipping an empty index is the worst
 * failure — it reads on screen as "there are no shops in Norway".
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = 'data';
const PROVENANCE = 'shops.osm.json';

/** SHA-256 of a buffer, lowercase hex. */
export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Does this artefact match its provenance record?
 *
 * Exported so there is exactly one definition of "the file matches the pin":
 * the build (`main` below) and the gate (`tools/verify/verify.mjs`) both use it.
 * It must say no to a wrong hash, a wrong size, an empty file, and a provenance
 * record that carries no checksum at all.
 */
export function verifyArtefact(buffer, provenance) {
  const recorded = provenance?.checksum?.sha256;
  if (typeof recorded !== 'string' || recorded.length !== 64) {
    return { ok: false, reason: 'provenance carries no SHA-256' };
  }
  if (buffer.byteLength === 0) {
    return { ok: false, reason: 'artefact is empty (an empty index reads as "no places in Norway")' };
  }
  const digest = sha256(buffer);
  if (digest !== recorded) {
    return { ok: false, reason: `sha256 ${digest} does not match the recorded ${recorded}` };
  }
  const expectedBytes = provenance?.sizes?.withNames?.raw;
  if (typeof expectedBytes === 'number' && buffer.byteLength !== expectedBytes) {
    return { ok: false, reason: `artefact is ${buffer.byteLength} bytes, provenance records ${expectedBytes}` };
  }
  return { ok: true };
}

function readProvenance() {
  const path = join(DATA_DIR, PROVENANCE);
  if (!existsSync(path)) {
    throw new Error(
      `missing ${path}. The provenance file is committed and pins the data; a build\n` +
        'cannot verify or reproduce an artefact without it.',
    );
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Build from a PBF (producer mode). Rewrites the provenance as a side effect. */
function buildFromPbf(pbf) {
  if (!existsSync(pbf)) throw new Error(`--from-pbf: no such file: ${pbf}`);
  // 3 GB of heap: two passes over a 1.4 GB extract, per D23.
  execFileSync('node', ['--max-old-space-size=3072', 'tools/build-shops.mjs', '--pbf', pbf, '--out', DATA_DIR], {
    stdio: 'inherit',
  });
}

/** Fetch the published artefact (consumer mode, when nothing is on disk). */
async function fetchPublished(provenance) {
  const base = process.env.TRUHIKER_DATA_URL;
  if (!base) return { ok: false, reason: 'no local artefact and $TRUHIKER_DATA_URL is not set' };
  const url = `${base.replace(/\/$/, '')}/${provenance.file}`;
  const response = await fetch(url);
  if (!response.ok) return { ok: false, reason: `HTTP ${response.status} from ${url}` };
  const bytes = Buffer.from(await response.arrayBuffer());
  const verdict = verifyArtefact(bytes, provenance);
  if (!verdict.ok) return { ok: false, reason: `${url}: ${verdict.reason}` };
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, provenance.file), bytes);
  return { ok: true, how: `fetched ${url}` };
}

async function main() {
  const argv = process.argv.slice(2);
  const pbfFlag = argv.indexOf('--from-pbf');
  const pbf = pbfFlag >= 0 ? argv[pbfFlag + 1] : process.env.OSM_PBF;

  if (pbf) {
    buildFromPbf(pbf);
    const provenance = readProvenance();
    const bytes = readFileSync(join(DATA_DIR, provenance.file));
    const verdict = verifyArtefact(bytes, provenance);
    if (!verdict.ok) throw new Error(`build from ${pbf} produced an artefact that fails its own pin: ${verdict.reason}`);
    console.log(`ensure-data: built ${provenance.file} from ${pbf} — ${provenance.counts.total} records, sha256 verified`);
    return;
  }

  const provenance = readProvenance();
  const artefactPath = join(DATA_DIR, provenance.file);

  if (existsSync(artefactPath)) {
    const verdict = verifyArtefact(readFileSync(artefactPath), provenance);
    if (!verdict.ok) {
      throw new Error(
        `${artefactPath} does not match its committed provenance: ${verdict.reason}\n` +
          'Rebuild it (`npm run data:build` with $OSM_PBF set) or delete it and let the\n' +
          'build fetch the published copy.',
      );
    }
    console.log(`ensure-data: ${provenance.file} present and pinned — ${provenance.counts.total} records, sha256 verified`);
    return;
  }

  const fetched = await fetchPublished(provenance);
  if (!fetched.ok) {
    throw new Error(
      `no ${artefactPath} and it could not be fetched (${fetched.reason}).\n` +
        'Generated data is a build output, not a committed file (D24). One of:\n' +
        '  npm run data:build            # rebuild from the Geofabrik PBF (needs $OSM_PBF)\n' +
        '  TRUHIKER_DATA_URL=... npm run build   # fetch a published, pinned copy\n',
    );
  }
  console.log(`ensure-data: ${fetched.how} — ${provenance.counts.total} records, sha256 verified`);
}

// Only run when executed directly: the helpers above are imported by the gate.
//
// `import.meta.url` is a percent-encoded, symlink-resolved URL; comparing it to a
// raw `file://${process.argv[1]}` string silently fails for a checkout whose path
// contains a space ("John Smith") or is reached through a symlink — and a guard
// that fails silently means `npm run build` proceeds without checking the data at
// all. Compare real paths instead.
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(`ensure-data: ${error.message}`);
    process.exit(1);
  });
}
