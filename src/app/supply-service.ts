/**
 * Where the resupply points come from, and what happens when a source is down.
 *
 * Two very different sources, deliberately kept apart:
 *
 *  - the **bundled shop index** (`data/shops.osm.bin`, ODbL) is loaded lazily on
 *    first open and cached for the session. A failure is fatal for the panel and
 *    is reported as such: an empty list would read as "no shops here", which is
 *    the one thing it must never say;
 *  - the **huts** come live from Turrutebasen (CC BY 4.0 ©Kartverket) and can
 *    fail independently. A failed hut query is a *partial* result with the
 *    reason attached, never a blank panel.
 *
 * The index is fetched the first time the map needs places — which is when it
 * first settles on a view, because the shops are drawn whether or not the panel
 * is open (D20). It is 175 KB, loaded once, then served from memory.
 */

import type { LonLat } from '../core/geo';
import {
  DEFAULT_HUT_RADIUS_M,
  candidateKey,
  fetchHutsAlong,
  fetchHutsInBounds,
  loadShopIndex,
  type LonLatBBox,
  type ResupplyCandidate,
  type ShopIndex,
} from '../resupply';

interface SupplyResult {
  /** Shops, fuel, post and huts, sorted by distance along the route. */
  readonly candidates: readonly ResupplyCandidate[];
  /** ISO label of the bundled extract (the binary carries no timestamp). */
  readonly indexBuiltAt: string;
  /** Points in the bundled index, not on this route. */
  readonly indexCount: number;
  /** Why the live hut query failed, when it did. */
  readonly hutsError: string | null;
  /** ISO timestamp of this query. */
  readonly fetchedAt: string;
}

/** What the map needs for "show me the shops and huts around here". */
export interface ViewBounds {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
  readonly zoom: number;
}

export interface PlacesResult {
  /**
   * Points inside the covered box — the view plus the overscan margin
   * (`placesDrawBounds`). `alongRouteM` is 0: there is no route in play.
   */
  readonly places: readonly ResupplyCandidate[];
  readonly hutsError: string | null;
}

/** Huts are live WFS: only ask once the view is small enough to be worth it. */
export const HUT_VIEW_MIN_ZOOM = 12;
/** A hut answer is reused for this long before the box is asked again. */
const VIEW_HUTS_TTL_MS = 5 * 60_000;

/**
 * How much bigger than the view the place query is: 1.3 adds 15 % of the view's
 * span on every side.
 *
 * The margin is what keeps the layer still. Without it the answer covers exactly
 * the view, so a pan of one pixel changes the box and the drawn set with it; with
 * it, a glyph that is already on screen stays on screen until the map has moved a
 * sixth of a screen past it.
 */
export const PLACES_OVERSCAN = 1.3;

/**
 * Absolute ceiling on points handed to the GeoJSON source.
 *
 * This is a safety valve, **not a sampling policy**: it sits above the whole
 * index (8,571), so in practice every shop in the covered box is drawn. A
 * zoom-scaled sample was tried and removed — it made the layer change shape
 * whenever the view moved, so panning dropped and re-placed every glyph.
 */
export const PLACES_MAX_POINTS = 10_000;

/** The box `placesIn()` covers for a view: the view plus the overscan margin. */
export function placesDrawBounds(view: ViewBounds): ViewBounds {
  const padLat = ((view.north - view.south) * (PLACES_OVERSCAN - 1)) / 2;
  const padLon = ((view.east - view.west) * (PLACES_OVERSCAN - 1)) / 2;
  return {
    west: Math.max(-180, view.west - padLon),
    south: Math.max(-90, view.south - padLat),
    east: Math.min(180, view.east + padLon),
    north: Math.min(90, view.north + padLat),
    zoom: view.zoom,
  };
}

/**
 * Merge a fresh answer with the points already drawn.
 *
 * Everything from `previous` that is still inside `box` is kept, so a pan adds
 * and drops glyphs at its edges instead of replacing the whole layer. Replacing
 * it meant every symbol was re-placed on every camera settle — the layer blinked:
 * the shops in front of you disappeared and came back as "new" ones.
 *
 * The fresh answer wins on a duplicate key: it is the newer reading of the same
 * place.
 */
