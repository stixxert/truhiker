#!/usr/bin/env node
/**
 * ensure-data.mjs — generated data is produced by the build, never committed (D24).
 *
 * The rule this file enforces:
 *
 *   - a **binary** artefact under `data/` is a build output. It is never in git;
 *     `.gitignore` says so and the gate fails if one is tracked.
 *   - the **licence text** that must ship beside that artefact is build output too.
 *     It is fetched once from its publisher into `data/` and verified against the
 *     same pin, so the tree carries no copy of it (D24).
 *   - the **pin** is `tools/data-manifest.json`, which *is* committed. It carries
 *     the SHA-256, the byte size and the counts a build has to reproduce, and it
 *     is configuration (like a lockfile), not data. The provenance file the build
 *     writes next to the artefact (`data/shops.osm.json`) is generated too: it is
 *     what the deployed site serves beside the binary, not what git holds.
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
const MANIFEST = 'tools/data-manifest.json';

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

function readManifest() {
  if (!existsSync(MANIFEST)) {
    throw new Error(`missing ${MANIFEST}: the pin for generated data is committed and the\n` + 'build cannot verify anything without it (D24).');
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const entry = manifest?.artefacts?.[0];
  if (!entry?.file || !entry?.sha256) throw new Error(`${MANIFEST} has no usable artefact entry`);
  return entry;
}

/**
 * Does this licence text match the pin?
 *
 * A notice is generated data in exactly the sense D24 means: it is fetched, not
 * authored, and it has to arrive unmodified or not at all.
 */
export function verifyNotice(buffer, notice) {
  if (buffer.byteLength === 0) return { ok: false, reason: 'notice is empty' };
  if (typeof notice.bytes === 'number' && buffer.byteLength !== notice.bytes) {
    return { ok: false, reason: `notice is ${buffer.byteLength} bytes, the pin says ${notice.bytes}` };
  }
  const digest = sha256(buffer);
  if (digest !== notice.sha256) {
    return { ok: false, reason: `sha256 ${digest} does not match the pinned ${notice.sha256}` };
  }
  return { ok: true };
}

function readNotices() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const notices = manifest?.notices;
  if (!Array.isArray(notices) || notices.length === 0) {
    throw new Error(`${MANIFEST} has no "notices": the ODbL text has to ship beside the data it covers`);
  }
  for (const notice of notices) {
    if (!notice?.file || !notice?.source || !notice?.sha256) {
      throw new Error(`${MANIFEST}: a "notices" entry is missing file, source or sha256`);
    }
  }
  return notices;
}

/**
 * Put the licence texts in `data/`, verified against the pin.
 *
 * Reuse a local copy that matches; otherwise fetch the published text. A copy that
 * does not match is refused rather than overwritten: an edited licence text is a
 * mistake someone should see, not a file silently replaced.
 */
