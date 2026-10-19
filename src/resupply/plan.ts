/**
 * Turn correlated resupply candidates into a leg-by-leg plan.
 *
 * This module **wraps** `src/plan/resupply.ts` and `src/plan/energy.ts`; it does
 * not re-derive either model. The plan engine already owns:
 *
 * - the leg/gap arithmetic and the `maxCarryDays` carry warning;
 * - the conservative `isFoodSource()` rules (a hut needs `sellsFood`, a fuel
 *   station needs `hasShop`, a post point is never food);
 * - opening-hours parsing and the Sunday-closure check;
 * - the mail-drop scheduler.
 *
 * The energy model owns kcal/day: the daily demand is `estimateDay(...).tdee`
 * for the trip's own profile and daily distance, not a hard-coded 4,000. Food
 * mass and cost come from `src/plan/nutrition.ts` through the plan engine.
 *
 * What *this* module adds is the honesty around the inputs:
 *
 * 1. **A hut is not a food source.** The Turrutebasen classification
 *    (betjent/selvbetjent/ubetjent) is not machine-readable, so by default a hut
 *    is excluded from the plan and the plan says so. Only an explicit
 *    `hutsSellFood: true` — a caller assertion, not a fact we derived — lets a
 *    hut close a gap, and that is reported as unverified.
 * 2. **An unmanned fuel station counts for nothing** (the binary's `0x04`
 *    heuristic), and a staffed one is an assumption that is named.
 * 3. **No point is ever "open".** The binary stores only whether OSM had an
 *    `opening_hours` tag, never its text, so every bundled point is unverified
 *    and the count is reported once rather than per point.
 */

import type { Trip } from '../contracts';
import { haversine, pathLength, type LonLat } from '../core/geo';
import { estimateDay, type EnergyRange } from '../plan/energy';
import { DEFAULT_MIX, type FoodMix } from '../plan/nutrition';
import {
  planResupply,
  type ResupplyKind,
  type ResupplyPoint,
  type ResupplyWarning,
  type SupportModel,
} from '../plan/resupply';
import type { ResupplyCandidate } from './index';

const DEFAULT_MAX_CARRY_DAYS = 7;
/** Points further than this from the route are flagged as a detour. */
const DEFAULT_DETOUR_PENALTY_M = 2000;
/** Reserved for the daily distance when a profile has none. */
const FALLBACK_DAILY_KM = 25;

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

/** One end of a leg: the route start/end, or a resupply candidate. */
export interface ResupplyAnchor {
  readonly kind: 'start' | 'end' | ResupplyCandidate['kind'];
  readonly name: string;
  readonly point: LonLat;
  /** Distance from the route start, metres. */
  readonly alongRouteM: number;
  readonly candidate?: ResupplyCandidate;
}

export interface ResupplyLeg {
  readonly id: string;
  readonly from: ResupplyAnchor;
  readonly to: ResupplyAnchor;
  readonly distanceM: number;
  readonly days: number;
  /** kcal to eat on this leg (days × kcal/day). */
  readonly kcal: number;
  /** kg of food to buy/carry for this leg, from the food mix. */
  readonly foodKg: number;
  readonly costNok: number;
  /** True when `days` exceeds `maxCarryDays`: the food will not fit the plan. */
  readonly carryDanger: boolean;
  readonly warnings: readonly string[];
}

/** The worst continuous stretch between usable resupply points. */
/** A parcel or poste-restante drop, with its pickup window (D3). */
export interface MailDropView {
  readonly pointId: string;
  readonly name: string;
  readonly kind: 'post' | 'parcel' | 'poste-restante';
  readonly dayIndex: number;
  readonly arrival?: string;
  readonly shipBy?: string;
  readonly notBefore?: string;
  readonly windowDays: number;
  readonly warnings: readonly string[];
}

export interface ResupplyGap {
  readonly distanceM: number;
  readonly days: number;
  readonly foodKg: number;
  /** Stop ids. They are not human names — see the review note in docs/14. */
  readonly fromId: string;
  readonly toId: string;
  readonly exceedsMaxCarry: boolean;
}

export interface ResupplyPlan {
  readonly legs: readonly ResupplyLeg[];
  readonly warnings: string[];
  readonly totalFoodKg: number;
  readonly totalCostNok: number;