export function mergePlacesForView(
  previous: readonly ResupplyCandidate[],
  fresh: readonly ResupplyCandidate[],
  box: ViewBounds,
): ResupplyCandidate[] {
  const inside = (candidate: ResupplyCandidate): boolean =>
    candidate.point.lon >= box.west &&
    candidate.point.lon <= box.east &&
    candidate.point.lat >= box.south &&
    candidate.point.lat <= box.north;

  const seen = new Set<string>();
  const out: ResupplyCandidate[] = [];
  for (const candidate of [...fresh, ...previous]) {
    if (!inside(candidate)) continue;
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

interface SupplyDeps {
  readonly fetchImpl: typeof fetch;
  /** Injectable for tests and for a different data file. */
  readonly loadIndex?: (fetchImpl: typeof fetch) => Promise<ShopIndex>;
  readonly loadHuts?: (
    route: readonly LonLat[],
    opts: { radiusM: number; fetchImpl: typeof fetch },
  ) => Promise<ResupplyCandidate[]>;
  /** The view query: a box, not a corridor (see `fetchHutsInBounds`). */
  readonly loadHutsInBounds?: (
    bounds: LonLatBBox,
    opts: { fetchImpl: typeof fetch },
  ) => Promise<ResupplyCandidate[]>;
  readonly now?: () => Date;
}

export class SupplyService {
  private readonly deps: SupplyDeps;
  private index: ShopIndex | null = null;
  private pending: Promise<ShopIndex> | null = null;
  /** Hut answers per rounded view box, so a pan back and forth is free. */
  private readonly viewHuts = new Map<
    string,
    { at: number; huts: ResupplyCandidate[]; error: string | null }
  >();

  constructor(deps: SupplyDeps) {
    this.deps = deps;
  }

  /** True once the bundled file has been parsed (so the UI can say "lazy"). */
  get indexLoaded(): boolean {
    return this.index !== null;
  }

  get indexCount(): number | null {
    return this.index?.count ?? null;
  }

  /**
   * The bundled index, fetched once.
   *
   * A rejected promise is not cached: the panel's retry button must be able to
   * try again after a network blip.
   */
  async shopIndex(): Promise<ShopIndex> {
    if (this.index) return this.index;
    if (this.pending) return this.pending;
    const load = this.deps.loadIndex ?? loadShopIndex;
    this.pending = load(this.deps.fetchImpl).then(
      (index) => {
        this.index = index;
        this.pending = null;
        return index;
      },
      (error: unknown) => {
        this.pending = null;
        throw error;
      },
    );
    return this.pending;
  }

  /**
   * Places to draw for the current view, route or no route.
   *
   * Shops come from the bundled index and are complete for Norway — the scan is
   * local and instant. Huts are a live WFS query, so they are only asked for at
   * `HUT_VIEW_MIN_ZOOM` and above, where the box is small; below that the map
   * shows shops only, and the panel still has the route's own hut query.
   *
   * The answer covers `placesDrawBounds(view)` — the view plus a margin — for the
   * reasons in `PLACES_OVERSCAN`. Nothing here depends on the *camera* having
   * settled: the caller owns that debounce.
   */
  async placesIn(view: ViewBounds): Promise<PlacesResult> {
    const index = await this.shopIndex();
    const bounds = placesDrawBounds(view);
    // Every shop in the covered box. The source's clustering is what compacts a
    // country view; sampling here instead is what made the layer change shape —
    // and blink — whenever the view moved.
    const places: ResupplyCandidate[] = index.within(bounds, PLACES_MAX_POINTS);
    if (view.zoom < HUT_VIEW_MIN_ZOOM) return { places, hutsError: null };

    const cacheKey = `${bounds.west.toFixed(2)},${bounds.south.toFixed(2)},${bounds.east.toFixed(2)},${bounds.north.toFixed(2)}`;
    const cached = this.viewHuts.get(cacheKey);
    const nowMs = (this.deps.now ? this.deps.now() : new Date()).getTime();
    if (cached && nowMs - cached.at < VIEW_HUTS_TTL_MS) {
      return { places: [...places, ...cached.huts], hutsError: cached.error };
    }

    const loadHuts = this.deps.loadHutsInBounds ?? fetchHutsInBounds;
    let huts: ResupplyCandidate[] = [];
    let hutsError: string | null = null;
    try {
      // The box *is* the query. Handing the corners to the corridor client would
      // filter against the box's diagonal and drop the huts in its corners.
      huts = await loadHuts(
        { minLon: bounds.west, minLat: bounds.south, maxLon: bounds.east, maxLat: bounds.north },
        { fetchImpl: this.deps.fetchImpl },
      );
    } catch (error) {
      hutsError = error instanceof Error ? error.message : String(error);
    }
    this.viewHuts.set(cacheKey, { at: nowMs, huts, error: hutsError });
    return { places: [...places, ...huts], hutsError };
  }

  /**
   * Correlate the route with both sources.
   *
   * Throws only when the shop index is unusable. A hut failure is captured in
   * `hutsError` and the shops are still returned.
   */
  async corridor(
    route: readonly LonLat[],
    radiusM: number,
    hutRadiusM: number = Math.min(radiusM, DEFAULT_HUT_RADIUS_M),
  ): Promise<SupplyResult> {
    if (route.length < 2) throw new Error('a route needs at least two points');
    if (!(radiusM > 0)) throw new RangeError(`invalid corridor radius: ${radiusM}`);
    if (!(hutRadiusM > 0)) throw new RangeError(`invalid hut radius: ${hutRadiusM}`);
    const index = await this.shopIndex();
    const loadHuts = this.deps.loadHuts ?? fetchHutsAlong;

    let huts: ResupplyCandidate[] = [];
    let hutsError: string | null = null;
    try {
      huts = await loadHuts(route, { radiusM: hutRadiusM, fetchImpl: this.deps.fetchImpl });
    } catch (error) {
      hutsError = error instanceof Error ? error.message : String(error);
    }

    const candidates = [...index.alongRoute(route, radiusM), ...huts].sort(
      (a, b) => a.alongRouteM - b.alongRouteM,
    );
    const now = this.deps.now ? this.deps.now() : new Date();
    return {
      candidates,
      indexBuiltAt: index.builtAt,
      indexCount: index.count,
      hutsError,
      fetchedAt: now.toISOString(),
    };
  }
}
