/**
 * The trail network for one routing request.
 *
 * Fetches Turrutebasen lines for the box that covers both endpoints plus a
 * margin, but only within explicit limits. The WFS returns whole features, not
 * geometry clipped to the box, so a permissive box can pull in an entire
 * region; the hit count is checked before the features are downloaded.
 *
 * Failures are typed and precede any graph work: an oversized request is
 * refused without a network call, and a failed count or fetch is reported as
 * unavailable rather than as an empty network (which would read as "no trails").
 */
import type { LonLat } from '../core/geo';
import {
  TurrutebasenClient,
  type LonLatBBox,
  type TurruteLine,
} from '../snap/wfs';
import type { TrailLine } from './trail-graph';

export type TrailNetworkFailureCode = 'area-too-large' | 'too-many-features' | 'network-unavailable';

export type TrailNetworkResult =
  | {
      readonly kind: 'ok';
      readonly lines: readonly TrailLine[];
      /** The box actually requested (expanded by the margin). */
      readonly bbox: LonLatBBox;
      readonly featureCount: number;
    }
  | { readonly kind: 'failed'; readonly code: TrailNetworkFailureCode; readonly detail: string | null };

export interface LoadTrailNetworkOptions {
  /** Padding around the endpoints, metres. Default 2,000. */
  readonly marginM?: number;
  /** Maximum box side, degrees. Default 1.5 (~165 km). */
  readonly maxSideDeg?: number;
  /** Maximum box area, square degrees. Default 1.5. */
  readonly maxAreaDeg2?: number;
  /** Refuse before downloading if the WFS reports more features. Default 5,000. */
  readonly maxFeatures?: number;
  /** Injectable client (tests) or the shared one (app). */
  readonly client?: Pick<TurrutebasenClient, 'fetchBox' | 'fetchHits'>;
  /** Per-request timeout passed to the client. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Session cache; pass one to share results across calls. */
  readonly cache?: Map<string, TrailNetworkResult>;
}

const DEFAULT_MARGIN_M = 2_000;
const DEFAULT_MAX_SIDE_DEG = 1.5;
const DEFAULT_MAX_AREA_DEG2 = 1.5;
const DEFAULT_MAX_FEATURES = 5_000;
const DEFAULT_TIMEOUT_MS = 20_000;

/** Process-wide cache: a routing attempt for the same box does not pay twice. */
const sharedCache = new Map<string, TrailNetworkResult>();

function expand(start: LonLat, end: LonLat, marginM: number): LonLatBBox {
  const midLat = (start.lat + end.lat) / 2;
  const latMargin = marginM / 111_320;
  const lonMargin = marginM / (111_320 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
  return {
    minLon: Math.min(start.lon, end.lon) - lonMargin,
    maxLon: Math.max(start.lon, end.lon) + lonMargin,
    minLat: Math.min(start.lat, end.lat) - latMargin,
    maxLat: Math.max(start.lat, end.lat) + latMargin,
  };
}

function keyOf(bbox: LonLatBBox): string {
  return [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat].map((value) => value.toFixed(6)).join(',');
}

function toTrailLines(lines: readonly TurruteLine[]): TrailLine[] {
  const out: TrailLine[] = [];
  for (const line of lines) {
    if (line.coords.length >= 2) out.push({ id: line.id, points: line.coords });
  }
  return out;
}

/**
 * Fetch the trail network around two points.
 *
 * The endpoint radius is not checked here: `routeBetweenPoints` decides whether
 * the network is close enough. This loader only answers "is there a network to
 * route on, and is it small enough to download".
 */
export async function loadTrailNetwork(
  start: LonLat,
  end: LonLat,
  options: LoadTrailNetworkOptions = {},
): Promise<TrailNetworkResult> {
  const marginM = options.marginM ?? DEFAULT_MARGIN_M;
  const maxSide = options.maxSideDeg ?? DEFAULT_MAX_SIDE_DEG;
  const maxArea = options.maxAreaDeg2 ?? DEFAULT_MAX_AREA_DEG2;
  const maxFeatures = options.maxFeatures ?? DEFAULT_MAX_FEATURES;
  if (!(marginM >= 0)) throw new RangeError(`marginM must be >= 0, got ${marginM}`);

  const bbox = expand(start, end, marginM);
  const width = bbox.maxLon - bbox.minLon;
  const height = bbox.maxLat - bbox.minLat;
  if (width > maxSide || height > maxSide || width * height > maxArea) {
    return {
      kind: 'failed',
      code: 'area-too-large',
      detail: `${width.toFixed(2)}° × ${height.toFixed(2)}°`,
    };
  }

  const cache = options.cache ?? sharedCache;
  const key = keyOf(bbox);
  const cached = cache.get(key);
  if (cached) {
    // A smaller cap on a later call must not be satisfied by a larger cached
    // result; the limit is part of the contract, not just a pre-fetch guard.
    if (cached.kind === 'ok' && cached.featureCount > maxFeatures) {
      return { kind: 'failed', code: 'too-many-features', detail: `${cached.featureCount} features` };
    }
    return cached;
  }

  const client = options.client ?? new TurrutebasenClient({ timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  const requestOptions = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: options.signal,
  };

  let matched: number | undefined;
  try {
    matched = await client.fetchHits(bbox, requestOptions);
  } catch (error) {
    return { kind: 'failed', code: 'network-unavailable', detail: messageOf(error) };
  }
  if (matched !== undefined && matched > maxFeatures) {
    return {
      kind: 'failed',
      code: 'too-many-features',
      detail: `${matched} features`,
    };
  }

  let box;
  try {
    box = await client.fetchBox(bbox, requestOptions);
  } catch (error) {
    return { kind: 'failed', code: 'network-unavailable', detail: messageOf(error) };
  }

  // The hit count can be "unknown" or stale; the parsed feature count is the
  // second, authoritative cap before the graph is built.
  if (box.featureCount > maxFeatures) {
    return { kind: 'failed', code: 'too-many-features', detail: `${box.featureCount} features` };
  }

  const result: TrailNetworkResult = {
    kind: 'ok',
    lines: toTrailLines(box.lines),
    bbox,
    featureCount: box.featureCount,
  };
  cache.set(key, result);
  return result;
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0]?.slice(0, 200) ?? 'unknown error';
}
