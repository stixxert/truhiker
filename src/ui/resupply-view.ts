/**
 * The resupply panel, as data.
 *
 * The honesty rules of `docs/DECISIONS.md` (D1–D3, D13) are applied here, once,
 * so the DOM layer cannot implement them differently:
 *
 *  - a **hut** never counts as a food source and is labelled "ikke bekreftet";
 *  - an **unmanned** fuel station is not food and says "check the station";
 *  - a point whose `opening_hours` are not known is **unverified** — no point is
 *    ever described as "open";
 *  - a **gap** is the plan engine's, never re-derived: the inline warning is
 *    attached to the leg `planResupplyForTrip()` produced, with its own
 *    `foodKg` and `days`, and only shown when that leg is `carryDanger`.
 *
 * Every failure the user can hit has a state with a non-empty message: no trip,
 * no profile, a missing shop index, a plan that could not be built, huts that
 * could not be fetched (which is a partial result, not a blank panel).
 */

import type { LonLat } from '../core/geo';
import { formatDay, type I18n, type MessageKey } from '../i18n';
import {
  candidateKey,
  type ResupplyCandidate,
  type ResupplyLeg,
  type ResupplyPlan,
  type ResupplyPlanWarning,
  type ResupplyPlanWarningCode,
} from '../resupply';

/** Everything a successful corridor query produced, plus its provenance. */
interface ResupplyData {
  readonly candidates: readonly ResupplyCandidate[];
  readonly plan: ResupplyPlan;
  /** ISO timestamp the binary is labelled with (the served `data/shops.osm.json`). */
  readonly indexBuiltAt: string;
  /** Number of points in the bundled index (not the number on this route). */
  readonly indexCount: number;
  /** Why the live hut query failed, when it did. The shop rows are still valid. */
  readonly hutsError: string | null;
  /** When the corridor query ran. */
  readonly fetchedAt: string;
  readonly radiusM: number;
}

export type ResupplyPanelState =
  | { kind: 'no-trip' }
  | { kind: 'no-route' }
  | { kind: 'no-profile'; detail?: string }
  | { kind: 'loading' }
  | { kind: 'index-failed'; message: string }
  | { kind: 'plan-failed'; message: string }
  | { kind: 'ready'; data: ResupplyData };

type ResupplyAction = 'none' | 'settings' | 'open-route' | 'retry';

export interface ResupplyRowView {
  readonly id: string;
  readonly name: string;
  readonly kind: ResupplyCandidate['kind'];
  readonly kindLabel: string;
  readonly point: LonLat;
  /** Distance from the route start, for the map ↔ profile cursor sync. */
  readonly alongRouteM: number;
  readonly distanceLabel: string;
  readonly detourLabel: string;
  /** Distance (and days) to the next usable point, or `null` at the route end. */
  readonly gapLabel: string | null;
  /** True when the leg this point sits on is longer than the user can carry. */
  readonly gapDanger: boolean;
  /** Inline warning for a leg that exceeds `maxCarryDays`; from the plan. */
  readonly warning: string | null;
  /** "ikke bekreftet", "ubemannet", "åpningstid ukjent" — never "åpen". */
  readonly badges: readonly string[];
  /**
   * Where to check a fact this app cannot confirm (D1: DNT for a hut), or
   * `null` when the row carries no unverifiable claim. Rendered as a link.
   */
  readonly checkUrl: string | null;
  readonly checkLabel: string | null;
  /** False for huts, unmanned fuel and post points under carry-all. */
  readonly countsAsFood: boolean;
  /** "OSM/ODbL" or "Turrutebasen (CC BY 4.0)". */
  readonly provenanceLabel: string;
}

interface ResupplyLegView {
  readonly id: string;
  readonly title: string;
  readonly distanceLabel: string;
  readonly numbersLabel: string;
  readonly carryWarning: string | null;
  readonly danger: boolean;
  /** The plan engine's own sentences for this leg (English, verbatim). */
  readonly engineWarnings: readonly string[];
}

