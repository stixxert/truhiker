import { describe, expect, it } from 'vitest';

import {
  isFoodSource,
  openAt,
  parseOpeningHours,
  planResupply,
  projectOntoRoute,
  routeLength,
  type ResupplyPoint,
} from '../../src/plan/resupply';

const POS = { lon: 8, lat: 61 } as const;

function point(
  id: string,
  distanceM: number,
  overrides: Partial<ResupplyPoint> = {},
): ResupplyPoint {
  return {
    id,
    kind: 'supermarket',
    position: POS,
    routeDistanceM: distanceM,
    confidence: 'curated',
    lastVerified: '2026-05-01',
    hours: '24/7',
    ...overrides,
  };
}

function codes(warnings: readonly { code: string }[]): string[] {
  return warnings.map((warning) => warning.code);
}

describe('isFoodSource — conservative defaults', () => {
  it('never assumes an unknown hut, an ubetjent hut, an automat, a post point or a cache is a shop, unless it is stated', () => {
    const cases: ReadonlyArray<readonly [string, ResupplyPoint, boolean]> = [
      ['unknown hut', point('h', 0, { kind: 'hut' }), false],
      ['hut that sells food', point('h', 0, { kind: 'hut', sellsFood: true }), true],
      ['ubetjent hut, even with a flag', point('h', 0, { kind: 'hut', hutKind: 'ubetjent', sellsFood: true }), false],
      ['fuel station', point('f', 0, { kind: 'fuel' }), false],
      ['fuel station, no shop', point('f', 0, { kind: 'fuel', hasShop: false }), false],
      ['staffed fuel station', point('f', 0, { kind: 'fuel', hasShop: true }), true],
      ['post point', point('p', 0, { kind: 'post' }), false],
      ['user cache', point('c', 0, { kind: 'cache' }), true],
    ];
    for (const [label, p, expected] of cases) expect(isFoodSource(p), label).toBe(expected);
  });
});

describe('opening hours', () => {
  it('applies OSM day semantics, stays unknown when it cannot parse, and handles multi-rule, overnight and day-list strings', () => {
    const sundayNoon = new Date(2026, 4, 17, 12, 0);
    const sundayEvening = new Date(2026, 4, 17, 18, 0);
    const mondayNoon = new Date(2026, 4, 18, 12, 0);
    const tuesdayNoon = new Date(2026, 4, 19, 12, 0);

    // A Mon–Sat shop is closed on Sunday.
    const monSat = { hours: 'Mo-Sa 09:00-17:00' };
    expect(openAt(monSat, sundayNoon)).toBe('closed');
    expect(openAt(monSat, tuesdayNoon)).toBe('open');

    // OSM semantics: Tu–Su INCLUDES Sunday (the Sunday-closed case is Mo-Sa).
    const tuSu = { hours: 'Tu-Su 09:00-17:00' };
    expect(openAt(tuSu, sundayNoon)).toBe('open');
    expect(openAt(tuSu, sundayEvening)).toBe('closed');
    expect(openAt(tuSu, mondayNoon)).toBe('closed');

    // Unknown is never "open".
    expect(openAt({}, sundayNoon)).toBe('unknown');
    expect(openAt({ hours: '' }, sundayNoon)).toBe('unknown');
    expect(openAt({ hours: 'by appointment' }, sundayNoon)).toBe('unknown');
    expect(openAt({ hours: 'Mo-Sa sunrise-sunset' }, sundayNoon)).toBe('unknown');

    // A midnight Date is a date-only query.
    expect(openAt(monSat, new Date(2026, 4, 19, 0, 0))).toBe('open');
    expect(openAt(monSat, new Date(2026, 4, 17, 0, 0))).toBe('closed');

    // 24/7 and multi-rule strings.
    expect(openAt({ hours: '24/7' }, sundayEvening)).toBe('open');
    expect(openAt({ hours: 'Mo-Fr 09:00-17:00; Sa 09:00-15:00; Su off' }, sundayNoon)).toBe('closed');
    expect(openAt({ hours: 'Mo-Fr 09:00-17:00; Sa 09:00-15:00' }, new Date(2026, 4, 16, 10))).toBe('open');

    // An interval that crosses midnight.
    const late = { hours: 'Fr 22:00-02:00' };
    expect(openAt(late, new Date(2026, 4, 16, 1, 0))).toBe('open'); // Saturday 01:00
    expect(openAt(late, new Date(2026, 4, 15, 23, 0))).toBe('open'); // Friday 23:00

    // Day lists and ranges parse to the right day numbers.
    const rules = parseOpeningHours('Mo,We,Fr-Su 10:00-18:00');
    expect(rules).not.toBeNull();
    expect(rules).toHaveLength(1);
    expect([...rules![0]!.days].sort()).toEqual([0, 1, 3, 5, 6]);
  });

  it('lets a later rule revoke an earlier one, so `Su off` closes a Sunday the first rule opened', () => {
    const sundayNoon = new Date(2026, 4, 17, 12, 0);
    const mondayNoon = new Date(2026, 4, 18, 12, 0);
    const sundayDateOnly = new Date(2026, 4, 17, 0, 0);
    const hours = { hours: 'Mo-Su 09:00-18:00; Su off' };
    expect(openAt(hours, sundayNoon)).toBe('closed');
    expect(openAt(hours, sundayDateOnly)).toBe('closed');
    expect(openAt(hours, mondayNoon)).toBe('open');

    // The verdict is order-sensitive: the same two rules the other way round
    // reopen Sunday, which is what OSM's "last matching rule wins" means.
    expect(openAt({ hours: 'Su off; Mo-Su 09:00-18:00' }, sundayNoon)).toBe('open');
    // A later `off` also closes an overnight interval that reaches into its day.
    expect(openAt({ hours: 'Fr 22:00-02:00; Sa off' }, new Date(2026, 4, 16, 1, 0))).toBe('closed');
    expect(openAt({ hours: 'Fr 22:00-02:00; Sa off' }, new Date(2026, 4, 15, 23, 0))).toBe('open');
    // An `off` for a day it does not name changes nothing.
    expect(openAt({ hours: 'Mo-Su 09:00-18:00; Su off' }, mondayNoon)).toBe('open');
    // Still never "open" when the rules cannot be understood.
    expect(openAt({ hours: 'Mo-Su 09:00-18:00; Su sunrise-sunset' }, sundayNoon)).toBe('unknown');
  });
});

