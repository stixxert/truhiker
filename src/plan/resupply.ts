/**
 * Resupply planning for a **general** route.
 *
 * The engine never assumes a shop exists because a lookup was missing. Every
 * conservative default is deliberate:
 *
 * - an **unknown hut** has no food (`sellsFood` must be true);
 * - `ubetjent` never has food, not even gas;
 * - a **fuel station without `hasShop`** is an automat, not a shop;
 * - a `post` point is not a food source — only a mail-drop destination;
 * - an `osm`-confidence point with **no hours** is flagged "verify";
 * - `openAt()` returns `unknown` when it cannot parse the hours, rather than
 *   guessing "open".
 *
 * Two support models are first-class, selected per trip:
 *
 * **carry-all** — legs between usable food points; the maximum uninterrupted
 * stretch is reported as a `gap`, and every leg longer than `maxCarryDays`
 * (default 7) is flagged with the food mass it requires.
 *
 * **mail-drops** — for each parcel point:
 *
 *     arrival   = legStart + N days
 *     shipBy    = arrival − 5
 *     notBefore = arrival − 7   (parcel)  /  arrival − 21  (poste restante)
 *
 * and a parcel whose `shipBy` precedes the trip start is flagged: it simply
 * could not have been posted in time.
 */

import {
  DEFAULT_MIX,
  costFor,
  foodWeightFor,
  type FoodMix,
} from './nutrition';

// ---------------------------------------------------------------------------
// Geometry (local, dependency-free)
// ---------------------------------------------------------------------------

