/**
 * The build's data step, as the deploy containers run it (D23, D24).
 *
 * `tools/ensure-data.mjs` decides whether a build may ship the resupply artefact.
 * It runs on every deploy, and getting it wrong in either direction is expensive:
 * too strict and every refresh build fails (a produced artefact can never equal the
 * committed pin, because `data/` is not committed), too loose and a damaged — or
 * nearly empty — file ships while the map quietly loses places.
 *
 * The fixtures are synthetic (a few bytes and a matching provenance) because the
 * rule is about checksums, counts and dates, not about the OSM data itself. No
 * network: the notice and the artefact are already in place, which is the state the
 * script is designed to short-circuit.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

type Pin = {
  artefacts: {
    file: string;
    provenance: string;
    bytes: number;
    sha256: string;
    counts: { total: number };
    sourceExtractDate?: string;
  }[];
  notices: { file: string; source: string; sha256: string; bytes: number }[];
};

type Provenance = {
  source: { extractDate: string | null };
  counts: { total: number };
  sizes: { withNames: { raw: number } };
  checksum: { sha256: string };
};

const FIXTURE_BINARY = Buffer.from('NPLSHP01 synthetic artefact for the build gate\n');
const FIXTURE_NOTICE = Buffer.from('ODbL 1.0, synthetic for the test\n');
const PINNED_DATE = '2026-10-18';

/** A checkout-shaped directory: the script, a pin, and a produced artefact. */
function checkout(overrides: { provenance?: Partial<Provenance>; binary?: Buffer } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'truhiker-ensure-data-'));
  mkdirSync(join(root, 'tools'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  cpSync(join(REPO, 'tools/ensure-data.mjs'), join(root, 'tools/ensure-data.mjs'));

  const binary = overrides.binary ?? FIXTURE_BINARY;
  const provenance = {
    source: { extractDate: PINNED_DATE },
    counts: { total: 3 },
    sizes: { withNames: { raw: binary.byteLength } },
    checksum: { sha256: sha256(binary) },
    ...overrides.provenance,
  };
  const pin: Pin = {
    artefacts: [
      {
        file: 'shops.osm.bin',
        provenance: 'shops.osm.json',
        bytes: binary.byteLength,
        sha256: sha256(binary),
        counts: { total: 3 },
        sourceExtractDate: PINNED_DATE,
      },
    ],
    notices: [
      {
        file: 'ODbL-1.0.txt',
        source: 'https://example.invalid/ODbL-1.0.txt',
        sha256: sha256(FIXTURE_NOTICE),
        bytes: FIXTURE_NOTICE.byteLength,
      },
    ],
  };

  const pinPath = join(root, 'tools/data-manifest.json');
  writeFileSync(join(root, 'data/shops.osm.bin'), binary);
  writeFileSync(join(root, 'data/shops.osm.json'), JSON.stringify(provenance, null, 2));
  writeFileSync(join(root, 'data/ODbL-1.0.txt'), FIXTURE_NOTICE);
  writeFileSync(pinPath, JSON.stringify(pin, null, 2));

  return {
    root,
    /** Rewrite the pin, as a handler editing `tools/data-manifest.json` would. */
    pin(mutate: (pin: Pin) => void) {
      const next = JSON.parse(readFileSync(pinPath, 'utf8')) as Pin;
      mutate(next);
      writeFileSync(pinPath, JSON.stringify(next, null, 2));
    },
    /** Rewrite the artefact's own provenance. */
    provenance(mutate: (provenance: Provenance) => void) {
      const path = join(root, 'data/shops.osm.json');
      const next = JSON.parse(readFileSync(path, 'utf8')) as Provenance;
      mutate(next);
      writeFileSync(path, JSON.stringify(next, null, 2));
    },
    present: (name: string) => join(root, name),
  };
}

/** Run the step the build runs, in that checkout. Always cleans up. */
function inCheckout<T>(root: string, run: () => T): T {
  try {
    return run();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function ensureData(root: string) {
  // Neither way of *producing* data may leak in from the developer's shell.
  const env = { ...process.env };
  delete env.OSM_PBF;
  delete env.TRUHIKER_DATA_URL;
  return spawnSync(process.execPath, [join(root, 'tools/ensure-data.mjs')], { cwd: root, env, encoding: 'utf8' });
}

/** A checkout with resolvable dependencies and no `data/`: the container's start. */
function preflightCheckout() {
  const root = mkdtempSync(join(tmpdir(), 'truhiker-preflight-'));
  mkdirSync(join(root, 'tools'), { recursive: true });
  cpSync(join(REPO, 'tools/preflight.mjs'), join(root, 'tools/preflight.mjs'));
  for (const name of ['vite', 'typescript', 'vitest']) {
    mkdirSync(join(root, 'node_modules', name), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', name, 'package.json'),
      JSON.stringify({ name, version: '0.0.0', main: 'index.js' }),
    );
    writeFileSync(join(root, 'node_modules', name, 'index.js'), '');
  }
  return root;
}

function preflight(
  root: string,
  env: { OSM_PBF?: string; TRUHIKER_DATA_URL?: string; WORKERS_CI?: string },
) {
  const merged = { ...process.env, ...env };
  delete merged.OSM_PBF;
  delete merged.TRUHIKER_DATA_URL;
  delete merged.WORKERS_CI;
  Object.assign(merged, env);
  return spawnSync(process.execPath, [join(root, 'tools/preflight.mjs')], {
    cwd: root,
    env: merged,
    encoding: 'utf8',
  });
}

describe('the build data step (ensure-data)', () => {
  it('accepts the pinned artefact, ships a produced one it can vouch for, and refuses damaged, nearly empty, older or absent data', () => {
    // 1. The pinned artefact: verified against the pin and silent about it.
    const pinned = checkout();
    inCheckout(pinned.root, () => {
      const ok = ensureData(pinned.root);
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain('shops.osm.bin present and pinned');
      expect(ok.stderr).toBe('');
      // The pin check is what passes here; the notice step prints "present and
      // pinned" too, so stdout alone would not tell the two apart.
      expect(ok.stdout).not.toContain('differs from');
    });

    // 2. A producer run wrote a newer extract than the commit describes (D23): the
    //    pin cannot match, and still the build must ship it — saying so.
    const drifted = checkout({ provenance: { source: { extractDate: '2026-11-01' } } });
    inCheckout(drifted.root, () => {
      drifted.pin((pin) => {
        pin.artefacts[0].sha256 = 'f'.repeat(64);
      });
      const warn = ensureData(drifted.root);
      expect(warn.status).toBe(0);
      expect(warn.stderr).toContain('is from a different extract than the pin');
      expect(warn.stderr).toContain('2026-11-01');
      expect(warn.stderr).toContain('tools/data-manifest.json');
    });

    // 3. Same drift, but the provenance describes an index of zero points. A valid,
    //    nearly empty file is the failure that reads on screen as "there are no
    //    shops in Norway" (D7), so plausibility is checked before anything ships.
    const empty = checkout();
    inCheckout(empty.root, () => {
      empty.pin((pin) => {
        pin.artefacts[0].sha256 = 'f'.repeat(64);
      });
      empty.provenance((provenance) => {
        provenance.counts.total = 0;
      });
      const bad = ensureData(empty.root);
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain('nearly empty');
      expect(bad.stderr).toContain('no shops in Norway');
    });

    // 4. The pinned bytes with a provenance that disagrees on the count is not
    //    drift: it is the pin's own content check failing, which stays fatal.
    const miscounted = checkout();
    inCheckout(miscounted.root, () => {
      miscounted.pin((pin) => {
        pin.artefacts[0].counts.total = 999;
      });
      const bad = ensureData(miscounted.root);
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain('is the pinned artefact');
    });

    // 5. A file that agrees with neither the pin nor its own provenance is damaged,
    //    and an artefact nobody can vouch for is the one thing that must not ship.
    const damaged = checkout();
    inCheckout(damaged.root, () => {
      damaged.pin((pin) => {
        pin.artefacts[0].sha256 = 'f'.repeat(64);
      });
      appendFileSync(damaged.present('data/shops.osm.bin'), Buffer.from('\0'));
      const bad = ensureData(damaged.root);
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain('matches neither the committed pin');
    });

    // 6. An extract older than the pin describes would present last month's data as
    //    this month's, so it is refused rather than warned about.
    const older = checkout({ provenance: { source: { extractDate: '2026-01-01' } } });
    inCheckout(older.root, () => {
      older.pin((pin) => {
        pin.artefacts[0].sha256 = 'f'.repeat(64);
      });
      const bad = ensureData(older.root);
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain('older than the pin');
    });

    // 7. Provenance missing: nothing can date the file, so nothing ships it.
    const noProvenance = checkout();
    inCheckout(noProvenance.root, () => {
      rmSync(noProvenance.present('data/shops.osm.json'));
      const bad = ensureData(noProvenance.root);
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain('has no shops.osm.json beside it');
    });

    // 8. Nothing on disk and nowhere to fetch from: fail, naming the ways to get it.
    const absent = checkout();
    inCheckout(absent.root, () => {
      rmSync(absent.present('data'), { recursive: true, force: true });
      const bad = ensureData(absent.root);
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain('data:build');
      expect(bad.stderr).toContain('TRUHIKER_DATA_URL');
    });
  });

  it('lets a fresh checkout through preflight when the build is what creates data/', () => {
    // The deploy blocker: a container starts with no `data/` and the step that makes
    // it is the *next* one, so preflight may only refuse when nothing can produce it.
    const root = preflightCheckout();
    inCheckout(root, () => {
      // No data, no source: refuse, and the advice is for the data, not for `npm ci`
      // (dependencies are installed and `npm ci` would change nothing).
      const bare = preflight(root, {});
      expect(bare.status).toBe(1);
      expect(bare.stderr).toContain('data/ is missing');
      expect(bare.stderr).toContain('creates `data/`');

      // A published copy to fetch, an extract to build from, or a Workers build
      // container (whose build step produces the data — D23): all three are the step
      // after preflight, so all three let it through.
      expect(preflight(root, { TRUHIKER_DATA_URL: 'https://example.invalid/data' }).status).toBe(0);
      expect(preflight(root, { WORKERS_CI: '1' }).status).toBe(0);
      const pbf = join(root, 'norway-latest.osm.pbf');
      writeFileSync(pbf, 'not a real pbf, but an extract-shaped file');
      expect(preflight(root, { OSM_PBF: pbf }).status).toBe(0);

      // Neither may be taken at its word: a blank URL is not a URL, and a directory
      // is not an extract (both would fail deeper, inside the build).
      expect(preflight(root, { TRUHIKER_DATA_URL: '   ' }).status).toBe(1);
      expect(preflight(root, { OSM_PBF: tmpdir() }).status).toBe(1);
      expect(preflight(root, { OSM_PBF: join(root, 'missing.osm.pbf') }).status).toBe(1);

      // And with `data/` on disk, nothing is asked of the environment at all.
      mkdirSync(join(root, 'data'));
      expect(preflight(root, {}).status).toBe(0);
    });
  });
});