describe('carry-all gap analysis', () => {
  it('reports the food mass, flags a leg beyond maxCarryDays and handles a zero-length route', () => {
    // A 7-day / 175 km gap yields ≈6.2–6.6 kg at the default mix.
    const week = planResupply({ distanceM: 175_000 }, [], {
      kcalPerDay: 4000,
      dailyDistanceKm: 25,
    });
    expect(week.legs).toHaveLength(1);
    expect(week.gap).not.toBeNull();
    expect(week.gap!.maxDays).toBeCloseTo(7, 6);
    expect(week.gap!.distanceM).toBe(175_000);
    expect(week.gap!.foodKg).toBeGreaterThan(6.2);
    expect(week.gap!.foodKg).toBeLessThan(6.6);
    expect(week.gap!.exceedsMaxCarry).toBe(false);
    expect(week.totals.foodKg).toBeCloseTo(week.gap!.foodKg, 9);
    expect(codes(week.warnings)).toContain('no-resupply');

    // A leg longer than maxCarryDays is flagged with its food mass.
    const long = planResupply({ distanceM: 200_000 }, [], { kcalPerDay: 4000, dailyDistanceKm: 25 });
    expect(long.gap!.maxDays).toBeCloseTo(8, 6);
    expect(long.gap!.exceedsMaxCarry).toBe(true);
    const gapWarning = long.warnings.find((w) => w.code === 'gap-exceeds-max-carry');
    expect(gapWarning?.severity).toBe('critical');
    // The gap length itself is the actionable part of the message.
    expect(gapWarning?.message).toMatch(/8\.0 days/);

    expect(
      planResupply({ distanceM: 125_000 }, [], {
        kcalPerDay: 4000,
        dailyDistanceKm: 25,
        maxCarryDays: 4,
      }).gap!.exceedsMaxCarry,
    ).toBe(true);

    // A zero-length route needs zero food.
    const none = planResupply({ distanceM: 0 }, [], { kcalPerDay: 4000 });
    expect(none.legs).toEqual([]);
    expect(none.gap).toBeNull();
    expect(none.totals).toMatchObject({ foodKg: 0, kcal: 0, costNok: 0 });
  });

  it('splits a route into legs at usable points and sums the totals', () => {
    const plan = planResupply({ distanceM: 100_000 }, [point('a', 25_000), point('b', 75_000)], {
      kcalPerDay: 4000,
      dailyDistanceKm: 25,
    });
    expect(plan.legs).toHaveLength(3);
    expect(plan.totals.distanceM).toBe(100_000);
    expect(plan.totals.days).toBeCloseTo(4, 6);
    expect(plan.totals.kcal).toBeCloseTo(16_000, 6);
    expect(plan.totals.foodKg).toBeCloseTo(16_000 / 4384.7433, 3);
    expect(plan.stops.map((s) => s.id)).toEqual(['start', 'a', 'b', 'end']);
  });
});

