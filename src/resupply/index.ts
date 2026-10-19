/**
 * `src/resupply` — where you can resupply on a route, what you carry between
 * those points, and what the plan refuses to assume.
 *
 * Three parts, one surface:
 *
 * ```
 * corridor.ts   metric projection of a point onto a route polyline
 * shopIndex.ts  data/shops.osm.bin (ODbL, bundled) → corridor query
 * huts.ts       Turrutebasen app:RuteInfoPunkt (CC BY 4.0 ©Kartverket) → candidates
 * plan.ts       candidates + Trip → src/plan/resupply.ts + src/plan/energy.ts
 * ```
 *
 * The honesty rules are not comments, they are behaviour:
 *
 * - a **hut** has no confirmed food, so it closes no gap unless the caller opts
 *   in (`hutsSellFood: true`), and the plan always says which way it went;
 * - an **unmanned fuel station** counts for nothing;
 * - a bundled point is **never** "open": the binary stores only whether OSM had
 *   an `opening_hours` tag, not its text;
 * - `kind: 'hut'` candidates carry **no opening hours** at all.
 *
 * No UI, no DOM, no storage. `loadShopIndex` and `fetchHutsAlong` are the only
 * code that touches the network, and both take an injectable `fetchImpl`.
 */

import type { LonLat } from '../core/geo';
import type { Trip } from '../contracts';

/** A point where an item — food, fuel, a parcel, a bed — might be available. */
export interface ResupplyCandidate {
  readonly kind:
    | 'supermarket'
    | 'convenience'
    | 'general'
    | 'grocery'
    | 'fuel'
    | 'post'
    | 'parcel'
    | 'hut';
  readonly name: string;
  readonly point: LonLat;
  /** Metres from the start of the route polyline. */
  readonly alongRouteM: number;
  /** Perpendicular distance from the route, metres. */
  readonly detourM: number;
  /**
   * Where the record came from:
   * - `osm` — the bundled OSM extract (ODbL);
   * - `chain-verified` — matched against a chain's own store list (never
   *   produced today; no chain join exists);
   * - `curated` — a curated source: Turrutebasen huts.
   */
  readonly evidence: 'osm' | 'chain-verified' | 'curated';
  /**
   * `opening_hours` text, when it is actually known. **Always `undefined` for
   * bundled OSM points**: the binary stores only a presence bit, never the
   * value, so this must not be presented as "open".
   */
  readonly openingHours?: string;
  /** True when OSM carried `opening_hours` (its value was not stored). */
  readonly hoursRecorded?: boolean;
  /** Fuel only: the extractor's "looks unmanned" heuristic. Never a fact. */
  readonly unmanned?: boolean;
}

/** The bundled shop index. Parsed once, queried many times. */
export interface ShopIndex {
  readonly count: number;
  /** ISO timestamp the data is labelled with; the binary itself stores none. */
  readonly builtAt: string;
  /** Candidates within `radiusM` of the polyline, sorted by `alongRouteM`. */
  alongRoute(points: readonly LonLat[], radiusM: number): ResupplyCandidate[];
  /** Candidates within `radiusM` of a point, sorted by distance. */
  near(point: LonLat, radiusM: number): ResupplyCandidate[];
}

export {
  COMMITTED_INDEX_BUILT_AT,
  SHOP_INDEX_MAGIC,
  SHOP_INDEX_PATH,
  ShopIndexFormatError,
  loadShopIndex,
  parseShopIndex,
  type ShopIndexErrorReason,
} from './shopIndex';

export {
  DEFAULT_HUT_RADIUS_M,
  HUT_TYPE_NAME,
  fetchHutsAlong,
  hutGetFeatureUrl,
  hutQueryBbox,
  parseHutGml,
  type FetchHutsOptions,
  type HutPoint,
} from './huts';

/**
 * Are this candidate's opening hours confirmed?
 *
 * `false` for every bundled OSM point and every Turrutebasen hut: the binary
 * stores only *whether* OSM had an `opening_hours` tag (never the text), and the
 * hut service serves no hours at all. Callers must not present a point as "open"
 * on the strength of this module.
 */
export function hasVerifiedHours(candidate: ResupplyCandidate): boolean {
  return candidate.openingHours !== undefined;
}

export {
  M_PER_DEG_LAT,
  M_PER_DEG_LON,
  RouteCorridor,
  lonPadDeg,
  type CorridorProjection,
} from './corridor';

export {
  planResupplyForTrip,
  type ResupplyAnchor,
  type ResupplyGap,
  type ResupplyLeg,
  type ResupplyPlan,
  type ResupplyPlanOptions,
} from './plan';

// Re-exported for callers that hold only the resupply surface.
export type { Trip };