interface ResupplyWarningView {
  readonly severity: 'info' | 'warning' | 'critical';
  readonly text: string;
}

export interface ResupplyViewModel {
  readonly state: 'message' | 'loading' | 'ready';
  readonly message: string | null;
  readonly detail: string | null;
  readonly action: ResupplyAction;
  readonly statusLine: string;
  /** Provenance line for the index ("OSM extract …, 8 571 points, ODbL"). */
  readonly indexLabel: string | null;
  /** Visible, translated note about the huts that could not be fetched. */
  readonly hutsError: string | null;
  readonly rows: readonly ResupplyRowView[];
  readonly legs: readonly ResupplyLegView[];
  readonly warnings: readonly ResupplyWarningView[];
  /** The engine's untranslated sentences, shown collapsed for traceability. */
  readonly engineWarnings: readonly string[];
  readonly totalsLabel: string | null;
  readonly worstGapLabel: string | null;
  readonly worstGapDanger: boolean;
  readonly attribution: string;
  readonly note: string;
  readonly emptyMessage: string | null;
}

type ViewI18n = Pick<I18n, 't' | 'locale' | 'format'>;

/** The corridor a user can ask for, in metres. 5 km is the documented default. */
export const RADIUS_OPTIONS_M = [5_000, 10_000, 25_000, 30_000] as const;
export const DEFAULT_RADIUS_M = 5_000;

const KIND_KEYS: Record<ResupplyCandidate['kind'], MessageKey> = {
  supermarket: 'supply.kind.supermarket',
  convenience: 'supply.kind.convenience',
  general: 'supply.kind.general',
  grocery: 'supply.kind.grocery',
  fuel: 'supply.kind.fuel',
  post: 'supply.kind.post',
  parcel: 'supply.kind.parcel',
  hut: 'supply.kind.hut',
};

/** The same identity the resupply surface uses; kept exported for this module's callers. */
export { candidateKey };

function daysLabel(days: number, i18n: ViewI18n): string {
  // A sub-hour leg is not "0 d": rounding to one decimal would print zero days
  // and read as "no gap" where there is a short one. Say "< 0,1 d" instead.
  if (days > 0 && days < 0.05) return i18n.t('supply.dayValueUnderTenth');
  return i18n.t('supply.dayValue', {
    value: i18n.format.number(days, { maximumFractionDigits: 1 }),
  });
}

function provenanceOf(candidate: ResupplyCandidate, i18n: ViewI18n): string {
  return candidate.evidence === 'curated'
    ? i18n.t('supply.provenanceCurated')
    : candidate.evidence === 'chain-verified'
      ? i18n.t('supply.provenanceChain')
      : i18n.t('supply.provenanceOsm');
}

function badgesFor(candidate: ResupplyCandidate, i18n: ViewI18n): string[] {
  const badges: string[] = [];
  if (candidate.kind === 'hut') {
    // D1: the betjent/selvbetjent/ubetjent class is not machine-readable, so a
    // hut is never "a shop". The label is mandated by the decisions document.
    badges.push(i18n.t('supply.badgeUnconfirmed'));
  }
  if (candidate.kind === 'fuel' && candidate.unmanned === true) {
    badges.push(i18n.t('supply.badgeUnmanned'));
  }
  if (candidate.kind !== 'hut') {
    // The binary stores only *whether* OSM had `opening_hours`, never the text.
    badges.push(
      candidate.hoursRecorded === true
        ? i18n.t('supply.badgeHoursUnread')
        : i18n.t('supply.badgeHoursMissing'),
    );
  }
  return badges;
}

/** What a hover card says about a place the route does not pass. */
export interface PlaceCardModel {
  readonly name: string;
  readonly kindLabel: string;
  readonly badges: readonly string[];
  readonly provenanceLabel: string;
}

export function placeCardModel(
  candidate: ResupplyCandidate,
  i18n: ViewI18n,
): PlaceCardModel {
  return {
    name: candidate.name,
    kindLabel: i18n.t(KIND_KEYS[candidate.kind]),
    badges: badgesFor(candidate, i18n),
    provenanceLabel: provenanceOf(candidate, i18n),
  };
}

