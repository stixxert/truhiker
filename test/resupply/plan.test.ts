/**
 * `planResupplyForTrip` — legs, gaps, and the three things the plan refuses to
 * assume (hut food, unmanned fuel, and that anything is open).
 *
 * Offline and model-driven: the kcal/day comes from `src/plan/energy.ts` for the
 * trip's own profile, and food mass from `src/plan/nutrition.ts` through
 * `src/plan/resupply.ts`. Nothing here re-derives those numbers — the tests
 * assert the *relationship* (kg ≈ days × kcal/day ÷ 4.4 kcal/g) instead.
 */

import { describe, expect, it } from 'vitest';

import type { Trip, UserProfile } from '../../src/contracts';
import { pathLength, type LonLat } from '../../src/core/geo';
import type { ResupplyCandidate } from '../../src/resupply';
import { planResupplyForTrip } from '../../src/resupply';

/** 110 km due east at 62.5 N: the corridor with no shop in the middle. */
const ROUTE: LonLat[] = [
  { lon: 10.0, lat: 62.5 },
  { lon: 12.14, lat: 62.5 },
];
const ROUTE_M = pathLength(ROUTE);

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

function trip(points: readonly LonLat[] = ROUTE, profile: UserProfile = PROFILE): Trip {
  return {
    schemaVersion: 1,
    id: 'trip-gap',
    name: 'Gap test',
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

function candidate(
  kind: ResupplyCandidate['kind'],
  name: string,
  alongRouteM: number,
  extra: Partial<ResupplyCandidate> = {},
): ResupplyCandidate {
  const fraction = ROUTE_M > 0 ? alongRouteM / ROUTE_M : 0;
  return {
    kind,
    name,
    point: {
      lon: ROUTE[0].lon + (ROUTE[1].lon - ROUTE[0].lon) * fraction,
      lat: ROUTE[0].lat,
    },
    alongRouteM,
    detourM: 40,
    evidence: kind === 'hut' ? 'curated' : 'osm',
    ...extra,
  };
}

describe('planResupplyForTrip', () => {
  it('warns on a 110 km gap with the required kg, within 5 % of days × kcal/day ÷ 4.4', () => {
    const plan = planResupplyForTrip(
      trip(),
      [candidate('supermarket', 'Start shop', 500), candidate('supermarket', 'End shop', ROUTE_M - 500)],
    );

    // kcal/day is the energy model's estimate for this profile, and it comes
    // with its honest range — never a single number.
    expect(plan.kcalPerDay).toBeGreaterThan(2500);
    expect(plan.kcalRange.p10).toBeCloseTo(plan.kcalPerDay * 0.75, 6);
    expect(plan.kcalRange.p90).toBeCloseTo(plan.kcalPerDay * 1.3, 6);

    // start → shop → shop → end
    expect(plan.legs).toHaveLength(3);
    const gap = plan.legs[1];
    expect(gap.distanceM).toBeGreaterThan(105_000);
    expect(gap.days).toBeGreaterThan(7);
    expect(gap.carryDanger).toBe(true);

    // The warning names the mass to carry, and the mass is the model's.
    const text = plan.warnings.join('\n');
    expect(text).toContain(`${gap.foodKg.toFixed(1)} kg`);
    const expectedKg = (gap.days * plan.kcalPerDay) / 4400; // 4.4 kcal/g
    expect(Math.abs(gap.foodKg - expectedKg) / expectedKg).toBeLessThan(0.05);
    expect(gap.costNok).toBeGreaterThan(0);

    // Totals cover every leg, including the carrying from the start.
    expect(plan.totalFoodKg).toBeCloseTo(
      plan.legs.reduce((sum, leg) => sum + leg.foodKg, 0),
      6,
    );
    expect(plan.gap?.exceedsMaxCarry).toBe(true);
    // The plan spans the whole route: it starts at the route start and ends at
    // the route end, so no stretch of walking is unaccounted for.
    expect(plan.legs[0].from.kind).toBe('start');
    expect(plan.legs[0].to.name).toBe('Start shop');
    expect(plan.legs[plan.legs.length - 1].to.kind).toBe('end');
    expect(plan.legs.reduce((sum, leg) => sum + leg.distanceM, 0)).toBeCloseTo(ROUTE_M, 3);
  });

  it('does not let a hut close a gap by default, and says so; opt-in is explicit and flagged', () => {
    const hut = candidate('hut', 'Fondsbu', ROUTE_M / 2);

    const cautious = planResupplyForTrip(trip(), [hut]);
    // No food source: one leg for the whole route, and the mass for all of it.
    expect(cautious.resupplyPoints).toHaveLength(0);
    expect(cautious.legs).toHaveLength(1);
    expect(cautious.legs[0].distanceM).toBeCloseTo(ROUTE_M, 3);
    expect(cautious.warnings.join('\n')).toContain('NO food source');
    expect(cautious.warnings.join('\n')).toContain('Fondsbu');
    expect(cautious.gap?.exceedsMaxCarry).toBe(true);

    const optedIn = planResupplyForTrip(trip(), [hut], { hutsSellFood: true });
    expect(optedIn.hutsSellFood).toBe(true);
    expect(optedIn.resupplyPoints).toHaveLength(1);
    expect(optedIn.legs).toHaveLength(2);
    // Still not a fact: the plan reports the assertion as unverified.
    expect(optedIn.warnings.join('\n')).toContain('at your request');
    expect(optedIn.totalFoodKg).toBeCloseTo(cautious.totalFoodKg, 6);
  });

  it('counts an unmanned fuel station for nothing, and names the staffed-station assumption', () => {
    const unmanned = planResupplyForTrip(trip(), [
      candidate('fuel', 'Circle K Automat Brekken', ROUTE_M / 2, { unmanned: true }),
    ]);
    expect(unmanned.resupplyPoints).toHaveLength(0);
    expect(unmanned.legs).toHaveLength(1);
    expect(unmanned.warnings.join('\n')).toContain('flagged unmanned');

    const staffed = planResupplyForTrip(trip(), [
      candidate('fuel', 'Circle K Røros', ROUTE_M / 2),
    ]);
    expect(staffed.resupplyPoints).toHaveLength(1);
    expect(staffed.legs).toHaveLength(2);
    expect(staffed.warnings.join('\n')).toContain('assumed staffed');
  });
});
