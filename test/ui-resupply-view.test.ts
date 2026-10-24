/**
 * `buildResupplyView` — the honesty rules the resupply panel shows, enforced once.
 *
 * These tests assert what the *user reads*: the mandated labels, the absence of
 * any claim of being open, the inline carry warning, and a visible message for
 * every failure state.
 */

import { describe, expect, it } from 'vitest';

import type { Trip, UserProfile } from '../src/contracts';
import { pathLength, type LonLat } from '../src/core/geo';
import { createI18n } from '../src/i18n';
import { en as enStrings } from '../src/i18n/en';
import { no as noStrings } from '../src/i18n/no';
import { RESUPPLY_WARNING_CODES } from '../src/plan/resupply';
import {
  RESUPPLY_ADAPTER_WARNING_CODES,
  planResupplyForTrip,
  type ResupplyCandidate,
  type ResupplyPlan,
  type ResupplyPlanWarning,
  type ResupplyPlanWarningCode,
} from '../src/resupply';
import {
  buildResupplyView,
  ENGINE_ONLY_WARNING_CODES,
  LOCALISED_WARNING_KEYS,
  localisedWarningText,
  RADIUS_OPTIONS_M,
  DEFAULT_RADIUS_M,
} from '../src/ui/resupply-view';

const no = createI18n('no');
const en = createI18n('en');

const ROUTE: LonLat[] = [
  { lon: 10.0, lat: 62.5 },
  { lon: 11.0, lat: 62.5 },
];
const ROUTE_M = pathLength(ROUTE);

const PROFILE: UserProfile = {
  massKg: 75,
  heightCm: 180,
  ageYears: 30,
  sex: 'male',
  packBaseKg: 12,
  dailyKm: 5,
  dailyHours: 8,
  support: 'carry-all',
};

function trip(profile: UserProfile = PROFILE): Trip {
  return {
    schemaVersion: 1,
    id: 'trip-view',
    name: 'View test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    legs: [
      {
        id: 'leg-1',
        points: ROUTE.map((point) => ({ lon: point.lon, lat: point.lat })),
        provenance: [],
        distanceM: null,
        ascentM: null,
        descentM: null,
      },
    ],
    profile,
  };
}

function candidate(
  kind: ResupplyCandidate['kind'],
  name: string,
  alongRouteM: number,
  extra: Partial<ResupplyCandidate> = {},
): ResupplyCandidate {
  const fraction = alongRouteM / ROUTE_M;
  return {
    kind,
    name,
    point: {
      lon: ROUTE[0].lon + (ROUTE[1].lon - ROUTE[0].lon) * fraction,
      lat: ROUTE[0].lat,
    },
    alongRouteM,
    detourM: 60,
    evidence: kind === 'hut' ? 'curated' : 'osm',
    ...extra,
  };
}

function ready(
  candidates: readonly ResupplyCandidate[],
  options: {
    profile?: UserProfile;
    hutsError?: string | null;
    radiusM?: number;
  } = {},
) {
  const tripValue = trip(options.profile ?? PROFILE);
  return {
    kind: 'ready' as const,
    data: {
      candidates,
      plan: planResupplyForTrip(tripValue, candidates),
      indexBuiltAt: '2026-10-19T13:41:49.167Z',
      indexCount: 8571,
      hutsError: options.hutsError ?? null,
      fetchedAt: '2026-10-20T09:00:00.000Z',
      radiusM: options.radiusM ?? DEFAULT_RADIUS_M,
    },
  };
}