/** WGS84 longitude/latitude in decimal degrees. Structurally a `LonLat`. */
export interface PlanPosition {
  readonly lon: number;
  readonly lat: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

/** Haversine distance in metres. */
export function distanceM(a: PlanPosition, b: PlanPosition): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const lat1 = a.lat * DEG;
  const lat2 = b.lat * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A route, minimally: geometry and/or a length, plus optional cumulative
 * distances. Accepts `Route` from `src/lib/route` structurally.
 */
export interface ResupplyRoute {
  readonly points?: readonly PlanPosition[];
  readonly distances?: readonly number[];
  readonly distanceM?: number;
}

function cumulative(route: ResupplyRoute): number[] {
  if (route.distances && route.distances.length === (route.points?.length ?? 0)) {
    return [...route.distances];
  }
  const points = route.points ?? [];
  const out: number[] = points.length > 0 ? [0] : [];
  for (let i = 1; i < points.length; i += 1) {
    out.push(out[i - 1] + distanceM(points[i - 1], points[i]));
  }
  return out;
}

/** Total route length, metres. Throws if the route has neither points nor length. */
export function routeLength(route: ResupplyRoute): number {
  if (route.distanceM !== undefined && Number.isFinite(route.distanceM)) {
    if (route.distanceM < 0) throw new Error(`invalid route distance: ${route.distanceM}`);
    return route.distanceM;
  }
  const points = route.points ?? [];
  if (points.length < 2) throw new Error('route needs points or distanceM');
  return cumulative(route)[points.length - 1];
}

interface Projection {
  readonly alongM: number;
  readonly offsetM: number;
}

/** Nearest point on the polyline: along-route distance and perpendicular offset. */
export function projectOntoRoute(route: ResupplyRoute, position: PlanPosition): Projection {
  const points = route.points ?? [];
  if (points.length === 0) throw new Error('cannot project onto a route without points');
  const distances = cumulative(route);
  if (points.length === 1) {
    return { alongM: 0, offsetM: distanceM(points[0], position) };
  }
  let best: Projection = {
    alongM: 0,
    offsetM: Number.POSITIVE_INFINITY,
  };
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const meanLat = ((a.lat + b.lat) / 2) * DEG;
    const mPerDegLat = 111_132;
    const mPerDegLon = 111_320 * Math.cos(meanLat);
    const bx = (b.lon - a.lon) * mPerDegLon;
    const by = (b.lat - a.lat) * mPerDegLat;
    const px = (position.lon - a.lon) * mPerDegLon;
    const py = (position.lat - a.lat) * mPerDegLat;
    const lengthSq = bx * bx + by * by;
    const t = lengthSq > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / lengthSq)) : 0;
    const dx = px - t * bx;
    const dy = py - t * by;
    const offset = Math.hypot(dx, dy);
    if (offset < best.offsetM) {
      const along = distances[i] + t * (distances[i + 1] - distances[i]);
      best = { alongM: along, offsetM: offset };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Point model
// ---------------------------------------------------------------------------

export type ResupplyKind =
  | 'supermarket'
  | 'convenience'
  | 'fuel'
  | 'post'
  | 'hut'
  | 'cache';

export type Confidence = 'osm' | 'chain-verified' | 'curated';
export type HutKind = 'betjent' | 'selvbetjent' | 'ubetjent';
export type PostKind = 'parcel' | 'poste-restante';
// Single source of truth: the contract. Imported for local use, re-exported so
// existing imports keep working.
import type { SupportModel } from '../contracts';
export type { SupportModel };
export type OpenState = 'unknown' | 'open' | 'closed';

export interface ResupplyPoint {
  readonly id: string;
  readonly kind: ResupplyKind;
  readonly position: PlanPosition;
  readonly name?: string;
  /**
   * OSM `opening_hours` syntax. Missing hours is *not* "always open": it is
   * "unknown", and an `osm`-confidence point without hours is flagged verify.
   */
  readonly hours?: string;
  readonly confidence: Confidence;
  /** ISO date (YYYY-MM-DD) of the last manual/chain verification. */
  readonly lastVerified?: string;
  /** Fuel only: true for a staffed station with a shop, false for an automat. */
  readonly hasShop?: boolean;
  /** Hut only: true when food really is sold (curated fact). Never inferred. */
  readonly sellsFood?: boolean;
  readonly hutKind?: HutKind;
  /** Post only. Defaults to `parcel` (7-day window). */
  readonly postKind?: PostKind;
  /**
   * Pre-computed along-route distance, for points that are already snapped.
   * When absent the point is projected onto the route geometry.
   */
  readonly routeDistanceM?: number;
}

const KIND_PRIORITY: Readonly<Record<ResupplyKind, number>> = {
  supermarket: 5,
  convenience: 4,
  cache: 3,
  fuel: 2,
  hut: 1,
  post: 0,
};

/**
 * Can this point be used to obtain food?
 *
 * Conservative by construction. Note that `post` is never a food source — a
 * Post i butikk counter may sit inside a shop, but the shop is the source and
 * must be modelled as one.
 */
export function isFoodSource(point: ResupplyPoint): boolean {
  switch (point.kind) {
    case 'supermarket':
    case 'convenience':
      return true;
    case 'fuel':
      return point.hasShop === true;
    case 'hut':
      return point.sellsFood === true && point.hutKind !== 'ubetjent';
    case 'cache':
      return true;
    case 'post':
      return false;
  }
}

// ---------------------------------------------------------------------------
// Opening hours
// ---------------------------------------------------------------------------

const DAY_NUMBER: Readonly<Record<string, number>> = {
  su: 0,
  mo: 1,
  tu: 2,
  we: 3,
  th: 4,
  fr: 5,
  sa: 6,
};

interface DayRule {
  readonly days: ReadonlySet<number>;
  /** Minutes since midnight, `[from, to)`; `to` may be 1440. Empty = closed. */
  readonly intervals: readonly (readonly [number, number])[];
}

function parseDaySpec(spec: string): Set<number> | null {
  const days = new Set<number>();
  for (const raw of spec.split(',')) {
    const token = raw.trim();
    if (!token) continue;
    const range = /^([A-Za-z]{2})-([A-Za-z]{2})$/.exec(token);
    if (range) {
      const start = DAY_NUMBER[range[1].toLowerCase()];
      const end = DAY_NUMBER[range[2].toLowerCase()];
      if (start === undefined || end === undefined) return null;
      // OSM day ranges wrap: Sa-Su is Saturday then Sunday.
      if (start <= end) {
        for (let day = start; day <= end; day += 1) days.add(day);
      } else {
        for (let day = start; day <= 6; day += 1) days.add(day);
        for (let day = 0; day <= end; day += 1) days.add(day);
      }
      continue;
    }
    const single = DAY_NUMBER[token.toLowerCase()];
    if (single === undefined) return null;
    days.add(single);
  }
  return days.size > 0 ? days : null;
}

function parseIntervals(spec: string): [number, number][] | null {
  const intervals: [number, number][] = [];
  const regex = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g;
  for (const match of spec.matchAll(regex)) {
    const from = Number(match[1]) * 60 + Number(match[2]);
    const to = Number(match[3]) * 60 + Number(match[4]);
    if (from > 1440 || to > 1440) return null;
    intervals.push([from, to]);
  }
  return intervals.length > 0 ? intervals : null;
}

/**
 * Parse the subset of OSM `opening_hours` that a shop row realistically
 * contains. Unsupported syntax returns `null` and `openAt()` answers `unknown`
 * — never "open".
 */
export function parseOpeningHours(hours: string): DayRule[] | null {
  const text = hours.trim();
  if (!text) return null;
  if (/^24\s*\/\s*7$/.test(text)) {
    return [{ days: new Set([0, 1, 2, 3, 4, 5, 6]), intervals: [[0, 1440]] }];
  }
  const rules: DayRule[] = [];
  for (const chunk of text.split(';')) {
    const part = chunk.trim();
    if (!part) continue;
    const match = /^([A-Za-z]{2}(?:\s*[-,]\s*[A-Za-z]{2})*)\s*(.*)$/.exec(part);
    if (!match) return null;
    const dayToken = match[1].replace(/\s+/g, '');
    // Public/school holidays are unsupported and irrelevant to a weekday check.
    if (/^(ph|sh)$/i.test(dayToken)) continue;
    const days = parseDaySpec(dayToken);
    if (!days) return null;
    const rest = match[2].trim().toLowerCase();
    if (!rest) return null;
    if (rest.startsWith('off') || rest.startsWith('closed')) {
      rules.push({ days, intervals: [] });
      continue;
    }
    if (rest.startsWith('24/7') || rest.startsWith('open')) {
      rules.push({ days, intervals: [[0, 1440]] });
      continue;
    }
    const intervals = parseIntervals(rest);
    if (!intervals) return null;
    rules.push({ days, intervals });
  }
  return rules.length > 0 ? rules : null;
}

/**
 * Is the point open on `date`?
 *
 * `unknown` when hours are absent or unsupported. The time of day is checked
 * when the Date carries one; a Date at exactly midnight is treated as a
 * date-only query ("is it open at all that day"). Day 0 is Sunday.
 *
 * Note: OSM defines `Su` as Sunday, so `Tu-Su` **includes** Sunday. A
 * `Mo-Sa` shop is the one that is closed on Sunday.
 */
export function openAt(
  point: Pick<ResupplyPoint, 'hours'>,
  date: Date,
): OpenState {
  if (!point.hours) return 'unknown';
  const rules = parseOpeningHours(point.hours);
  if (!rules) return 'unknown';
  const day = date.getDay();
  const previousDay = (day + 6) % 7;
  const timeKnown =
    !(
      date.getHours() === 0 &&
      date.getMinutes() === 0 &&
      date.getSeconds() === 0 &&
      date.getMilliseconds() === 0
    );
  const minutes = date.getHours() * 60 + date.getMinutes();
  let open = false;
  for (const rule of rules) {
    const today = rule.days.has(day);
    const yesterday = rule.days.has(previousDay);
    for (const [from, to] of rule.intervals) {
      if (from <= to) {
        if (!timeKnown) {
          if (today) return 'open';
          continue;
        }
        if (today && minutes >= from && minutes < to) open = true;
        continue;
      }
      // Overnight interval (e.g. Fr 22:00-02:00): the early hours belong to
      // the previous day's rule, which is how OSM reads it.
      if (!timeKnown) {
        if (today || yesterday) return 'open';
        continue;
      }
      if (today && minutes >= from) open = true;
      if (yesterday && minutes < to) open = true;
    }
  }
  // A day not named by any rule is closed (OSM semantics).
  return open ? 'open' : 'closed';
}

// ---------------------------------------------------------------------------
// Plan model
// ---------------------------------------------------------------------------

export type WarningSeverity = 'info' | 'warning' | 'critical';

export type ResupplyWarningCode =
  | 'no-resupply'
  | 'gap-exceeds-max-carry'
  | 'verify-hours'
  | 'unverified'
  | 'stale-verification'
  | 'hut-unknown-no-food'
  | 'fuel-no-shop'
  | 'post-not-food'
  | 'selvbetjent-stock-not-guaranteed'
  | 'cache-unknown-contents'
  | 'point-off-route'
  | 'point-beyond-end'
  | 'sunday-closed-only-option'
  | 'closed-check-alternatives'
  | 'mail-drop-ships-before-start'
  | 'mail-drop-window-before-start'
  | 'mail-drop-needs-start-date';

export interface ResupplyWarning {
  readonly code: ResupplyWarningCode;
  readonly severity: WarningSeverity;
  readonly message: string;
  readonly pointId?: string;
  readonly legId?: string;
}

export type StopKind = ResupplyKind | 'start' | 'end';

export interface ResupplyStop {
  readonly id: string;
  readonly kind: StopKind;
  readonly label: string;
  readonly distanceM: number;
  /** Days from the route start at this point (fractional). */
  readonly dayIndex: number;
  /** ISO date of estimated arrival, when a start date was supplied. */
  readonly arrivalDate?: string;
  /** Parsed opening state on the arrival date, when a point has hours. */
  readonly openOnArrival?: OpenState;
  readonly point?: ResupplyPoint;
}

export interface ResupplyLeg {
  readonly id: string;
  readonly from: ResupplyStop;
  readonly to: ResupplyStop;
  readonly distanceM: number;
  readonly days: number;
  readonly kcal: number;
  /** kg of food to buy/carry for this leg at the chosen mix. */
  readonly foodKg: number;
  readonly costNok: number;
  readonly warnings: readonly ResupplyWarning[];
}

export interface GapReport {
  readonly maxDays: number;
  readonly distanceM: number;
  readonly foodKg: number;
  readonly costNok: number;
  readonly fromId: string;
  readonly toId: string;
  readonly legId: string;
  readonly maxCarryDays: number;
  readonly exceedsMaxCarry: boolean;
}

export interface MailDropSchedule {
  readonly pointId: string;
  readonly kind: PostKind;
  /** Days from the route start to the drop. */
  readonly dayIndex: number;
  readonly arrival?: string;
  readonly shipBy?: string;
  readonly notBefore?: string;
  /** Pickup window length: 7 days (parcel) or 21 (poste restante). */
  readonly windowDays: number;
  readonly warnings: readonly ResupplyWarning[];
}

export interface ResupplyTotals {
  readonly distanceM: number;
  readonly days: number;
  readonly kcal: number;
  readonly foodKg: number;
  readonly costNok: number;
}

export interface ResupplyPlan {
  readonly support: SupportModel;
  readonly routeDistanceM: number;
  readonly dailyDistanceKm: number;
  readonly kcalPerDay: number;
  readonly maxCarryDays: number;
  readonly stops: readonly ResupplyStop[];
  readonly legs: readonly ResupplyLeg[];
  /** Worst continuous stretch between usable points. Null on a zero-length route. */
  readonly gap: GapReport | null;
  readonly mailDrops: readonly MailDropSchedule[];
  readonly totals: ResupplyTotals;
  readonly warnings: readonly ResupplyWarning[];
}

export interface ResupplyOptions {
  readonly support?: SupportModel;
  readonly kcalPerDay?: number;
  /** Average walking distance per day, km. Default 25. */
  readonly dailyDistanceKm?: number;
  /** Default 7. */
  readonly maxCarryDays?: number;
  /** Trip start; required for arrival dates, Sunday checks and mail drops. */
  readonly startDate?: Date;
  readonly mix?: FoodMix;
  /** Warn when a point is more than this from the route. Default 2 km. */
  readonly maxOffRouteM?: number;
  /** How close another usable point must be to soften a closure. Default 15 km. */
  readonly alternativeWindowM?: number;
  /** Verification older than this is flagged stale. Default 540 days. */
  readonly staleVerificationDays?: number;
}

const DAY_MS = 86_400_000;
const DEFAULT_KCAL_PER_DAY = 4000;
const DEFAULT_DAILY_KM = 25;
const DEFAULT_MAX_CARRY_DAYS = 7;
const DEFAULT_OFF_ROUTE_M = 2000;
const DEFAULT_ALTERNATIVE_WINDOW_M = 15_000;
const DEFAULT_STALE_DAYS = 540;
/** Points this close to the start/end are the boundary, not a separate stop. */
const BOUNDARY_TOLERANCE_M = 1;

function isoDay(base: Date, dayOffset: number): string {
  // Anchor on the *local calendar date* the user typed, then do whole-day
  // arithmetic in UTC so DST cannot move a date by one.
  const anchor = Date.UTC(base.getFullYear(), base.getMonth(), base.getDate());
  return new Date(anchor + dayOffset * DAY_MS).toISOString().slice(0, 10);
}

function localNoon(isoDate: string): Date {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0);
}