describe('conservative availability', () => {
  it('excludes and warns about unknown huts, automats and post points, and includes a staffed fuel station and a confirmed hut', () => {
    const plan = planResupply(
      { distanceM: 100_000 },
      [
        point('unknown-hut', 10_000, { kind: 'hut', hours: undefined }),
        point('ubetjent', 20_000, { kind: 'hut', hutKind: 'ubetjent', sellsFood: true }),
        point('automat', 30_000, { kind: 'fuel', hasShop: false }),
        point('post', 40_000, { kind: 'post' }),
        point('osm-shop', 60_000, { confidence: 'osm', hours: undefined, lastVerified: undefined }),
      ],
      { kcalPerDay: 4000, dailyDistanceKm: 25 },
    );
    const found = codes(plan.warnings);
    expect(found).toContain('hut-unknown-no-food');
    expect(found.filter((c) => c === 'hut-unknown-no-food')).toHaveLength(2);
    expect(found).toContain('fuel-no-shop');
    expect(found).toContain('post-not-food');
    expect(found).toContain('verify-hours');
    // Only the OSM supermarket is a leg node.
    expect(plan.stops.map((s) => s.id)).toEqual(['start', 'osm-shop', 'end']);

    const included = planResupply(
      { distanceM: 100_000 },
      [
        point('fuel', 25_000, { kind: 'fuel', hasShop: true }),
        point('hut', 75_000, { kind: 'hut', hutKind: 'selvbetjent', sellsFood: true }),
      ],
      { kcalPerDay: 4000, dailyDistanceKm: 25 },
    );
    expect(included.stops.map((s) => s.id)).toEqual(['start', 'fuel', 'hut', 'end']);
    expect(codes(included.warnings)).toContain('selvbetjent-stock-not-guaranteed');

    // Present hours do not trigger verify-hours.
    const verified = planResupply({ distanceM: 50_000 }, [point('a', 25_000)], {
      kcalPerDay: 4000,
      dailyDistanceKm: 25,
    });
    expect(codes(verified.warnings)).not.toContain('verify-hours');
  });

  it('warns for a point off the route geometry and one beyond the end, and throws when a point cannot be located', () => {
    const route = {
      points: [
        { lon: 8, lat: 61 },
        { lon: 8, lat: 61.1 },
      ],
      distanceM: 12_000,
    };
    const off = point('off', 0, {
      routeDistanceM: undefined,
      position: { lon: 8.05, lat: 61.05 },
    });
    const offPlan = planResupply(route, [off], { kcalPerDay: 4000, dailyDistanceKm: 25 });
    expect(codes(offPlan.warnings)).toContain('point-off-route');
    expect(offPlan.stops.map((s) => s.id)).toContain('off');

    const beyond = planResupply({ distanceM: 10_000 }, [point('far', 20_000)], {
      kcalPerDay: 4000,
    });
    expect(codes(beyond.warnings)).toContain('point-beyond-end');
    expect(beyond.stops.map((s) => s.id)).toEqual(['start', 'end']);

    const bare = point('lost', 0, { routeDistanceM: undefined });
    expect(() => planResupply({ distanceM: 10_000 }, [bare])).toThrow(
      /cannot locate resupply point lost/,
    );
  });
});

describe('Sunday handling in a plan', () => {
  const friday = new Date(2026, 4, 15, 9, 0);

  it('warns when a leg has only a Sunday-closed option, softens it when an alternative exists, and never claims a closure when hours are unknown', () => {
    const closed = point('closed-shop', 50_000, {
      hours: 'Mo-Sa 09:00-17:00',
      lastVerified: '2026-05-01',
    });
    const plan = planResupply({ distanceM: 100_000 }, [closed], {
      kcalPerDay: 4000,
      dailyDistanceKm: 25,
      startDate: friday,
    });
    // Friday + 2 days = Sunday at 50 km.
    const stop = plan.stops.find((s) => s.id === 'closed-shop');
    expect(stop?.arrivalDate).toBe('2026-05-17');
    expect(stop?.openOnArrival).toBe('closed');
    expect(codes(plan.warnings)).toContain('sunday-closed-only-option');

    const alternative = planResupply(
      { distanceM: 100_000 },
      [point('a', 50_000, { hours: 'Mo-Sa 09:00-17:00' }), point('b', 55_000, { hours: 'Mo-Sa 09:00-17:00' })],
      { kcalPerDay: 4000, dailyDistanceKm: 25, startDate: friday },
    );
    expect(codes(alternative.warnings)).toContain('closed-check-alternatives');
    expect(codes(alternative.warnings)).not.toContain('sunday-closed-only-option');

    const unknown = planResupply(
      { distanceM: 100_000 },
      [point('osm', 50_000, { hours: undefined, confidence: 'osm' })],
      { kcalPerDay: 4000, dailyDistanceKm: 25, startDate: friday },
    );
    expect(unknown.stops.find((s) => s.id === 'osm')?.openOnArrival).toBe('unknown');
    expect(codes(unknown.warnings)).toContain('verify-hours');
    expect(codes(unknown.warnings)).not.toContain('sunday-closed-only-option');
  });
});