/** True when this kind can close a resupply gap (D1/D13: a hut never does). */
export function countsAsFoodPlace(candidate: ResupplyCandidate): boolean {
  if (candidate.kind === 'hut' || candidate.kind === 'post' || candidate.kind === 'parcel') {
    return false;
  }
  if (candidate.kind === 'fuel' && candidate.unmanned === true) return false;
  return true;
}

const DNT_HUTS_URL = 'https://www.dnt.no/hytter/';

/** The leg whose span contains `alongM` (the plan's legs are contiguous). */
function legAt(plan: ResupplyPlan, alongM: number): ResupplyLeg | null {
  // The warning belongs to the leg that **starts** here: that is the stretch the
  // point supplies food for. Returning the first containing leg instead picks
  // the leg that *ends* here, so a shop with a 7-day carry ahead showed no
  // warning while the last shop before the finish was flagged critical.
  const starting = plan.legs.find((leg) => Math.abs(leg.from.alongRouteM - alongM) <= 1);
  if (starting) return starting;
  // Not an anchor (a hut, an unmanned pump, a post point under carry-all): the
  // containing leg is the only leg it can belong to.
  for (const leg of plan.legs) {
    if (alongM >= leg.from.alongRouteM - 1 && alongM <= leg.to.alongRouteM + 1) return leg;
  }
  return null;
}

/** Distance from `alongM` to the next anchor (a usable point or the route end). */
function distanceToNextAnchor(plan: ResupplyPlan, alongM: number): number | null {
  let best: number | null = null;
  for (const leg of plan.legs) {
    if (leg.to.alongRouteM > alongM + 1) {
      const distance = leg.to.alongRouteM - alongM;
      best = best === null ? distance : Math.min(best, distance);
    }
  }
  return best;
}

export function buildResupplyView(
  state: ResupplyPanelState,
  i18n: ViewI18n,
): ResupplyViewModel {
  const attribution = i18n.t('supply.attribution');
  const note = i18n.t('supply.note');

  const message = (
    text: string,
    action: ResupplyAction,
    detail: string | null = null,
  ): ResupplyViewModel => ({
    state: 'message',
    message: text,
    detail,
    action,
    statusLine: '',
    indexLabel: null,
    hutsError: null,
    rows: [],
    legs: [],
    warnings: [],
    engineWarnings: [],
    totalsLabel: null,
    worstGapLabel: null,
    worstGapDanger: false,
    attribution,
    note,
    emptyMessage: null,
  });

  switch (state.kind) {
    case 'no-trip':
      return message(i18n.t('supply.noTrip'), 'open-route');
    case 'no-route':
      return message(i18n.t('supply.noRoute'), 'open-route');
    case 'no-profile':
      return message(i18n.t('supply.noProfile'), 'settings', state.detail ?? null);
    case 'loading':
      return { ...message(i18n.t('supply.loading'), 'none'), state: 'loading' };
    case 'index-failed':
      return message(
        i18n.t('supply.indexFailed', { message: firstLine(state.message) }),
        'retry',
        state.message,
      );
    case 'plan-failed':
      return message(
        i18n.t('supply.planFailed', { message: firstLine(state.message) }),
        'retry',
        state.message,
      );
    case 'ready':
      return buildReady(state.data, i18n, attribution, note);
  }
}