describe('resupply view — honesty', () => {
  it('labels a hut "ikke bekreftet", counts it as no food, and never says "open"', () => {
    const view = buildResupplyView(
      ready([
        candidate('hut', 'Fondsbu', ROUTE_M / 2),
        candidate('supermarket', 'Joker Dalsbygda', 200, { hoursRecorded: true }),
        candidate('supermarket', 'Coop Uten Åpningstider', 400),
        candidate('fuel', 'Uno-X Automat', 600, { unmanned: true }),
      ]),
      no,
    );
    const hut = view.rows.find((row) => row.name === 'Fondsbu')!;
    expect(hut.badges).toContain('ikke bekreftet');
    expect(hut.countsAsFood).toBe(false);
    expect(hut.provenanceLabel).toContain('Turrutebasen');

    // Hours are never read from the binary, so no point may claim to be open —
    // only whether OSM had the tag is known.
    const withHours = view.rows.find((row) => row.name === 'Joker Dalsbygda')!;
    const withoutHours = view.rows.find((row) => row.name === 'Coop Uten Åpningstider')!;
    expect(withHours.badges).toContain('åpningstider ikke lagret');
    expect(withoutHours.badges).toContain('åpningstider ukjent');
    for (const row of view.rows) {
      expect(row.badges.join(' ')).not.toMatch(/åpen/i);
    }

    // An unmanned fuel station is a card-only pump, not food.
    const fuel = view.rows.find((row) => row.name === 'Uno-X Automat')!;
    expect(fuel.badges).toContain('ubemannet');
    expect(fuel.countsAsFood).toBe(false);
    expect(view.warnings.some((warning) => warning.text.includes('Ubemannet'))).toBe(true);

    // D1: the hut's unconfirmed status comes with a place to check it. A shop is
    // a bundled fact with its provenance already shown, so it gets no link.
    expect(hut.checkUrl).toBe('https://www.dnt.no/hytter/');
    expect(hut.checkLabel).toBe('Sjekk hos DNT');
    expect(withHours.checkUrl).toBeNull();
    expect(withHours.checkLabel).toBeNull();
  });

  it('attaches the plan’s carry warning to the leg, in both languages', () => {
    const candidates = [
      candidate('supermarket', 'Start shop', 300, { hoursRecorded: true }),
      candidate('supermarket', 'End shop', ROUTE_M - 300, { hoursRecorded: true }),
    ];
    const view = buildResupplyView(ready(candidates), no);
    const legs = view.legs.filter((leg) => leg.danger);
    expect(legs).toHaveLength(1);
    expect(legs[0].carryWarning).toContain('Bær');
    expect(legs[0].carryWarning).toContain('kg');
    expect(view.worstGapDanger).toBe(true);
    expect(view.totalsLabel).toContain('kg mat');

    // The plan's boundary anchors are named 'Start'/'End'; those are words, not
    // place names, so they are translated (D8 translates the UI, not the places).
    expect(view.legs[0].title.startsWith('Start →')).toBe(true);
    expect(view.legs[view.legs.length - 1].title).toContain('Slutt');

    const english = buildResupplyView(ready(candidates), en);
    expect(english.legs.find((leg) => leg.danger)!.carryWarning).toContain('Carry');
    expect(english.legs[english.legs.length - 1].title).toContain('End');
    expect(english.rows[0].badges.join(' ')).toMatch(/hours/);
    // The engine's own sentences are kept verbatim, for traceability.
    expect(view.engineWarnings.length).toBeGreaterThan(0);
    expect(english.engineWarnings).toEqual(view.engineWarnings);
  });

  it('makes every failure visible: no trip, no route, no profile, index, plan, huts', () => {
    const states = [
      buildResupplyView({ kind: 'no-trip' }, no),
      buildResupplyView({ kind: 'no-route' }, no),
      buildResupplyView({ kind: 'no-profile' }, no),
      buildResupplyView({ kind: 'loading' }, no),
      buildResupplyView({ kind: 'index-failed', message: 'HTTP 503 from /data/shops.osm.bin' }, no),
      buildResupplyView({ kind: 'plan-failed', message: 'trip has no route geometry' }, no),
    ];
    for (const view of states) {
      expect(view.state).not.toBe('ready');
      expect((view.message ?? '').length).toBeGreaterThan(0);
      expect(view.rows).toEqual([]);
    }
    expect(states[0].action).toBe('open-route');
    expect(states[2].action).toBe('settings');
    expect(states[4].action).toBe('retry');
    expect(states[4].message).toContain('HTTP 503');
    expect(states[4].message).toContain('ikke at det ikke finnes butikker');

    // A hut failure is partial, not blank: the shops are still listed and the
    // reason is on screen.
    const partial = buildResupplyView(
      ready([candidate('supermarket', 'Joker', 300)], { hutsError: 'HTTP 504 from WFS' }),
      no,
    );
    expect(partial.state).toBe('ready');
    expect(partial.rows).toHaveLength(1);
    expect(partial.hutsError).toContain('HTTP 504');
    expect(partial.warnings.some((warning) => warning.text.includes('tjenesten'))).toBe(true);

    // An empty corridor says so, with the radius it actually used.
    const empty = buildResupplyView(ready([]), no);
    expect(empty.emptyMessage).toContain('5,00 km');
    expect(RADIUS_OPTIONS_M).toContain(DEFAULT_RADIUS_M);
  });
});