describe('mail drops', () => {
  const start = new Date(2026, 5, 1, 9, 0); // Monday 2026-06-01

  it('computes arrival, shipBy and the parcel window, and uses 21 days for poste restante', () => {
    const parcel = planResupply(
      { distanceM: 200_000 },
      [point('parcel', 50_000, { kind: 'post', postKind: 'parcel' })],
      { support: 'mail-drops', kcalPerDay: 4000, dailyDistanceKm: 25, startDate: start },
    ).mailDrops[0]!;
    expect(parcel.kind).toBe('parcel');
    expect(parcel.dayIndex).toBeCloseTo(2, 9);
    expect(parcel.arrival).toBe('2026-06-03');
    expect(parcel.shipBy).toBe('2026-05-29');
    expect(parcel.notBefore).toBe('2026-05-27');
    expect(parcel.windowDays).toBe(7);

    const restante = planResupply(
      { distanceM: 200_000 },
      [point('pr', 50_000, { kind: 'post', postKind: 'poste-restante' })],
      { support: 'mail-drops', kcalPerDay: 4000, dailyDistanceKm: 25, startDate: start },
    ).mailDrops[0]!;
    expect(restante.kind).toBe('poste-restante');
    expect(restante.windowDays).toBe(21);
    const arrival = Date.parse(`${restante.arrival}T00:00:00Z`);
    const notBefore = Date.parse(`${restante.notBefore}T00:00:00Z`);
    expect((arrival - notBefore) / 86_400_000).toBe(21);
  });

  it('flags a drop that could not have been posted in time, excludes post points from carry-all, and warns without a start date', () => {
    const early = planResupply(
      { distanceM: 200_000 },
      [point('early', 20_000, { kind: 'post' })],
      { support: 'mail-drops', kcalPerDay: 4000, dailyDistanceKm: 25, startDate: start },
    );
    expect(early.mailDrops[0]!.shipBy! < '2026-06-01').toBe(true);
    const warning = early.warnings.find((w) => w.code === 'mail-drop-ships-before-start');
    expect(warning?.severity).toBe('critical');

    const later = planResupply(
      { distanceM: 200_000 },
      [point('later', 150_000, { kind: 'post' })],
      { support: 'mail-drops', kcalPerDay: 4000, dailyDistanceKm: 25, startDate: start },
    );
    expect(later.mailDrops[0]!.shipBy! >= '2026-06-01').toBe(true);
    expect(codes(later.warnings)).not.toContain('mail-drop-ships-before-start');

    // Post points are not shops, so carry-all ignores them.
    const carryAll = planResupply(
      { distanceM: 100_000 },
      [point('post', 50_000, { kind: 'post' })],
      { support: 'carry-all', kcalPerDay: 4000, dailyDistanceKm: 25, startDate: start },
    );
    expect(carryAll.mailDrops).toEqual([]);
    expect(carryAll.stops.map((s) => s.id)).toEqual(['start', 'end']);
    expect(codes(carryAll.warnings)).toContain('post-not-food');

    const dateless = planResupply(
      { distanceM: 100_000 },
      [point('post', 50_000, { kind: 'post' })],
      { support: 'mail-drops', kcalPerDay: 4000, dailyDistanceKm: 25 },
    );
    expect(dateless.mailDrops[0]!.arrival).toBeUndefined();
    expect(codes(dateless.warnings)).toContain('mail-drop-needs-start-date');
  });
});

describe('route projection helpers', () => {
  it('reports route length from geometry and projects a point onto the nearest segment', () => {
    const route = {
      points: [
        { lon: 8, lat: 61 },
        { lon: 8, lat: 61.1 },
      ],
    };
    const length = routeLength(route);
    expect(length).toBeGreaterThan(11_000);
    expect(length).toBeLessThan(11_200);

    const projection = projectOntoRoute(route, { lon: 8, lat: 61.05 });
    expect(projection.alongM).toBeGreaterThan(5_500);
    expect(projection.alongM).toBeLessThan(5_600);
    expect(projection.offsetM).toBeLessThan(1);
  });
});