function buildReady(
  data: ResupplyData,
  i18n: ViewI18n,
  attribution: string,
  note: string,
): ResupplyViewModel {
  const { plan, candidates } = data;
  const usable = new Set(plan.resupplyPoints.map(candidateKey));

  const rows = [...candidates]
    .sort((a, b) => a.alongRouteM - b.alongRouteM)
    .map((candidate) => buildRow(candidate, plan, usable, i18n));

  const legs = plan.legs.map((leg) => buildLeg(leg, plan.maxCarryDays, i18n));

  const warnings = buildWarnings(data, i18n);

  const pointsLabel = i18n.t(
    rows.length === 1 ? 'supply.countOne' : 'supply.countMany',
    { count: i18n.format.number(rows.length, { maximumFractionDigits: 0 }) },
  );

  const indexDate = formatDay(data.indexBuiltAt, i18n.locale);
  const indexLabel = i18n.t('supply.indexLine', {
    date: indexDate,
    count: i18n.format.number(data.indexCount, { maximumFractionDigits: 0 }),
  });

  const worst = plan.gap;
  const worstGapLabel = worst
    ? i18n.t('supply.worstGap', {
        distance: i18n.format.distance(worst.distanceM),
        days: daysLabel(worst.days, i18n),
      })
    : null;

  return {
    state: 'ready',
    message: null,
    detail: null,
    action: 'retry',
    statusLine: pointsLabel,
    indexLabel,
    hutsError: data.hutsError
      ? i18n.t('supply.hutsFailed', { message: firstLine(data.hutsError) })
      : null,
    rows,
    legs,
    warnings: [
      ...warnings,
      // D3: a scheduled drop must be visible, with its pickup window. These are
      // informational, not warnings, so they read as a plan rather than a problem.
      ...plan.mailDrops.map((drop) => ({
        severity: 'info' as const,
        text: i18n.t('supply.mailDrop', {
          name: drop.name,
          // ISO days are for the plan engine; the user reads `1. juli 2026` (D8).
          arrival: drop.arrival ? formatDay(drop.arrival, i18n.locale) : '—',
          shipBy: drop.shipBy ? formatDay(drop.shipBy, i18n.locale) : '—',
          notBefore: drop.notBefore ? formatDay(drop.notBefore, i18n.locale) : '—',
          window: String(drop.windowDays),
        }),
      })),
    ],
    engineWarnings: plan.warnings,
    totalsLabel: i18n.t('supply.totals', {
      kg: i18n.format.number(plan.totalFoodKg, { maximumFractionDigits: 1 }),
      cost: i18n.format.number(plan.totalCostNok, { maximumFractionDigits: 0 }),
      days: daysLabel(plan.totalDays, i18n),
    }),
    worstGapLabel,
    worstGapDanger: worst?.exceedsMaxCarry === true,
    attribution,
    note,
    emptyMessage:
      rows.length === 0
        ? i18n.t('supply.empty', { radius: i18n.format.distance(data.radiusM) })
        : null,
  };
}

function buildRow(
  candidate: ResupplyCandidate,
  plan: ResupplyPlan,
  usable: ReadonlySet<string>,
  i18n: ViewI18n,
): ResupplyRowView {
  const countsAsFood = usable.has(candidateKey(candidate));
  const leg = legAt(plan, candidate.alongRouteM);
  const remaining = distanceToNextAnchor(plan, candidate.alongRouteM);
  const daysToNext =
    remaining === null ? null : remaining / 1000 / Math.max(0.001, plan.dailyDistanceKm);
  const gapDanger = leg?.carryDanger === true;
  const warning = gapDanger && leg
    ? i18n.t('supply.gapWarning', {
        name: candidate.name,
        kg: i18n.format.number(leg.foodKg, { maximumFractionDigits: 1 }),
        days: daysLabel(leg.days, i18n),
      })
    : null;

  const kindLabel = i18n.t(KIND_KEYS[candidate.kind]);
  const distanceLabel = i18n.t('supply.alongValue', {
    distance: i18n.format.distance(candidate.alongRouteM),
  });
  const detourLabel =
    candidate.detourM < 60
      ? i18n.t('supply.detourOnRoute')
      : i18n.t('supply.detourValue', { distance: i18n.format.distance(candidate.detourM) });
  const gapLabel =
    remaining === null || daysToNext === null
      ? null
      : i18n.t('supply.gapValue', {
          distance: i18n.format.distance(remaining),
          days: daysLabel(daysToNext, i18n),
        });
  const badges = badgesFor(candidate, i18n);
  // D1: a hut's food status is only checkable at DNT. Every other row is a
  // bundled fact with its provenance already shown.
  const checkUrl = candidate.kind === 'hut' ? DNT_HUTS_URL : null;

  return {
    id: candidateKey(candidate),
    name: candidate.name,
    kind: candidate.kind,
    kindLabel,
    point: candidate.point,
    alongRouteM: candidate.alongRouteM,
    distanceLabel,
    detourLabel,
    gapLabel,
    gapDanger,
    warning,
    badges,
    checkUrl,
    checkLabel: checkUrl === null ? null : i18n.t('supply.checkDnt'),
    countsAsFood,
    provenanceLabel: provenanceOf(candidate, i18n),
  };
}