function parseIsoDay(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(time) ? time : null;
}

function stopLabel(point: ResupplyPoint | undefined, fallback: string): string {
  if (!point) return fallback;
  return point.name ?? point.id;
}

/**
 * Plan resupply for a general route.
 *
 * Throws on a point that cannot be located (no `routeDistanceM` and no route
 * geometry) rather than silently dropping it — a dropped shop is a food gap
 * the user never sees.
 */
export function planResupply(
  route: ResupplyRoute,
  points: readonly ResupplyPoint[],
  options: ResupplyOptions = {},
): ResupplyPlan {
  const support = options.support ?? 'carry-all';
  const kcalPerDay = options.kcalPerDay ?? DEFAULT_KCAL_PER_DAY;
  const dailyDistanceKm = options.dailyDistanceKm ?? DEFAULT_DAILY_KM;
  const maxCarryDays = options.maxCarryDays ?? DEFAULT_MAX_CARRY_DAYS;
  const mix = options.mix ?? DEFAULT_MIX;
  const maxOffRouteM = options.maxOffRouteM ?? DEFAULT_OFF_ROUTE_M;
  const alternativeWindowM = options.alternativeWindowM ?? DEFAULT_ALTERNATIVE_WINDOW_M;
  const staleDays = options.staleVerificationDays ?? DEFAULT_STALE_DAYS;
  const startDate = options.startDate;

  if (!(kcalPerDay > 0)) throw new Error(`invalid kcalPerDay: ${kcalPerDay}`);
  if (!(dailyDistanceKm > 0)) throw new Error(`invalid dailyDistanceKm: ${dailyDistanceKm}`);
  if (!(maxCarryDays > 0)) throw new Error(`invalid maxCarryDays: ${maxCarryDays}`);
  if (startDate && Number.isNaN(startDate.getTime())) {
    throw new Error('invalid startDate');
  }

  const routeDistanceM = routeLength(route);
  const dayAt = (alongM: number): number => alongM / 1000 / dailyDistanceKm;

  const warnings: ResupplyWarning[] = [];
  const warn = (
    code: ResupplyWarningCode,
    severity: WarningSeverity,
    message: string,
    extra: { pointId?: string; legId?: string } = {},
  ): ResupplyWarning => {
    const warning = { code, severity, message, ...extra };
    warnings.push(warning);
    return warning;
  };

  // --- Locate and classify -------------------------------------------------

  interface Located {
    readonly point: ResupplyPoint;
    readonly distanceM: number;
  }

  const located: Located[] = [];
  for (const point of points) {
    let alongM: number;
    if (point.routeDistanceM !== undefined && Number.isFinite(point.routeDistanceM)) {
      alongM = point.routeDistanceM;
      if (alongM < 0) throw new Error(`negative routeDistanceM on ${point.id}`);
      if (alongM > routeDistanceM) {
        warn(
          'point-beyond-end',
          'warning',
          `${point.id} is ${((alongM - routeDistanceM) / 1000).toFixed(1)} km beyond the route end; clamped`,
          { pointId: point.id },
        );
        alongM = routeDistanceM;
      }
    } else {
      if (!route.points || route.points.length === 0) {
        throw new Error(
          `cannot locate resupply point ${point.id}: no route geometry and no routeDistanceM`,
        );
      }
      const projection = projectOntoRoute(route, point.position);
      alongM = projection.alongM;
      if (projection.offsetM > maxOffRouteM) {
        warn(
          'point-off-route',
          'warning',
          `${point.id} is ${Math.round(projection.offsetM)} m off the route — check the detour`,
          { pointId: point.id },
        );
      }
    }
    located.push({ point, distanceM: Math.max(0, Math.min(routeDistanceM, alongM)) });
  }

  // --- Conservative availability warnings ---------------------------------

  const nodes: Located[] = [];
  for (const item of located) {
    const { point } = item;
    const isNode = isFoodSource(point) || (support === 'mail-drops' && point.kind === 'post');
    if (!isNode) {
      if (point.kind === 'fuel') {
        warn(
          'fuel-no-shop',
          'warning',
          `${point.id}: fuel station without a shop flag is assumed to be an automat — no food assumed`,
          { pointId: point.id },
        );
      } else if (point.kind === 'hut') {
        const reason =
          point.hutKind === 'ubetjent'
            ? 'ubetjent hut: nothing at all, including no gas'
            : 'hut food not confirmed';
        warn(
          'hut-unknown-no-food',
          'warning',
          `${point.id}: ${reason} — treated as no food`,
          { pointId: point.id },
        );
      } else if (point.kind === 'post') {
        warn(
          'post-not-food',
          'info',
          `${point.id}: post point does not sell food; use the mail-drop model`,
          { pointId: point.id },
        );
      }
      continue;
    }

    if (point.kind === 'hut' && point.hutKind === 'selvbetjent') {
      warn(
        'selvbetjent-stock-not-guaranteed',
        'warning',
        `${point.id}: self-service larder stock is not guaranteed — carry a reserve`,
        { pointId: point.id },
      );
    }
    if (point.kind === 'cache') {
      warn(
        'cache-unknown-contents',
        'info',
        `${point.id}: cache assumed to contain the food you placed there — verify`,
        { pointId: point.id },
      );
    }
    if (point.confidence === 'osm' && !point.hours && point.kind !== 'cache') {
      warn(
        'verify-hours',
        'warning',
        `${point.id}: OSM-only with no opening hours — verify before relying on it`,
        { pointId: point.id },
      );
    }
    if (!point.lastVerified && point.kind !== 'cache') {
      warn('unverified', 'info', `${point.id}: never verified`, { pointId: point.id });
    } else if (point.lastVerified) {
      const verified = parseIsoDay(point.lastVerified);
      if (verified !== null) {
        const ageDays =
          (Date.UTC(
            startDate?.getFullYear() ?? new Date().getFullYear(),
            startDate?.getMonth() ?? new Date().getMonth(),
            startDate?.getDate() ?? new Date().getDate(),
          ) -
            verified) /
          DAY_MS;
        if (ageDays > staleDays) {
          warn(
            'stale-verification',
            'warning',
            `${point.id}: last verified ${point.lastVerified} (${Math.round(ageDays)} days ago) — re-verify`,
            { pointId: point.id },
          );
        }
      }
    }

    nodes.push(item);
  }

  nodes.sort((a, b) => {
    if (a.distanceM !== b.distanceM) return a.distanceM - b.distanceM;
    const byPriority = KIND_PRIORITY[b.point.kind] - KIND_PRIORITY[a.point.kind];
    if (byPriority !== 0) return byPriority;
    return a.point.id.localeCompare(b.point.id);
  });

  // --- Stops ---------------------------------------------------------------

  const stops: ResupplyStop[] = [];
  const pushStop = (stop: ResupplyStop): void => {
    const previous = stops[stops.length - 1];
    if (previous && Math.abs(previous.distanceM - stop.distanceM) <= BOUNDARY_TOLERANCE_M) {
      // Keep the more useful node at a coincident distance; a zero-length leg
      // between two shops in the same building is noise, not information.
      if (
        stop.point &&
        previous.point &&
        KIND_PRIORITY[stop.point.kind] > KIND_PRIORITY[previous.point.kind]
      ) {
        stops[stops.length - 1] = stop;
      }
      return;
    }
    stops.push(stop);
  };

  const makeStop = (point: ResupplyPoint | undefined, alongM: number, fallback: string): ResupplyStop => {
    const arrivalDate = startDate ? isoDay(startDate, dayAt(alongM)) : undefined;
    const openOnArrival =
      point && arrivalDate ? openAt(point, localNoon(arrivalDate)) : undefined;
    return {
      id: point?.id ?? fallback,
      kind: point?.kind ?? (fallback === 'Start' ? 'start' : 'end'),
      label: stopLabel(point, fallback),
      distanceM: alongM,
      dayIndex: dayAt(alongM),
      arrivalDate,
      openOnArrival,
      point,
    };
  };

  pushStop({
    id: 'start',
    kind: 'start',
    label: 'Start',
    distanceM: 0,
    dayIndex: 0,
    arrivalDate: startDate ? isoDay(startDate, 0) : undefined,
    openOnArrival: undefined,
  });
  for (const node of nodes) {
    if (node.distanceM <= BOUNDARY_TOLERANCE_M) continue;
    if (node.distanceM >= routeDistanceM - BOUNDARY_TOLERANCE_M) continue;
    pushStop(makeStop(node.point, node.distanceM, node.point.id));
  }
  if (routeDistanceM > 0) {
    pushStop({
      id: 'end',
      kind: 'end',
      label: 'End',
      distanceM: routeDistanceM,
      dayIndex: dayAt(routeDistanceM),
      arrivalDate: startDate ? isoDay(startDate, dayAt(routeDistanceM)) : undefined,
      openOnArrival: undefined,
    });
  }

  // A point that ends up as the only stop on a zero-length route is the start.
  if (routeDistanceM === 0) {
    return {
      support,
      routeDistanceM,
      dailyDistanceKm,
      kcalPerDay,
      maxCarryDays,
      stops,
      legs: [],
      gap: null,
      mailDrops: [],
      totals: { distanceM: 0, days: 0, kcal: 0, foodKg: 0, costNok: 0 },
      warnings,
    };
  }

  // --- Legs ----------------------------------------------------------------

  const legs: ResupplyLeg[] = [];
  for (let i = 0; i < stops.length - 1; i += 1) {
    const from = stops[i];
    const to = stops[i + 1];
    if (to.distanceM <= 0) continue;
    const legDistanceM = Math.max(0, to.distanceM - from.distanceM);
    if (!(legDistanceM > 0)) continue;
    const days = dayAt(legDistanceM);
    const kcal = days * kcalPerDay;
    const foodKg = foodWeightFor(kcal, mix);
    const costNok = costFor(kcal, mix);
    const id = `leg-${i}-${from.id}-${to.id}`;
    const legWarnings: ResupplyWarning[] = [];

    if (days > maxCarryDays) {
      legWarnings.push(
        warn(
          'gap-exceeds-max-carry',
          'critical',
          `${to.id}: ${days.toFixed(1)} days without a usable resupply point exceeds ` +
            `${maxCarryDays} days — carry ${foodKg.toFixed(1)} kg of food`,
          { legId: id, pointId: to.point?.id },
        ),
      );
    }

    if (to.point && to.arrivalDate && to.openOnArrival) {
      if (to.openOnArrival === 'closed') {
        const alternatives = nodes.filter(
          (node) =>
            node.point.id !== to.point!.id &&
            Math.abs(node.distanceM - to.distanceM) <= alternativeWindowM,
        );
        if (alternatives.length === 0) {
          legWarnings.push(
            warn(
              'sunday-closed-only-option',
              'critical',
              `${to.id}: closed on the estimated arrival date ${to.arrivalDate} and it is ` +
                `the only option within ${Math.round(alternativeWindowM / 1000)} km — plan around it`,
              { legId: id, pointId: to.point.id },
            ),
          );
        } else {
          legWarnings.push(
            warn(
              'closed-check-alternatives',
              'warning',
              `${to.id}: closed on the estimated arrival date ${to.arrivalDate}; ` +
                `alternatives exist nearby — check hours`,
              { legId: id, pointId: to.point.id },
            ),
          );
        }
      }
    }

    legs.push({
      id,
      from,
      to,
      distanceM: legDistanceM,
      days,
      kcal,
      foodKg,
      costNok,
      warnings: legWarnings,
    });
  }

  // --- Gap report ----------------------------------------------------------

  let gap: GapReport | null = null;
  if (legs.length > 0) {
    const worst = legs.reduce((best, leg) => (leg.days > best.days ? leg : best), legs[0]);
    gap = {
      maxDays: worst.days,
      distanceM: worst.distanceM,
      foodKg: worst.foodKg,
      costNok: worst.costNok,
      fromId: worst.from.id,
      toId: worst.to.id,
      legId: worst.id,
      maxCarryDays,
      exceedsMaxCarry: worst.days > maxCarryDays,
    };
    if (nodes.length === 0) {
      warn(
        'no-resupply',
        'critical',
        `No usable resupply point on the route — carry ${worst.foodKg.toFixed(1)} kg ` +
          `for the full ${worst.days.toFixed(1)} days`,
        { legId: worst.id },
      );
    }
  }

  // --- Mail drops ----------------------------------------------------------

  const mailDrops: MailDropSchedule[] = [];
  for (const node of nodes) {
    if (node.point.kind !== 'post') continue;
    const kind = node.point.postKind ?? 'parcel';
    const windowDays = kind === 'poste-restante' ? 21 : 7;
    const dayIndex = dayAt(node.distanceM);
    const dropWarnings: ResupplyWarning[] = [];
    if (!startDate) {
      dropWarnings.push(
        warn(
          'mail-drop-needs-start-date',
          'warning',
          `${node.point.id}: a start date is required to schedule the parcel`,
          { pointId: node.point.id },
        ),
      );
      mailDrops.push({ pointId: node.point.id, kind, dayIndex, windowDays, warnings: dropWarnings });
      continue;
    }
    const arrival = isoDay(startDate, dayIndex);
    const shipBy = isoDay(startDate, dayIndex - 5);
    const notBefore = isoDay(startDate, dayIndex - windowDays);
    if (parseIsoDay(shipBy)! < (parseIsoDay(isoDay(startDate, 0)) ?? 0)) {
      dropWarnings.push(
        warn(
          'mail-drop-ships-before-start',
          'critical',
          `${node.point.id}: arrives ~${arrival}, which means posting by ${shipBy} — ` +
            `before the trip starts. This drop cannot work.`,
          { pointId: node.point.id },
        ),
      );
    }
    if (notBefore < isoDay(startDate, 0)) {
      dropWarnings.push(
        warn(
          'mail-drop-window-before-start',
          'info',
          `${node.point.id}: ${windowDays}-day window opens ${notBefore}, before departure`,
          { pointId: node.point.id },
        ),
      );
    }
    mailDrops.push({
      pointId: node.point.id,
      kind,
      dayIndex,
      arrival,
      shipBy,
      notBefore,
      windowDays,
      warnings: dropWarnings,
    });
  }

  // --- Totals --------------------------------------------------------------

  const totals = legs.reduce<ResupplyTotals>(
    (sum, leg) => ({
      distanceM: sum.distanceM + leg.distanceM,
      days: sum.days + leg.days,
      kcal: sum.kcal + leg.kcal,
      foodKg: sum.foodKg + leg.foodKg,
      costNok: sum.costNok + leg.costNok,
    }),
    { distanceM: 0, days: 0, kcal: 0, foodKg: 0, costNok: 0 },
  );

  return {
    support,
    routeDistanceM,
    dailyDistanceKm,
    kcalPerDay,
    maxCarryDays,
    stops,
    legs,
    gap,
    mailDrops,
    totals,
    warnings,
  };
}