/**
 * The contractual warnings are selected by `code`, never by matching the
 * engine's English sentence: a reworded sentence used to make the Norwegian
 * warning vanish while its numbers stayed on screen.
 */
describe('resupply view — warnings are chosen by code, not by prose', () => {
  const ALL_CODES: ResupplyPlanWarningCode[] = [
    ...RESUPPLY_WARNING_CODES,
    ...RESUPPLY_ADAPTER_WARNING_CODES,
  ];

  function warningFor(code: ResupplyPlanWarningCode): ResupplyPlanWarning {
    return {
      code,
      severity: 'warning',
      // Deliberately reworded prose: nothing here should be matched.
      message: 'reworded engine sentence, 12.5 km, changed on 2026-05-24',
      km: 12.5,
      date: '2026-05-24',
    };
  }

  function dataFor(tripValue: Trip, candidates: readonly ResupplyCandidate[]) {
    return {
      kind: 'ready' as const,
      data: {
        candidates,
        plan: planResupplyForTrip(tripValue, candidates),
        indexBuiltAt: '2026-10-19T13:41:49.167Z',
        indexCount: 8571,
        hutsError: null,
        fetchedAt: '2026-10-20T09:00:00.000Z',
        radiusM: DEFAULT_RADIUS_M,
      },
    };
  }

  const FACTS = {
    dailyDistanceKm: 22.5,
    candidates: [
      candidate('fuel', 'Uno-X Dombås', 500),
      candidate('supermarket', 'Joker Dalsbygda', 800),
    ],
    legEndName: 'Joker Dalsbygda',
  };

  it('localises every contractual code in both languages and classifies every other code', () => {
    const localised = Object.keys(LOCALISED_WARNING_KEYS) as ResupplyPlanWarningCode[];
    const engineOnly = [...ENGINE_ONLY_WARNING_CODES];

    // Every code the engine or the adapter can emit is classified exactly once.
    // A new code that nobody classified — or a code quietly deleted — fails here,
    // so it cannot reach a Norwegian reader as an English sentence.
    expect([...localised, ...engineOnly].sort()).toEqual([...ALL_CODES].sort());
    expect(new Set([...localised, ...engineOnly]).size).toBe(ALL_CODES.length);

    for (const code of localised) {
      const key = LOCALISED_WARNING_KEYS[code]!;
      expect(noStrings[key].trim(), `no: ${code}`).not.toBe('');
      expect(enStrings[key].trim(), `en: ${code}`).not.toBe('');

      const textNo = localisedWarningText(warningFor(code), no, FACTS);
      const textEn = localisedWarningText(warningFor(code), en, FACTS);
      expect(textNo, `no: ${code}`).toBeTruthy();
      expect(textEn, `en: ${code}`).toBeTruthy();
      // No unfilled placeholder, no leftover English sentence, and the two
      // languages really differ — proof both dictionaries were read.
      expect(textNo).not.toContain('{');
      expect(textEn).not.toContain('{');
      expect(textNo).not.toBe(warningFor(code).message);
      expect(textEn).not.toBe(warningFor(code).message);
      expect(textNo).not.toBe(textEn);
    }

    // Everything else deliberately stays in the engine block: `null`, never the
    // engine's English prose as a fallback.
    for (const code of engineOnly) {
      expect(localisedWarningText(warningFor(code), no, FACTS), code).toBeNull();
      expect(localisedWarningText(warningFor(code), en, FACTS), code).toBeNull();
    }
  });

  it('carries the closed date and the bridged distance on the warning instead of parsing the sentence', () => {
    // Arrival at 51 km on 10 km/day from Tuesday 19 May 2026 is Sunday the 24th,
    // and this shop is shut on Sundays.
    const closedProfile: UserProfile = { ...PROFILE, dailyKm: 10, startDate: '2026-05-19' };
    const shop = candidate('supermarket', 'Joker Otta', 51_000, {
      openingHours: 'Mo-Sa 09:00-17:00',
      hoursRecorded: true,
    });
    const closedData = dataFor(trip(closedProfile), [shop]);
    const closure = closedData.data.plan.legs
      .flatMap((leg) => leg.warningDetails)
      .find(
        (warning) =>
          warning.code === 'sunday-closed-only-option' ||
          warning.code === 'closed-check-alternatives',
      );
    expect(closure?.date).toBe('2026-05-24');

    const closedNo = buildResupplyView(closedData, no);
    expect(
      closedNo.warnings.some(
        (warning) => warning.text.includes('Joker Otta') && warning.text.includes('24. mai 2026'),
      ),
    ).toBe(true);
    const closedEn = buildResupplyView(closedData, en);
    expect(
      closedEn.warnings.some(
        (warning) => warning.text.includes('Joker Otta') && warning.text.includes('24 May 2026'),
      ),
    ).toBe(true);

    // Two legs that do not meet: the bridged distance is the plan's own figure.
    const leg = (id: string, from: LonLat, to: LonLat) => ({
      id,
      points: [from, to].map((point) => ({ lon: point.lon, lat: point.lat })),
      provenance: [],
      distanceM: null,
      ascentM: null,
      descentM: null,
    });
    const bridgedTrip: Trip = {
      ...trip(),
      legs: [
        leg('leg-1', { lon: 10, lat: 62.5 }, { lon: 10.5, lat: 62.5 }),
        leg('leg-2', { lon: 10.55, lat: 62.5 }, { lon: 11, lat: 62.5 }),
      ],
    };
    const bridgedData = dataFor(bridgedTrip, [candidate('supermarket', 'Midt', 25_000)]);
    const bridged = bridgedData.data.plan.warningDetails.find(
      (warning) => warning.code === 'bridged-legs',
    );
    expect(bridged?.km).toBeGreaterThan(2);

    const bridgedNo = buildResupplyView(bridgedData, no);
    const figure = no.format.number(bridged!.km!, { maximumFractionDigits: 1 });
    expect(
      bridgedNo.warnings.some(
        (warning) => warning.text.includes('rett linje') && warning.text.includes(figure),
      ),
    ).toBe(true);
    const bridgedEn = buildResupplyView(bridgedData, en);
    expect(bridgedEn.warnings.some((warning) => warning.text.includes('straight line'))).toBe(true);
    // The English engine sentence is never what the localised warning says.
    for (const warning of [...bridgedNo.warnings, ...closedNo.warnings]) {
      expect(warning.text).not.toMatch(/do not meet|estimated arrival date/i);
    }
  });

  it('keeps the plan’s prose list and its structured list in step', () => {
    const plan: ResupplyPlan = planResupplyForTrip(trip(), [
      candidate('supermarket', 'Joker A', 300),
      candidate('fuel', 'Uno-X', 900),
    ]);
    expect(plan.warnings).toEqual(plan.warningDetails.map((warning) => warning.message));
    for (const leg of plan.legs) {
      expect(leg.warnings).toEqual(leg.warningDetails.map((warning) => warning.message));
    }
  });
});