function buildLeg(leg: ResupplyLeg, maxCarryDays: number, i18n: ViewI18n): ResupplyLegView {
  // The plan's boundary anchors are named 'Start'/'End' in English, and place
  // names are never translated (D8) — but these two are words, not places.
  const anchorName = (anchor: ResupplyLeg['from']): string =>
    anchor.kind === 'start'
      ? i18n.t('supply.anchorStart')
      : anchor.kind === 'end'
        ? i18n.t('supply.anchorEnd')
        : anchor.name;
  const title = i18n.t('supply.legTitle', {
    from: anchorName(leg.from),
    to: anchorName(leg.to),
  });
  const numbersLabel = i18n.t('supply.legNumbers', {
    distance: i18n.format.distance(leg.distanceM),
    days: daysLabel(leg.days, i18n),
    kcal: i18n.format.number(leg.kcal, { maximumFractionDigits: 0 }),
    kg: i18n.format.number(leg.foodKg, { maximumFractionDigits: 1 }),
    cost: i18n.format.number(leg.costNok, { maximumFractionDigits: 0 }),
  });
  return {
    id: leg.id,
    title,
    distanceLabel: i18n.format.distance(leg.distanceM),
    numbersLabel,
    carryWarning: leg.carryDanger
      ? i18n.t('supply.carryWarning', {
          kg: i18n.format.number(leg.foodKg, { maximumFractionDigits: 1 }),
          days: daysLabel(leg.days, i18n),
          max: i18n.format.number(maxCarryDays, { maximumFractionDigits: 0 }),
        })
      : null,
    danger: leg.carryDanger,
    engineWarnings: leg.warnings,
  };
}

/**
 * Codes this view renders in the user's own language, and the reviewed sentence
 * each one uses. Two codes share a sentence on purpose: the engine separates
 * "the only option is closed" from "closed, but there are alternatives", and
 * the reader needs the same fact either way.
 *
 * A code that is not here is deliberately left to the collapsed engine block
 * (see `ENGINE_ONLY_WARNING_CODES`). Nothing falls back to the engine's English
 * prose: matching the sentence is what used to erase a Norwegian warning while
 * its numbers stayed.
 */
export const LOCALISED_WARNING_KEYS: Readonly<
  Partial<Record<ResupplyPlanWarningCode, MessageKey>>
> = {
  'daily-km-fallback': 'supply.warnDailyKmFallback',
  'bridged-legs': 'supply.warnBridged',
  'staffed-fuel': 'supply.warnStaffedFuel',
  'sunday-closed-only-option': 'supply.warnClosedOnArrival',
  'closed-check-alternatives': 'supply.warnClosedOnArrival',
};

/**
 * Codes with no localised sentence, by decision: they stay in the engine's own
 * English inside the collapsed block, where their figures are shown too. The
 * list is explicit so a code has to be classified — a new one, from the engine
 * or the adapter, fails the resupply view test instead of quietly reaching a
 * Norwegian reader as an English sentence.
 */
export const ENGINE_ONLY_WARNING_CODES: readonly ResupplyPlanWarningCode[] = [
  'no-resupply',
  'gap-exceeds-max-carry',
  'verify-hours',
  'unverified',
  'stale-verification',
  'hut-unknown-no-food',
  'fuel-no-shop',
  'post-not-food',
  'selvbetjent-stock-not-guaranteed',
  'cache-unknown-contents',
  'point-off-route',
  'point-beyond-end',
  'mail-drop-ships-before-start',
  'mail-drop-window-before-start',
  'mail-drop-needs-start-date',
  'huts-sell-food',
  'huts-not-food',
  'unmanned-fuel',
  'hours-unverified',
  'point-detour',
];