  /** Total route length the plan was built against, metres. */
  readonly routeDistanceM: number;
  readonly totalDays: number;
  readonly dailyDistanceKm: number;
  /** Daily energy demand used for every leg, kcal. */
  readonly kcalPerDay: number;
  /** The honest model spread around `kcalPerDay` — never a single number. */
  readonly kcalRange: EnergyRange;
  readonly maxCarryDays: number;
  /** True when huts were explicitly allowed to count as food sources. */
  readonly hutsSellFood: boolean;
  /** The candidates that actually count, in route order. */
  readonly resupplyPoints: readonly ResupplyCandidate[];
  /** Empty unless the trip's support model is `mail-drops`. */
  readonly mailDrops: readonly MailDropView[];
  readonly gap: ResupplyGap | null;
}

export interface ResupplyPlanOptions {
  readonly maxCarryDays?: number;
  /**
   * A candidate further than this from the route is flagged as a detour.
   * Default 2,000 m. This is a *warning* threshold, not a filter: silently
   * dropping a distant shop would invent a food gap.
   */
  readonly detourPenaltyM?: number;
  /**
   * Let huts count as food sources. Off by default: hut food is not confirmed
   * and the betjent/selvbetjent/ubetjent class is not machine-readable. Turning
   * this on is the caller's assertion, and every leg through a hut is flagged.
   */
  readonly hutsSellFood?: boolean;
  /** Override the energy model's kcal/day (experiments, sensitivity analysis). */
  readonly kcalPerDay?: number;
  /** Food mix; defaults to the plan engine's staples + one freeze-dried dinner. */
  readonly mix?: FoodMix;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Concatenate every leg's geometry into one polyline, without joint duplicates.
 *
 * A trip whose legs do not meet is bridged by a straight line — the plan engine
 * works on one polyline — so the bridged length is returned and reported: the
 * user has to know that some of the distance was invented by the concatenation.
 */
function tripPolyline(trip: Trip): { points: LonLat[]; bridgedM: number } {
  const points: LonLat[] = [];
  let bridgedM = 0;
  let previousEnd: LonLat | undefined;
  for (const leg of trip.legs) {
    const first = leg.points[0];
    if (first && previousEnd) bridgedM += haversine(previousEnd, { lon: first.lon, lat: first.lat });
    let legLast: LonLat | undefined;
    for (const point of leg.points) {
      if (!Number.isFinite(point.lon) || !Number.isFinite(point.lat)) {
        throw new RangeError(`trip ${trip.id} has a non-finite route point: ${String(point)}`);
      }
      const last = points[points.length - 1];
      if (last && last.lon === point.lon && last.lat === point.lat) continue;
      points.push({ lon: point.lon, lat: point.lat });
      legLast = { lon: point.lon, lat: point.lat };
    }
    if (legLast) previousEnd = legLast;
  }
  return { points, bridgedM };
}

/** `profile.startDate` is an ISO date; the plan engine wants a Date at local noon. */
function startDateOf(trip: Trip): Date | undefined {
  const raw = trip.profile.startDate;
  if (!raw) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return undefined;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0);
}

/** The plan engine's food-shop kind. `general`/`grocery` are shops, not a category. */
function planKind(kind: ResupplyCandidate['kind']): ResupplyKind {
  switch (kind) {
    case 'supermarket':
    case 'general':
    case 'grocery':
      return 'supermarket';
    case 'convenience':
      return 'convenience';
    case 'fuel':
      return 'fuel';
    case 'post':
    case 'parcel':
      return 'post';
    case 'hut':
      return 'hut';
  }
}

function candidateId(candidate: ResupplyCandidate): string {
  const { lat, lon } = candidate.point;
  return `${candidate.kind}:${candidate.name}@${lat.toFixed(6)},${lon.toFixed(6)}`;
}

function usable(candidate: ResupplyCandidate, hutsSellFood: boolean, support: SupportModel): boolean {
  switch (candidate.kind) {
    case 'supermarket':
    case 'convenience':
    case 'general':
    case 'grocery':
      return true;
    // A fuel station flagged unmanned is a card-only pump: no food at all.
    case 'fuel':
      return candidate.unmanned !== true;
    // Post points and parcel lockers do not sell food; they are mail-drop
    // destinations and only exist in the mail-drop support model.
    case 'post':
    case 'parcel':
      return support === 'mail-drops';
    case 'hut':
      return hutsSellFood;
  }
}

