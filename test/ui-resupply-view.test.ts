/**
 * `buildResupplyView` — the honesty rules of `docs/13` §2, enforced once.
 *
 * These tests assert what the *user reads*: the mandated labels, the absence of
 * any claim of being open, the inline carry warning, and a visible message for
 * every failure state.
 */

import { describe, expect, it } from 'vitest';

import type { Trip, UserProfile } from '../src/contracts';
import { pathLength, type LonLat } from '../src/core/geo';
import { createI18n } from '../src/i18n';
import { planResupplyForTrip, type ResupplyCandidate } from '../src/resupply';
import { buildResupplyView, RADIUS_OPTIONS_M, DEFAULT_RADIUS_M } from '../src/ui/resupply-view';

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
    expect(withHours.badges).toContain('åpningstid ikke lest');
    expect(withoutHours.badges).toContain('åpningstid ukjent');
    for (const row of view.rows) {
      expect(row.badges.join(' ')).not.toMatch(/åpen/i);
    }

    // An unmanned fuel station is a card-only pump, not food.
    const fuel = view.rows.find((row) => row.name === 'Uno-X Automat')!;
    expect(fuel.badges).toContain('ubemannet');
    expect(fuel.countsAsFood).toBe(false);
    expect(view.warnings.some((warning) => warning.text.includes('Ubemannet'))).toBe(true);
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

    const english = buildResupplyView(ready(candidates), en);
    expect(english.legs.find((leg) => leg.danger)!.carryWarning).toContain('Carry');
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