/** The plan data a localised sentence needs where the warning carries no figures. */
export interface WarningFacts {
  readonly dailyDistanceKm: number;
  readonly candidates: readonly ResupplyCandidate[];
  /** The destination of the leg a leg-warning belongs to. */
  readonly legEndName?: string;
}

/**
 * The localised sentence for a warning, or `null` when the code is one the
 * engine block keeps. No figure is parsed out of `message`: every one comes from
 * the warning's own fields or from the plan, so rewording an engine sentence
 * cannot drop a localised warning while its numbers stay on screen.
 */
export function localisedWarningText(
  warning: ResupplyPlanWarning,
  i18n: ViewI18n,
  facts: WarningFacts,
): string | null {
  switch (warning.code) {
    case 'daily-km-fallback':
      return i18n.t('supply.warnDailyKmFallback', {
        km: i18n.format.number(facts.dailyDistanceKm, { maximumFractionDigits: 1 }),
      });
    case 'bridged-legs':
      if (warning.km === undefined) return null;
      return i18n.t('supply.warnBridged', {
        km: i18n.format.number(warning.km, { maximumFractionDigits: 1 }),
      });
    case 'staffed-fuel': {
      const staffed = facts.candidates
        .filter((candidate) => candidate.kind === 'fuel' && candidate.unmanned !== true)
        .sort((a, b) => a.alongRouteM - b.alongRouteM);
      if (staffed.length === 0) return null;
      return i18n.t('supply.warnStaffedFuel', {
        names: listOf(staffed.map((candidate) => candidate.name), i18n),
        count: i18n.format.number(staffed.length, { maximumFractionDigits: 0 }),
      });
    }
    case 'sunday-closed-only-option':
    case 'closed-check-alternatives':
      if (!warning.date || !facts.legEndName) return null;
      return i18n.t('supply.warnClosedOnArrival', {
        name: facts.legEndName,
        date: formatDay(warning.date, i18n.locale),
      });
    default:
      return null;
  }
}

/**
 * The things this plan refuses to let a user assume, said in the user's
 * language. Counts come from the candidates and the plan's own flags; no
 * arithmetic here is re-derived.
 *
 * The contractual ones — `daily-km-fallback`, `bridged-legs`, `staffed-fuel` and
 * the two `closed-*` codes behind `supply.warnClosedOnArrival` — qualify every
 * number below them, so they may not exist only as an English sentence inside
 * the collapsed engine block. Each is selected by its **code** and its figures
 * travel with the warning; the engine's prose is never read for meaning.
 */