async function ensureNotices() {
  for (const notice of readNotices()) {
    const path = join(DATA_DIR, notice.file);
    if (existsSync(path)) {
      const verdict = verifyNotice(readFileSync(path), notice);
      if (!verdict.ok) {
        throw new Error(
          `${path} does not match the pinned ${notice.title}: ${verdict.reason}\n` +
            'Delete it and re-run: the build fetches and verifies the text from the pin.',
        );
      }
      console.log(`ensure-data: ${path} present and pinned`);
      continue;
    }
    let response;
    try {
      response = await fetch(notice.source, { signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      throw new Error(
        `could not fetch ${notice.title} from ${notice.source} (${error.message}), and the\n` +
          `build must not ship the data without its licence text. Put a verified copy at\n` +
          `${path}, or allow the fetch.`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} from ${notice.source}: the licence text cannot be fetched,\n` +
          'and the build must not ship the data without it.',
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const verdict = verifyNotice(bytes, notice);
    if (!verdict.ok) {
      throw new Error(
        `${notice.source}: ${verdict.reason}\n` +
          'Change the pin only after reading the new text and deciding it is still the licence.',
      );
    }
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(path, bytes);
    console.log(`ensure-data: fetched ${notice.source} -> ${path}`);
  }
}

/**
 * Does this artefact match the **pin**?
 *
 * The artefact's own provenance is not the authority — it is written by the same
 * run that wrote the bytes, so it can only agree with itself. The manifest is what
 * git holds, and it is what a rebuild has to reproduce.
 */
export function verifyPinned(buffer, entry) {
  const verdict = verifyArtefact(buffer, { checksum: { sha256: entry.sha256 }, sizes: { withNames: { raw: entry.bytes } } });
  if (!verdict.ok) return verdict;
  const provenancePath = join(DATA_DIR, entry.provenance ?? 'shops.osm.json');
  if (!existsSync(provenancePath)) return { ok: true, how: 'pinned (no provenance to cross-check)' };
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
  const total = provenance?.counts?.total;
  if (typeof entry.counts?.total === 'number' && total !== entry.counts.total) {
    return { ok: false, reason: `provenance records ${String(total)} records, the pin says ${entry.counts.total}` };
  }
  return { ok: true };
}

/** Build from a PBF (producer mode). Rewrites the provenance as a side effect. */
function buildFromPbf(pbf) {
  if (!existsSync(pbf)) throw new Error(`--from-pbf: no such file: ${pbf}`);
  // 3 GB of heap: two passes over a 1.4 GB extract, per D23.
  execFileSync('node', ['--max-old-space-size=3072', 'tools/build-shops.mjs', '--pbf', pbf, '--out', DATA_DIR], {
    stdio: 'inherit',
  });
}

/**
 * Fetch the published copy (consumer mode, when nothing is on disk).
 *
 * Both files are required, not just the artefact: the app reads the extract date
 * out of the provenance and the ODbL notice is generated from it, so a published
 * copy that carries only the binary is not a copy a build can use. Fetching one
 * and then failing later at `copy-data` would be a worse error than this one.
 */
async function fetchPublished(entry) {
  const base = process.env.TRUHIKER_DATA_URL;
  if (!base) return { ok: false, reason: 'no local artefact and $TRUHIKER_DATA_URL is not set' };
  const root = base.replace(/\/$/, '');
  const url = `${root}/${entry.file}`;
  const response = await fetch(url);
  if (!response.ok) return { ok: false, reason: `HTTP ${response.status} from ${url}` };
  const bytes = Buffer.from(await response.arrayBuffer());
  const verdict = verifyPinned(bytes, entry);
  if (!verdict.ok) return { ok: false, reason: `${url}: ${verdict.reason}` };

  const provenanceUrl = `${root}/${entry.provenance}`;
  const provenanceResponse = await fetch(provenanceUrl);
  if (!provenanceResponse.ok) {
    return {
      ok: false,
      reason:
        `HTTP ${provenanceResponse.status} from ${provenanceUrl} — the published copy must carry ` +
        `${entry.provenance} beside ${entry.file}, because the app reads the extract date from it`,
    };
  }
  const provenance = await provenanceResponse.json();
  if (typeof entry.counts?.total === 'number' && provenance?.counts?.total !== entry.counts.total) {
    return {
      ok: false,
      reason: `${provenanceUrl} records ${String(provenance?.counts?.total)} records, the pin says ${entry.counts.total}`,
    };
  }

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, entry.file), bytes);
  writeFileSync(join(DATA_DIR, entry.provenance), `${JSON.stringify(provenance, null, 2)}\n`);
  return { ok: true, how: `fetched ${url} and ${provenanceUrl}` };
}

async function main() {
  const argv = process.argv.slice(2);
  const pbfFlag = argv.indexOf('--from-pbf');
  const pbf = pbfFlag >= 0 ? argv[pbfFlag + 1] : process.env.OSM_PBF;

  if (pbf) {
    buildFromPbf(pbf);
    const entry = readManifest();
    const bytes = readFileSync(join(DATA_DIR, entry.file));
    const verdict = verifyArtefact(bytes, {
      checksum: { sha256: sha256(bytes) },
      sizes: { withNames: { raw: bytes.byteLength } },
    });
    if (!verdict.ok) throw new Error(`build from ${pbf} produced an unusable artefact: ${verdict.reason}`);
    // A producer does **not** fail on a difference from the pin: the monthly
    // refresh ships newer data than the commit describes (D23). It says so.
    if (sha256(bytes) !== entry.sha256) {
      console.warn(
        `ensure-data: ${entry.file} differs from the committed pin (sha256 ${sha256(bytes).slice(0, 12)}…);\n` +
          `  this is expected after a data refresh (D23). Update ${MANIFEST} when you next touch the repo.`,
      );
    }
    console.log(`ensure-data: built ${entry.file} from ${pbf}`);
    await ensureNotices();
    return;
  }

  const entry = readManifest();
  const artefactPath = join(DATA_DIR, entry.file);

  if (existsSync(artefactPath)) {
    const verdict = verifyPinned(readFileSync(artefactPath), entry);
    if (!verdict.ok) {
      throw new Error(
        `${artefactPath} does not match the committed pin: ${verdict.reason}\n` +
          'Rebuild it (`npm run data:build` with $OSM_PBF set) or delete it and let the\n' +
          'build fetch the published copy.',
      );
    }
    // The provenance is not decoration: the app reads the extract date from
    // `/data/shops.osm.json` and shows it, and the ODbL notice is generated from
    // it. A binary without it is a build that would serve a data file nobody can
    // date or credit.
    if (!existsSync(join(DATA_DIR, entry.provenance))) {
      throw new Error(
        `${artefactPath} has no ${entry.provenance} beside it. The provenance is a build\n` +
          'output too (D24): regenerate the pair with `npm run data:build`, or delete the\n' +
          'artefact and let the build fetch the published copy (which carries both).',
      );
    }
    console.log(`ensure-data: ${entry.file} present and pinned — ${entry.counts?.total ?? '?'} records, sha256 verified`);
    await ensureNotices();
    return;
  }

  const fetched = await fetchPublished(entry);
  if (!fetched.ok) {
    throw new Error(
      `no ${artefactPath} and it could not be fetched (${fetched.reason}).\n` +
        'Generated data is a build output, not a committed file (D24). One of:\n' +
        '  npm run data:build            # rebuild from the Geofabrik PBF (needs $OSM_PBF)\n' +
        '  TRUHIKER_DATA_URL=... npm run build   # fetch a published, pinned copy\n',
    );
  }
  console.log(`ensure-data: ${fetched.how} — ${entry.counts?.total ?? '?'} records, sha256 verified`);
  await ensureNotices();
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
