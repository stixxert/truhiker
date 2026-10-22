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
 * Is this record count a plausible build of the same database?
 *
 * The pin's count is the only independent reference a build has, and the worst
 * failure this script knows about is an index that is technically valid and nearly
 * empty: it reads on screen as "there are no shops in Norway" (D7). A monthly
 * refresh moves the count by a fraction of a percent, so a wide band still catches a
 * regional extract, a truncated parse and a zero-record file — the failures that
 * look like data — while tolerating a year of drift.
 */
const COUNT_BAND = { min: 0.75, max: 1.25 };

function plausibleCount(total, pinned) {
  if (!Number.isInteger(total) || total <= 0) {
    return { ok: false, reason: `records ${String(total)}` };
  }
  if (typeof pinned !== 'number' || pinned <= 0) return { ok: true };
  const ratio = total / pinned;
  if (ratio < COUNT_BAND.min || ratio > COUNT_BAND.max) {
    return { ok: false, reason: `${total} records against the pin's ${pinned}` };
  }
  return { ok: true };
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

/**
 * Are we in a Workers build container rather than on a developer's machine?
 *
 * `WORKERS_CI=1` is injected by Workers Builds and nothing else, which matters: a
 * generic `CI=true` must not trigger a 1.4 GB download on every unrelated CI run.
 * `CI` is deliberately ignored.
 */
function isWorkersBuild() {
  return (process.env.WORKERS_CI ?? '').trim() !== '';
}

/**
 * Run the documented producer (`tools/refresh-shops.sh`) inside this build.
 *
 * The build command on Workers Builds is dashboard state, not repository state —
 * the platform does not read `[build]` from `wrangler.jsonc`, and it infers
 * `npm run build` — so a repository that cannot build from a bare clone is one
 * forgotten setting away from a red deploy. Instead of depending on that setting,
 * the build produces the data it needs when it is running in the container. The
 * script is the same one the monthly refresh documents (D23): download, size guard,
 * two passes, `inspect-shops --verify`.
 */
function produceFromExtract() {
  execFileSync('bash', ['tools/refresh-shops.sh'], { stdio: 'inherit' });
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
    // refresh ships newer data than the commit describes (D23). It does fail on an
    // index that is not plausibly the same database, because a regional or
    // truncated extract would otherwise ship as "Norway has four shops".
    const builtCount = JSON.parse(
      readFileSync(join(DATA_DIR, entry.provenance ?? 'shops.osm.json'), 'utf8'),
    )?.counts?.total;
    const plausibility = plausibleCount(builtCount, entry.counts?.total);
    if (!plausibility.ok) {
      throw new Error(
        `the build from ${pbf} produced ${plausibility.reason}, which is not the extract this app\n` +
          'serves. Refusing an index that would read on screen as "there are no shops in\n' +
          'Norway": check that the PBF is the national extract.',
      );
    }
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

  if (!existsSync(artefactPath)) {
    // Nothing on disk. In order of preference: a published copy to verify against
    // the pin, then — in a Workers build container only — the extract itself.
    const fetched = await fetchPublished(entry);
    if (fetched.ok) {
      console.log(`ensure-data: ${fetched.how} — ${entry.counts?.total ?? '?'} records, sha256 verified`);
    } else if (isWorkersBuild()) {
      console.log(
        `ensure-data: ${fetched.reason}; building from the Geofabrik extract instead\n` +
          '  (Workers build container: generated data is never committed, D23/D24)',
      );
      produceFromExtract();
      if (!existsSync(artefactPath)) {
        throw new Error(
          'the extract build reported success but wrote no artefact: `tools/refresh-shops.sh`\n' +
            'and `tools/build-shops.mjs` disagree about where the output goes.',
        );
      }
    } else {
      throw new Error(
        `no ${artefactPath} and it could not be fetched (${fetched.reason}).\n` +
          'Generated data is a build output, not a committed file (D24). One of:\n' +
          '  npm run data:build            # rebuild from the Geofabrik PBF (needs $OSM_PBF)\n' +
          '  TRUHIKER_DATA_URL=... npm run build   # fetch a published, pinned copy\n',
      );
    }
  }

  if (existsSync(artefactPath)) {
    const bytes = readFileSync(artefactPath);

    // The provenance is not decoration: the app reads the extract date from
    // `/data/shops.osm.json` and shows it, and the ODbL notice is generated from
    // it. A binary without it is a build that would serve a data file nobody can
    // date or credit.
    const provenancePath = join(DATA_DIR, entry.provenance);
    if (!existsSync(provenancePath)) {
      throw new Error(
        `${artefactPath} has no ${entry.provenance} beside it. The provenance is a build\n` +
          'output too (D24): regenerate the pair with `npm run data:build`, or delete the\n' +
          'artefact and let the build fetch the published copy (which carries both).',
      );
    }

    const pinned = verifyPinned(bytes, entry);
    if (pinned.ok) {
      console.log(`ensure-data: ${entry.file} present and pinned — ${entry.counts?.total ?? '?'} records, sha256 verified`);
      await ensureNotices();
      return;
    }

    // Not the pinned artefact. Several very different situations produce that, and
    // the provenance is what tells them apart:
    //
    //   - a **producer** run in this checkout (`refresh-shops.sh` in a Workers
    //     Builds container, D23) wrote a newer extract than the commit describes.
    //     It wrote the provenance in the same run, so the pair agrees with itself.
    //     The deployed artefact is *expected* to differ from the pin — `data/` is
    //     never committed, so the pin cannot follow it — and refusing here would
    //     fail every refresh build.
    //   - a **damaged** or half-written artefact, which agrees with neither the pin
    //     nor its own provenance. That must not ship: it would serve a data file
    //     whose contents nobody can vouch for.
    //
    // What is *not* offered here is the pin's content check, so it is replaced with
    // the checks that do not need a committed copy: the bytes are the ones their own
    // provenance describes, the record count is plausibly the same database (an
    // index of four points reads on screen as "there are no shops in Norway", D7),
    // and the extract is not older than the pin's. Anything else, and `npm run
    // verify` still fails afterwards — nothing runs that gate automatically.
    let provenance;
    try {
      provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
    } catch (error) {
      throw new Error(
        `${provenancePath} is not readable JSON (${error.message}). It is build output (D24):\n` +
          'regenerate the pair with `npm run data:build`, or delete both files and let the\n' +
          'build fetch the published copy.',
      );
    }

    const self = verifyArtefact(bytes, provenance);
    if (!self.ok) {
      throw new Error(
        `${artefactPath} matches neither the committed pin (${pinned.reason}) nor its own\n` +
          `provenance (${self.reason}). Rebuild it (\`npm run data:build\` with $OSM_PBF set)\n` +
          'or delete it and let the build fetch the published copy.',
      );
    }

    // The same bytes as the pin with a different recorded count is not drift: the
    // artefact is the pinned one and the provenance is wrong about it, which is the
    // count check the pin exists to make (D24).
    if (sha256(bytes) === entry.sha256) {
      throw new Error(
        `${artefactPath} is the pinned artefact, but ${pinned.reason}. The provenance is\n` +
          'wrong about the data beside it (D24): rebuild the pair with `npm run data:build`\n' +
          'or delete both and let the build fetch the published copy.',
      );
    }

    const plausibility = plausibleCount(provenance?.counts?.total, entry.counts?.total);
    if (!plausibility.ok) {
      throw new Error(
        `${artefactPath} is not the pinned artefact, and its own provenance records ${plausibility.reason}.\n` +
          'An index that is valid but nearly empty is the failure this build refuses: on screen\n' +
          'it reads as "there are no shops in Norway" (D7). Rebuild it from the national\n' +
          'extract (`npm run refresh:shops`), or delete it and let the build fetch the\n' +
          'published copy.',
      );
    }

    const servedDate = typeof provenance?.source?.extractDate === 'string' ? provenance.source.extractDate : null;
    const pinnedDate = typeof entry.sourceExtractDate === 'string' ? entry.sourceExtractDate : null;
    if (servedDate && pinnedDate && servedDate < pinnedDate) {
      throw new Error(
        `${artefactPath} is older than the pin: its extract is ${servedDate} and the pin\n` +
          `describes ${pinnedDate}. Shipping it would present older data as current.\n` +
          'Rebuild it (`npm run refresh:shops`) or delete it and let the build fetch the\n' +
          'published copy.',
      );
    }

    const drift =
      servedDate && pinnedDate
        ? `is from a different extract than the pin (${servedDate} vs ${pinnedDate})`
        : 'differs from the committed pin';
    console.warn(
      `ensure-data: ${entry.file} ${drift} — ${pinned.reason}\n` +
        `  its own provenance describes these exact bytes (${provenance?.counts?.total ?? '?'} records),\n` +
        '  so it is a produced artefact, not a damaged one: a refresh ships data the commit\n' +
        '  predates (D23). Using it.\n' +
        `  Nothing runs the release gate on this build: update ${MANIFEST} from the artefact\n` +
        '  you actually ship, so the next `npm run verify` describes it.',
    );
    await ensureNotices();
    return;
  }

  // Reached only when both producers declined to write anything: the container path
  // checks that for itself, so this is the last line of defence, not the message a
  // developer should ever see.
  throw new Error(
    `no ${artefactPath} was produced. Nothing was built and nothing was fetched; the\n` +
      'build must not continue without its data (D24).',
  );
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