function buildWarnings(data: ResupplyData, i18n: ViewI18n): ResupplyWarningView[] {
  const { plan, candidates } = data;
  const out: ResupplyWarningView[] = [];
  const facts: WarningFacts = { dailyDistanceKm: plan.dailyDistanceKm, candidates };
  const find = (code: ResupplyPlanWarningCode): ResupplyPlanWarning | undefined =>
    plan.warningDetails.find((warning) => warning.code === code);
  const push = (
    warning: ResupplyPlanWarning | undefined,
    severity: ResupplyWarningView['severity'],
    legEndName?: string,
  ): void => {
    if (!warning) return;
    const text = localisedWarningText(
      warning,
      i18n,
      legEndName === undefined ? facts : { ...facts, legEndName },
    );
    if (text === null) return;
    out.push({ severity, text });
  };

  // D14: with no daily distance the engine assumes one for every day count.
  push(find('daily-km-fallback'), 'warning');

  // Bridged legs: the distance is the plan's own figure, carried on the warning.
  push(find('bridged-legs'), 'warning');

  // D13: an unflagged station is assumed staffed, and the assumption is named.
  push(find('staffed-fuel'), 'warning');

  // A shop closed on the estimated arrival date: the day is on the warning, the
  // name is the destination of the leg the warning belongs to.
  const closed = new Set<string>();
  for (const leg of plan.legs) {
    for (const warning of leg.warningDetails) {
      if (
        warning.code !== 'sunday-closed-only-option' &&
        warning.code !== 'closed-check-alternatives'
      ) {
        continue;
      }
      const key = `${leg.to.name}@${warning.date ?? ''}`;
      if (closed.has(key)) continue;
      closed.add(key);
      push(warning, 'warning', leg.to.name);
    }
  }

  const huts = candidates.filter((candidate) => candidate.kind === 'hut');
  if (huts.length > 0) {
    out.push({
      severity: plan.hutsSellFood ? 'critical' : 'warning',
      text: i18n.t(
        plan.hutsSellFood
          ? 'supply.warnHutsCounted'
          : huts.length === 1
            ? 'supply.warnHutOne'
            : 'supply.warnHutMany',
        { names: namesOf(huts), count: i18n.format.number(huts.length, { maximumFractionDigits: 0 }) },
      ),
    });
  }

  const unmanned = candidates.filter(
    (candidate) => candidate.kind === 'fuel' && candidate.unmanned === true,
  );
  if (unmanned.length > 0) {
    out.push({
      severity: 'warning',
      text: i18n.t('supply.warnUnmannedFuel', { names: namesOf(unmanned) }),
    });
  }

  const food = candidates.filter((candidate) => candidate.kind !== 'hut');
  const noHours = food.filter((candidate) => candidate.hoursRecorded !== true);
  if (food.length > 0) {
    out.push({
      severity: 'info',
      text: i18n.t(
        noHours.length === 0 ? 'supply.warnHoursAll' : 'supply.warnHoursSome',
        {
          missing: i18n.format.number(noHours.length, { maximumFractionDigits: 0 }),
          total: i18n.format.number(food.length, { maximumFractionDigits: 0 }),
        },
      ),
    });
  }

  const detours = candidates.filter((candidate) => candidate.detourM > 2_000);
  if (detours.length > 0) {
    out.push({
      severity: 'warning',
      text: i18n.t('supply.warnDetour', {
        count: i18n.format.number(detours.length, { maximumFractionDigits: 0 }),
        names: listOf(detours.map((candidate) => candidate.name), i18n),
      }),
    });
  }

  const postPoints = candidates.filter(
    (candidate) => candidate.kind === 'post' || candidate.kind === 'parcel',
  );
  if (postPoints.length > 0 && plan.resupplyPoints.every((p) => p.kind !== 'post' && p.kind !== 'parcel')) {
    out.push({
      severity: 'info',
      text: i18n.t('supply.warnPostNotFood', {
        count: i18n.format.number(postPoints.length, { maximumFractionDigits: 0 }),
      }),
    });
  }

  if (plan.gap?.exceedsMaxCarry === true) {
    out.push({
      severity: 'critical',
      text: i18n.t('supply.warnGap', {
        distance: i18n.format.distance(plan.gap.distanceM),
        days: daysLabel(plan.gap.days, i18n),
        kg: i18n.format.number(plan.gap.foodKg, { maximumFractionDigits: 1 }),
      }),
    });
  }

  if (data.hutsError) {
    out.push({ severity: 'warning', text: i18n.t('supply.warnHutsFailed') });
  }

  return out;
}

function namesOf(candidates: readonly ResupplyCandidate[]): string {
  return candidates.map((candidate) => candidate.name).join(', ');
}

function listOf(names: readonly string[], i18n: ViewI18n): string {
  if (names.length === 0) return '';
  if (names.length <= 3) return names.join(', ');
  return i18n.t('supply.listMore', { shown: names.slice(0, 3).join(', '), more: names.length - 3 });
}

function firstLine(message: string): string {
  const line = message.split('\n')[0].trim();
  return line.length > 140 ? `${line.slice(0, 137)}…` : line;
}