function toPlanPoint(candidate: ResupplyCandidate, hutsSellFood: boolean): ResupplyPoint {
  const kind = planKind(candidate.kind);
  return {
    id: candidateId(candidate),
    kind,
    position: { lon: candidate.point.lon, lat: candidate.point.lat },
    name: candidate.name,
    ...(candidate.openingHours !== undefined ? { hours: candidate.openingHours } : {}),
    confidence: candidate.evidence,
    ...(kind === 'fuel' ? { hasShop: candidate.unmanned !== true } : {}),
    ...(kind === 'hut' ? { sellsFood: hutsSellFood } : {}),
    ...(candidate.kind === 'parcel' ? { postKind: 'parcel' as const } : {}),
    routeDistanceM: candidate.alongRouteM,
  };
}

function listOf(names: readonly string[], max = 3): string {
  if (names.length === 0) return '';
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown}, +${names.length - max} more` : shown;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Codes summarised in one aggregate sentence instead of one row per point: a
 * route through a city has 200 shops, and 200 copies of "verify the hours"
 * hides the four warnings that matter.
 */
const AGGREGATED_CODES: ReadonlySet<ResupplyWarning['code']> = new Set([
  'verify-hours',
  'unverified',
  'hut-unknown-no-food',
  'fuel-no-shop',
  'post-not-food',
]);

function warningText(warning: ResupplyWarning): string {
  return warning.message;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * Plan resupply for a trip.
 *
 * Candidate `alongRouteM` values are trusted (they come from the corridor query
 * against the same polyline). A candidate beyond the route end is clamped by the
 * plan engine with a warning — never dropped, because a dropped shop is a food
 * gap the user never sees.
 */
export function planResupplyForTrip(
  trip: Trip,
  candidates: readonly ResupplyCandidate[],
  opts: ResupplyPlanOptions = {},
): ResupplyPlan {
  const maxCarryDays = opts.maxCarryDays ?? DEFAULT_MAX_CARRY_DAYS;
  const detourPenaltyM = opts.detourPenaltyM ?? DEFAULT_DETOUR_PENALTY_M;
  const hutsSellFood = opts.hutsSellFood === true;
  const support: SupportModel = trip.profile.support ?? 'carry-all';

  if (!(maxCarryDays > 0)) throw new RangeError(`invalid maxCarryDays: ${maxCarryDays}`);
  if (!(detourPenaltyM >= 0)) throw new RangeError(`invalid detourPenaltyM: ${detourPenaltyM}`);

  const { points: polyline, bridgedM } = tripPolyline(trip);
  if (polyline.length < 2) {
    throw new Error(`trip ${trip.id} has no route geometry to plan against`);
  }
  const routeDistanceM = pathLength(polyline);

  const dailyDistanceKm = trip.profile.dailyKm > 0 ? trip.profile.dailyKm : FALLBACK_DAILY_KM;

  // kcal/day: the energy model, not a magic constant. One representative day at
  // the trip's own daily distance and base pack mass.
  const day = estimateDay({
    body: {
      massKg: trip.profile.massKg,
      heightCm: trip.profile.heightCm,
      ageYears: trip.profile.ageYears,
      sex: trip.profile.sex,
      ...(trip.profile.bodyFatPercent !== undefined
        ? { bodyFatPercent: trip.profile.bodyFatPercent }
        : {}),
    },
    packMassKg: Math.max(0, trip.profile.packBaseKg),
    distanceM: dailyDistanceKm * 1000,
    terrain: 'trail',
  });
  const kcalPerDay = opts.kcalPerDay ?? day.tdee;
  if (!(kcalPerDay > 0)) throw new RangeError(`invalid kcalPerDay: ${kcalPerDay}`);

  const sorted = [...candidates].sort((a, b) => a.alongRouteM - b.alongRouteM);

  // --- Honesty: what we are deliberately *not* counting ---------------------

  const warnings: string[] = [];

  if (!(trip.profile.dailyKm > 0)) {
    warnings.push(
      `No daily distance is set in the trip settings; the plan assumes ` +
        `${FALLBACK_DAILY_KM} km per day, so every day count below follows from that guess.`,
    );
  }

  if (bridgedM > 500) {
    warnings.push(
      `The trip's legs do not meet: ${(bridgedM / 1000).toFixed(1)} km is bridged straight ` +
        'between them. That distance is counted as walking, and it is probably not a path.',
    );
  }

  const huts = sorted.filter((c) => c.kind === 'hut');
  if (huts.length > 0) {
    const listed = listOf(huts.map((h) => h.name));
    if (hutsSellFood) {
      warnings.push(
        `${plural(huts.length, 'hut', 'huts')} treated as ${
          huts.length === 1 ? 'a food source' : 'food sources'
        } at your request (${listed}) — no food is confirmed, the ` +
          'betjent/selvbetjent/ubetjent class is not machine-readable. Carry a reserve.',
      );
    } else {
      warnings.push(
        `${plural(huts.length, 'hut', 'huts')} on the route (${listed}) ${
          huts.length === 1 ? 'is' : 'are'
        } treated as NO food source: hut provisioning is not machine-readable. ` +
          'Assume no food at a hut unless you have checked with the maintainer.',
      );
    }
  }

  const unmannedFuel = sorted.filter((c) => c.kind === 'fuel' && c.unmanned === true);
  if (unmannedFuel.length > 0) {
    warnings.push(
      `${plural(unmannedFuel.length, 'fuel station is', 'fuel stations are')} flagged unmanned ` +
        `(${listOf(unmannedFuel.map((c) => c.name))}) and count for nothing — check the station.`,
    );
  }
  const staffedFuel = sorted.filter((c) => c.kind === 'fuel' && c.unmanned !== true);
  if (staffedFuel.length > 0) {
    warnings.push(
      `${plural(staffedFuel.length, 'fuel station is', 'fuel stations are')} assumed staffed ` +
        '(not flagged unmanned in OSM) — confirm it is not a card-only automat, and expect ' +
        'convenience-grade food only.',
    );
  }

  const postPoints = sorted.filter((c) => c.kind === 'post' || c.kind === 'parcel');
  if (postPoints.length > 0 && support !== 'mail-drops') {
    warnings.push(
      postPoints.length === 1
        ? '1 post or parcel point is not food — it is a mail-drop destination only. Switch to ' +
            'the mail-drop support model to use it.'
        : `${postPoints.length} post or parcel points are not food — they are mail-drop ` +
            'destinations only. Switch to the mail-drop support model to use them.',
    );
  }

  const foodCandidates = sorted.filter((c) => usable(c, hutsSellFood, support));
  const hoursMissing = foodCandidates.filter((c) => c.hoursRecorded !== true).length;
  if (foodCandidates.length > 0) {
    // The binary stores the *presence* of `opening_hours`, never the text, so no
    // bundled point can be called open. This is one warning, not one per point:
    // a city route has 200 shops and 200 copies would hide the real warnings.
    warnings.push(
      hoursMissing === 0
        ? `None of the ${foodCandidates.length} resupply points is verified open: the bundled ` +
            'file records that OSM had opening_hours, but not what they are. Check before you ' +
            'rely on them — Sundays and public holidays especially.'
        : `${hoursMissing} of ${foodCandidates.length} resupply points have no opening_hours in ` +
            'OSM at all, and none is verified open (the file stores only whether the tag ' +
            'existed). Check before you rely on anything.',
    );
  }

  const detours = foodCandidates.filter((c) => c.detourM > detourPenaltyM);
  if (detours.length > 0) {
    warnings.push(
      `${plural(detours.length, 'resupply point is', 'resupply points are')} more than ` +
        `${Math.round(detourPenaltyM / 1000)} km off the route (${listOf(
          detours.map((c) => `${c.name} ${(c.detourM / 1000).toFixed(1)} km`),
        )}) — the walk in and back is extra distance this plan does not add.`,
    );
  }

  // --- The plan engine ------------------------------------------------------

  const points = foodCandidates.map((candidate) => toPlanPoint(candidate, hutsSellFood));
  const startDate = startDateOf(trip);

  const plan = planResupply({ points: polyline, distanceM: routeDistanceM }, points, {
    support,
    kcalPerDay,
    dailyDistanceKm,
    maxCarryDays,
    maxOffRouteM: detourPenaltyM,
    ...(startDate ? { startDate } : {}),
    mix: opts.mix ?? DEFAULT_MIX,
  });

  // --- Legs -----------------------------------------------------------------

  const byId = new Map<string, ResupplyCandidate>();
  for (const candidate of foodCandidates) byId.set(candidateId(candidate), candidate);

  const anchorOf = (stop: (typeof plan.stops)[number]): ResupplyAnchor => {
    if (stop.kind === 'start') {
      return { kind: 'start', name: 'Start', point: polyline[0], alongRouteM: 0 };
    }
    if (stop.kind === 'end') {
      return {
        kind: 'end',
        name: 'End',
        point: polyline[polyline.length - 1],
        alongRouteM: routeDistanceM,
      };
    }
    const candidate = byId.get(stop.id);
    if (!candidate) {
      // Every non-boundary stop came from a candidate, so this is an invariant
      // break, not a data condition. Inventing a coordinate here would put a
      // shop that does not exist on the map.
      throw new Error(`plan engine produced a stop with no candidate: ${stop.id}`);
    }
    return {
      kind: candidate.kind,
      name: stop.label,
      point: candidate.point,
      alongRouteM: stop.distanceM,
      candidate,
    };
  };

  const planWarningsFor = (legId: string): string[] =>
    plan.warnings
      .filter((warning) => warning.legId === legId && !AGGREGATED_CODES.has(warning.code))
      .map(warningText);

  const legs: ResupplyLeg[] = plan.legs.map((leg) => ({
    id: leg.id,
    from: anchorOf(leg.from),
    to: anchorOf(leg.to),
    distanceM: leg.distanceM,
    days: leg.days,
    kcal: leg.kcal,
    foodKg: leg.foodKg,
    costNok: leg.costNok,
    carryDanger: leg.days > maxCarryDays,
    warnings: planWarningsFor(leg.id),
  }));

  // Plan-level warnings, minus the aggregated ones. A leg warning is repeated
  // here on purpose: the plan-level list is what the UI shows when no leg is
  // selected, and a carry warning hidden inside a leg is a warning not seen.
  for (const warning of plan.warnings) {
    if (AGGREGATED_CODES.has(warning.code)) continue;
    const text = warningText(warning);
    if (warnings.includes(text)) continue;
    warnings.push(text);
  }

  const gap = plan.gap
    ? {
        distanceM: plan.gap.distanceM,
        days: plan.gap.maxDays,
        foodKg: plan.gap.foodKg,
        fromId: plan.gap.fromId,
        toId: plan.gap.toId,
        exceedsMaxCarry: plan.gap.exceedsMaxCarry,
      }
    : null;

  return {
    legs,
    warnings,
    totalFoodKg: plan.totals.foodKg,
    totalCostNok: plan.totals.costNok,
    routeDistanceM,
    totalDays: plan.totals.days,
    dailyDistanceKm,
    kcalPerDay,
    // When the caller overrides kcalPerDay for sensitivity analysis, the band
    // must be the model spread *around that number*, not around the default TDEE.
    kcalRange:
      opts.kcalPerDay === undefined
        ? day.range
        : { p10: Math.round(kcalPerDay * 0.75), p90: Math.round(kcalPerDay * 1.3) },
    maxCarryDays,
    hutsSellFood,
    resupplyPoints: foodCandidates,
    mailDrops: plan.mailDrops.map((drop) => ({
      pointId: drop.pointId,
      name: byId.get(drop.pointId)?.name ?? drop.pointId,
      kind: drop.kind,
      dayIndex: drop.dayIndex,
      ...(drop.arrival !== undefined ? { arrival: drop.arrival } : {}),
      ...(drop.shipBy !== undefined ? { shipBy: drop.shipBy } : {}),
      ...(drop.notBefore !== undefined ? { notBefore: drop.notBefore } : {}),
      windowDays: drop.windowDays,
      warnings: drop.warnings.map(warningText),
    })),
    gap,
  };
}
