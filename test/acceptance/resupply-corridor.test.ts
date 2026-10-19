/**
 * Acceptance: the corridor a user actually sees.
 *
 * Four things a user must be able to get out of the resupply UI, end to end:
 *
 *  1. the shops the route passes (and only those) with a real along-route
 *     distance and a real detour;
 *  2. a 110 km gap produces a warning that names the food mass, and that mass
 *     is the model's — `days × kcal/day ÷ 4.4 kcal/g` within 5 %;
 *  3. a hut does not close the gap, and says "ikke bekreftet";
 *  4. when TDEE exceeds 2.5 × BMR the energy panel says the deficit is
 *     unavoidable and shows the range, not a point estimate.
 *
 * Everything is offline: the committed `data/shops.osm.bin` is read from disk
 * through a fake `fetch`, and nothing here touches the network.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { Trip, UserProfile } from '../../src/contracts';
import { createI18n } from '../../src/i18n';
import { pathLength, type LonLat } from '../../src/core/geo';
import {
  loadShopIndex,
  planResupplyForTrip,
  type ResupplyCandidate,
} from '../../src/resupply';
import { buildResupplyView, type ResupplyPanelState } from '../../src/ui/resupply-view';
import { buildEnergyView, computeEnergyModel } from '../../src/ui/energy-view';

const no = createI18n('no');

/** Joker Dalsbygda, 62.52748 N 11.10911 E — a real supermarket in the file. */
const JOKER_DALSBYGDA: LonLat = { lon: 11.10911, lat: 62.52748 };

/** A ~62 km east-west route at 62.529 N, 169 m north of that shop. */
const SHOP_ROUTE: LonLat[] = [
  { lon: 10.5, lat: 62.529 },
  { lon: 11.7, lat: 62.529 },
];

/** 110 km due east at 62.5 N: the stretch with no shop in the middle. */
const GAP_ROUTE: LonLat[] = [
  { lon: 10.0, lat: 62.5 },
  { lon: 12.14, lat: 62.5 },
];
const GAP_ROUTE_M = pathLength(GAP_ROUTE);

const PROFILE: UserProfile = {
  massKg: 75,
  heightCm: 180,
  ageYears: 30,
  sex: 'male',
  packBaseKg: 12,
  // 15 km/day is a realistic shoulder-season pace, so 110 km is > 7 days.
  dailyKm: 15,
  dailyHours: 8,
  support: 'carry-all',
};

function trip(points: readonly LonLat[], profile: UserProfile = PROFILE): Trip {
  return {
    schemaVersion: 1,
    id: 'trip-acceptance',
    name: 'Acceptance route',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    legs: [
      {
        id: 'leg-1',
        points: points.map((point) => ({ lon: point.lon, lat: point.lat })),
        provenance: [],
        distanceM: null,
        ascentM: null,
        descentM: null,
      },
    ],
    profile,
  };
}

function readyState(
  trip_: Trip,
  candidates: readonly ResupplyCandidate[],
  options: { hutsSellFood?: boolean } = {},
): ResupplyPanelState {
  return {
    kind: 'ready',
    data: {
      candidates,
      plan: planResupplyForTrip(trip_, candidates, { hutsSellFood: options.hutsSellFood }),
      indexBuiltAt: '2026-10-19T13:41:49.167Z',
      indexCount: 8571,
      hutsError: null,
      fetchedAt: '2026-10-20T09:00:00.000Z',
      radiusM: 5000,
    },
  };
}

function candidate(
  kind: ResupplyCandidate['kind'],
  name: string,
  route: readonly LonLat[],
  alongRouteM: number,
  extra: Partial<ResupplyCandidate> = {},
): ResupplyCandidate {
  const total = pathLength(route);
  const fraction = total > 0 ? Math.min(1, Math.max(0, alongRouteM / total)) : 0;
  const start = route[0];
  const end = route[route.length - 1];
  return {
    kind,
    name,
    point: {
      lon: start.lon + (end.lon - start.lon) * fraction,
      lat: start.lat + (end.lat - start.lat) * fraction,
    },
    alongRouteM,
    detourM: 40,
    evidence: kind === 'hut' ? 'curated' : 'osm',
    ...extra,
  };
}

