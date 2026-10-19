/**
 * CLI: GPX → elevation profile JSON.
 *
 *   npm run profile -- route.gpx
 *   npm run profile -- route.gpx --spacing 50 --cell 5000 --pixel 10
 *
 * Hits the live Kartverket DTM service (hoydedata.no). Every track in the file
 * is profiled separately; tracks are never merged.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { HoydedataDem } from '../core/dem';
import { resample, type LonLat } from '../core/geo';
import { parseGpx, type GpxTrack } from '../core/gpx';
import { buildProfile, type ProfileSample } from '../core/profile';

interface CliOptions {
  file: string;
  spacingM: number;
  cellSizeM: number;
  pixelSizeM: number;
  hysteresisM: number;
}

const USAGE = `Usage: npm run profile -- <file.gpx> [options]

Options:
  --spacing <m>     resample spacing in metres (default 25)
  --cell <m>        DEM window cell size in metres (default 5000)
  --pixel <m>       DEM resolution in metres per pixel (default 10)
  --hysteresis <m>  ascent/descent hysteresis threshold (default 5)
  -h, --help        show this help`;

function fail(message: string): never {
  console.error(`profile: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { file: '', spacingM: 25, cellSizeM: 5000, pixelSizeM: 10, hysteresisM: 5 };

  const numericFlag = (name: string, index: number): number => {
    const raw = argv[index + 1];
    if (raw === undefined) fail(`${name} needs a value`);
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value) || value <= 0) fail(`${name} must be a positive number, got "${raw}"`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === '--spacing') {
      options.spacingM = numericFlag(arg, i);
      i++;
    } else if (arg === '--cell') {
      options.cellSizeM = numericFlag(arg, i);
      i++;
    } else if (arg === '--pixel') {
      options.pixelSizeM = numericFlag(arg, i);
      i++;
    } else if (arg === '--hysteresis') {
      options.hysteresisM = numericFlag(arg, i);
      i++;
    } else if (arg.startsWith('-')) {
      fail(`unknown option ${arg}\n\n${USAGE}`);
    } else if (!options.file) {
      options.file = arg;
    } else {
      fail(`unexpected argument ${arg} (only one GPX file can be profiled)`);
    }
  }

  if (!options.file) fail(`no GPX file given\n\n${USAGE}`);
  return options;
}

function round(value: number, decimals = 1): number {
  if (!Number.isFinite(value)) return Number.NaN;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function formatSamples(samples: readonly ProfileSample[]): ProfileSample[] {
  return samples.map((s) => ({ d: round(s.d), ele: round(s.ele) }));
}

interface TrackProfileResult {
  name: string | null;
  distanceM: number;
  ascentM: number;
  descentM: number;
  minEleM: number;
  maxEleM: number;
  sampleCount: number;
  maxGradePct: number;
  minGradePct: number;
  filledNoDataSamples: number;
  noDataSourceSamples: number;
  firstSamples: Array<{ d: number; ele: number }>;
  lastSamples: Array<{ d: number; ele: number }>;
  totalGpxPoints: number;
}

function profileTrack(
  track: GpxTrack,
  coords: LonLat[],
  elevations: number[],
  options: CliOptions,
): TrackProfileResult {
  const profile = buildProfile(coords, elevations, { hysteresisM: options.hysteresisM });

  let minEle = Number.POSITIVE_INFINITY;
  let maxEle = Number.NEGATIVE_INFINITY;
  for (const sample of profile.samples) {
    if (!Number.isFinite(sample.ele)) continue;
    if (sample.ele < minEle) minEle = sample.ele;
    if (sample.ele > maxEle) maxEle = sample.ele;
  }

  if (!Number.isFinite(minEle) || !Number.isFinite(maxEle)) {
    throw new Error(
      `track${track.name ? ` "${track.name}"` : ''} has no valid (non-NoData) DEM elevations`,
    );
  }

  const noDataSource = elevations.filter((e) => !Number.isFinite(e)).length;

  return {
    name: track.name ?? null,
    distanceM: round(profile.distanceM),
    ascentM: round(profile.ascentM),
    descentM: round(profile.descentM),
    minEleM: round(minEle),
    maxEleM: round(maxEle),
    sampleCount: profile.samples.length,
    maxGradePct: round(profile.maxGradePct),
    minGradePct: round(profile.minGradePct),
    filledNoDataSamples: profile.filledSamples,
    noDataSourceSamples: noDataSource,
    firstSamples: formatSamples(profile.samples.slice(0, 5)),
    lastSamples: formatSamples(profile.samples.slice(-5)),
    totalGpxPoints: track.points.length,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();

  let xml: string;
  try {
    xml = readFileSync(options.file, 'utf8');
  } catch (error) {
    fail(`cannot read ${options.file}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let gpx;
  try {
    gpx = parseGpx(xml);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const routes: GpxTrack[] = gpx.tracks.length > 0 ? gpx.tracks : gpx.routes;
  if (routes.length === 0) {
    fail('GPX contains no tracks or routes (only waypoints)');
  }

  // One DEM instance for all tracks: windows shared between tracks via the cache.
  const source = new HoydedataDem({
    cellSizeM: options.cellSizeM,
    pixelSizeM: options.pixelSizeM,
  });

  const prepared = routes
    .filter((track) => {
      if (track.points.length >= 2) return true;
      console.error(`profile: skipping track${track.name ? ` "${track.name}"` : ''}: fewer than 2 points`);
      return false;
    })
    .map((track) => ({
      track,
      coords: resample(
        track.points.map((p) => ({ lon: p.lon, lat: p.lat })),
        options.spacingM,
      ),
    }));

  if (prepared.length === 0) fail('no track had at least two points');

  // Sample every track in one call: windows shared by different tracks are
  // fetched once and the concurrency limit is used across the whole file.
  const allCoords = prepared.flatMap((entry) => entry.coords);
  const allElevations = await source.sampleElevations(allCoords);

  const tracks: TrackProfileResult[] = [];
  let offset = 0;
  let totalDistance = 0;
  let totalAscent = 0;
  let totalDescent = 0;
  let globalMin = Number.POSITIVE_INFINITY;
  let globalMax = Number.NEGATIVE_INFINITY;
  let totalSamples = 0;

  for (const { track, coords } of prepared) {
    const elevations = allElevations.slice(offset, offset + coords.length);
    offset += coords.length;

    const result = profileTrack(track, coords, elevations, options);
    tracks.push(result);

    totalDistance += result.distanceM;
    totalAscent += result.ascentM;
    totalDescent += result.descentM;
    globalMin = Math.min(globalMin, result.minEleM);
    globalMax = Math.max(globalMax, result.maxEleM);
    totalSamples += result.sampleCount;
  }

  const output = {
    file: basename(options.file),
    generatedAt: new Date().toISOString(),
    elevationSource: 'Kartverket DTM (bare earth) via hoydedata.no ImageServer, EPSG:25833',
    attribution: '©Kartverket (CC BY 4.0)',
    parameters: {
      resampleSpacingM: options.spacingM,
      demCellSizeM: options.cellSizeM,
      demPixelSizeM: options.pixelSizeM,
      hysteresisM: options.hysteresisM,
      medianWindow: 3,
      gradeWindowM: 100,
    },
    summary: {
      trackCount: tracks.length,
      distanceM: round(totalDistance),
      ascentM: round(totalAscent),
      descentM: round(totalDescent),
      minEleM: round(globalMin),
      maxEleM: round(globalMax),
      sampleCount: totalSamples,
      demWindowsCached: source.cacheSize,
      elapsedMs: Date.now() - started,
    },
    // Each GPX track is reported separately — never merged.
    tracks,
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error: unknown) => {
  console.error(`profile: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) console.error(error.stack);
  process.exit(1);
});