describe('acceptance: resupply corridor', () => {
  it('finds the shop the route passes and excludes one 50 km away', async () => {
    const buffer = readFileSync(new URL('../../data/shops.osm.bin', import.meta.url));
    const bytes = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
    // The loader is the one network call in the resupply module; feed it the
    // committed file so this test is the same code path the app uses.
    const index = await loadShopIndex(async () =>
      new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
    );
    expect(index.count).toBe(8571);

    const found = index.alongRoute(SHOP_ROUTE, 5_000);
    const names = found.map((entry) => entry.name);
    expect(names).toContain('Joker Dalsbygda');
    // Coop Prix Budal is ~50.8 km away: a corridor query must not invent it.
    expect(names).not.toContain('Coop Prix Budal');

    const shop = found.find((entry) => entry.name === 'Joker Dalsbygda')!;
    const expected = pathLength([SHOP_ROUTE[0], JOKER_DALSBYGDA]);
    // Along-route distance is measured on the route, detour perpendicular to it.
    expect(Math.abs(shop.alongRouteM - expected)).toBeLessThan(500);
    expect(shop.detourM).toBeGreaterThan(100);
    expect(shop.detourM).toBeLessThan(400);

    // And it survives into the panel as a food source with a real distance.
    const view = buildResupplyView(readyState(trip(SHOP_ROUTE), found), no);
    const row = view.rows.find((entry) => entry.name === 'Joker Dalsbygda')!;
    expect(row.countsAsFood).toBe(true);
    expect(row.distanceLabel).toMatch(/km/);
    expect(row.badges.join(' ')).not.toMatch(/åpen/);
  });

  it('warns on a 110 km gap and names the food mass within 5 % of days × kcal ÷ 4,4', () => {
    const candidates = [
      candidate('supermarket', 'Start shop', GAP_ROUTE, 500, { hoursRecorded: true }),
      candidate('supermarket', 'End shop', GAP_ROUTE, GAP_ROUTE_M - 500, { hoursRecorded: true }),
    ];
    const tripValue = trip(GAP_ROUTE);
    const state = readyState(tripValue, candidates);
    const plan = (state as { data: { plan: ReturnType<typeof planResupplyForTrip> } }).data.plan;
    const view = buildResupplyView(state, no);

    const gapLeg = plan.legs.find((leg) => leg.carryDanger);
    expect(gapLeg).toBeDefined();
    expect(gapLeg!.days).toBeGreaterThan(7);
    expect(gapLeg!.distanceM).toBeGreaterThan(105_000);

    // The mass is the model's: days × kcal/day ÷ 4.4 kcal/g.
    const expectedKg = (gapLeg!.days * plan.kcalPerDay) / 4400;
    expect(Math.abs(gapLeg!.foodKg - expectedKg) / expectedKg).toBeLessThan(0.05);

    // ...and the warning the user reads names it.
    const legView = view.legs.find((leg) => leg.danger);
    expect(legView).toBeDefined();
    const kg = no.format.number(gapLeg!.foodKg, { maximumFractionDigits: 1 });
    expect(legView!.carryWarning).toContain(kg);
    expect(view.warnings.some((warning) => warning.severity === 'critical')).toBe(true);
    const gapWarning = view.warnings.find((warning) => warning.text.includes(kg));
    expect(gapWarning).toBeDefined();
    expect(view.worstGapDanger).toBe(true);
    expect(view.worstGapLabel).toMatch(/km/);

    // Row level, not just leg level: the warning belongs to the shop that the
    // long carry starts *at*. The first containing leg would have attached it to
    // the shop 500 m from the finish instead, and left this one unflagged.
    const start = view.rows.find((row) => row.name === 'Start shop')!;
    const end = view.rows.find((row) => row.name === 'End shop')!;
    expect(start.gapDanger).toBe(true);
    expect(start.warning).not.toBeNull();
    expect(start.warning).toContain('Start shop');

    // D3, surfaced: in mail-drop mode a post point is a scheduled drop with a
    // pickup window, and the plan says when to post it. It used to be computed
    // and then dropped by the adapter, so the UI promised nothing.
    const mailTrip = {
      ...tripValue,
      profile: { ...tripValue.profile, support: 'mail-drops' as const, startDate: '2026-06-01' },
    };
    const mailPlan = planResupplyForTrip(mailTrip, [
      ...candidates,
      candidate('post', 'Post i butikk Dombås', GAP_ROUTE, 50_000, { hoursRecorded: true }),
    ]);
    expect(mailPlan.mailDrops.length).toBeGreaterThan(0);
    const drop = mailPlan.mailDrops[0]!;
    expect(drop.name).toContain('Post i butikk');
    expect(drop.windowDays).toBeGreaterThan(0);
    expect(drop.shipBy ?? drop.arrival).toBeDefined();
    const mailView = buildResupplyView(
      readyState(mailTrip, [
        ...candidates,
        candidate('post', 'Post i butikk Dombås', GAP_ROUTE, 50_000, { hoursRecorded: true }),
      ]),
      no,
    );
    expect(
      mailView.warnings.some((w) => w.severity === 'info' && w.text.includes('Innlevering')),
    ).toBe(true);
    expect(start.warning).toContain(kg);
    expect(end.gapDanger).toBe(false);
    expect(end.warning).toBeNull();
    // The gap each row reports to the next point still comes from the plan.
    expect(start.gapLabel).toMatch(/km/);
    expect(end.gapLabel).not.toBeNull();
    // A 500 m leg is not "0 d": rounding to one decimal would print zero days.
    expect(end.gapLabel).toContain('< 0,1 d');
    expect(view.legs[0].numbersLabel).toContain('< 0,1 d');
  });

  it('does not let a hut close the gap, and labels it "ikke bekreftet"', () => {
    const hut = candidate('hut', 'Fondsbu', GAP_ROUTE, GAP_ROUTE_M / 2);
    const state = readyState(trip(GAP_ROUTE), [hut]);
    const view = buildResupplyView(state, no);
    const row = view.rows[0];

    expect(row.kindLabel).toBe('hytte');
    expect(row.badges).toContain('ikke bekreftet');
    expect(row.countsAsFood).toBe(false);
    // D1: "ikke bekreftet" is only honest with somewhere to check it.
    expect(row.checkUrl).toBe('https://www.dnt.no/hytter/');
    expect(row.checkLabel).toContain('DNT');
    // Nothing usable on the route: the plan is one leg, start to end.
    expect(view.legs).toHaveLength(1);
    expect(view.legs[0].danger).toBe(true);
    expect(view.warnings.some((warning) => warning.text.includes('ikke maskinlesbart'))).toBe(
      true,
    );

    // Opting in is the caller's assertion, and it is reported as one.
    const optedIn = buildResupplyView(
      readyState(trip(GAP_ROUTE), [hut], { hutsSellFood: true }),
      no,
    );
    expect(optedIn.legs).toHaveLength(2);
    expect(optedIn.warnings.some((warning) => warning.severity === 'critical')).toBe(true);
  });

  it('reports an unavoidable deficit when TDEE exceeds 2,5 × BMR, and never a point estimate', () => {
    // The D10 example day: 30 km with 1,200 m of ascent, for four days.
    const model = computeEnergyModel({
      profile: { ...PROFILE, dailyKm: 30 },
      routeDistanceM: 120_000,
      ascentM: 4_800,
      descentM: 4_800,
      assumptions: { foodKcalPerGram: 4.4, packMassKg: 12 },
    })!;
    expect(model).not.toBeNull();
    expect(model.day.tdee).toBeGreaterThan(model.day.intakeCeilingKcal);

    const view = buildEnergyView({ kind: 'ready', model }, no);
    expect(view.unsustainable).toBe(true);
    expect(view.headline).toContain('uunngåelig');
    expect(view.headlineBody).toContain('kan du ikke spise deg bort fra');
    // A range, with the midpoint labelled as a midpoint — never alone.
    expect(view.rangeLabel).toMatch(/–/);
    expect(view.rangeLabel).toContain('kcal/dag');
    expect(view.centreLabel).toContain('midtpunkt');
    expect(view.ceilingLabel).toContain('2,5');
    expect(view.foodMassLabel).toMatch(/kg/);
    expect(view.band!.low).toBeLessThan(view.band!.centre);
    expect(view.band!.high).toBeGreaterThan(view.band!.centre);
  });
});
