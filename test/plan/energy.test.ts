import { describe, expect, it } from 'vitest';

import {
  TERRAIN_FACTORS,
  bmr,
  crossCheck,
  estimateDay,
  gradeSplit,
  locomotionKcal,
  minettiCost,
  minettiGrossKcalPerHour,
  pandolfKcalPerHour,
  planDeficit,
  santeeKcalPerHour,
  walkingHours,
  type BodyProfile,
} from '../../src/plan/energy';

const MALE: BodyProfile = { massKg: 75, heightCm: 180, ageYears: 30, sex: 'male' };
const FEMALE: BodyProfile = { massKg: 65, heightCm: 168, ageYears: 30, sex: 'female' };

describe('Minetti 2002 net walking cost', () => {
  it('matches the published anchors, clamps outside ±45 %, and gets the U-shape right', () => {
    expect(minettiCost(0)).toBeCloseTo(2.5, 2);
    // Deliberately asymmetric: −10 % is the cheapest gradient, +10 % already
    // costs 4.4× more.
    const anchors: ReadonlyArray<readonly [number, number]> = [
      [-0.1, 1.1271],
      [0.1, 4.8991],
      [0.45, 17.6003],
    ];
    for (const [grade, expected] of anchors) expect(minettiCost(grade)).toBeCloseTo(expected, 3);

    expect(minettiCost(0.9)).toBe(minettiCost(0.45));
    expect(minettiCost(-0.9)).toBe(minettiCost(-0.45));

    // Unlike Pandolf, negative grades are fine.
    expect(Number.isFinite(minettiCost(-0.45))).toBe(true);
    expect(minettiCost(-0.1)).toBeLessThan(minettiCost(0));
    expect(minettiCost(0.1)).toBeGreaterThan(minettiCost(0));
  });
});

describe('BMR', () => {
  it('matches Mifflin–St Jeor, uses lean mass for Cunningham, defaults to Cunningham with body fat, and rejects impossible bodies', () => {
    // 10×75 + 6.25×180 − 5×30 + 5
    expect(bmr(MALE, 'mifflin-st-jeor')).toBeCloseTo(1730, 6);
    // 10×65 + 6.25×168 − 5×30 − 161
    expect(bmr(FEMALE, 'mifflin-st-jeor')).toBeCloseTo(1389, 6);

    // 500 + 22 × (75 × 0.85) = 1902.5
    const lean = bmr({ ...MALE, bodyFatPercent: 15 }, 'cunningham');
    expect(lean).toBeCloseTo(1902.5, 6);
    const ratio = lean / bmr(MALE, 'mifflin-st-jeor');
    expect(ratio).toBeGreaterThan(1.05);
    expect(ratio).toBeLessThan(1.15);

    const day = estimateDay({
      body: { ...MALE, bodyFatPercent: 15 },
      distanceM: 20_000,
      ascentM: 600,
      descentM: 600,
    });
    expect(day.bmrEquation).toBe('cunningham');
    expect(day.bmr).toBeCloseTo(1902.5, 6);
    expect(() => bmr(MALE, 'cunningham')).toThrow(/bodyFatPercent/);

    expect(() => bmr({ ...MALE, massKg: 0 })).toThrow(/body mass/);
    expect(() => bmr({ ...MALE, heightCm: Number.NaN })).toThrow(/height/);
  });
});

describe('Galdhøpiggen-style worked example', () => {
  // 75 kg walker, 15 kg pack, 30 km, 1200 m up and 1200 m down: the worked day
  // the model is checked against. It must land in 4,200–5,300 kcal.
  const day = estimateDay({
    body: MALE,
    packMassKg: 15,
    distanceM: 30_000,
    ascentM: 1_200,
    descentM: 1_200,
  });

  it('lands in the documented band with an honest component breakdown and the documented range', () => {
    expect(day.tdee).toBeGreaterThan(4_200);
    expect(day.tdee).toBeLessThan(5_300);

    // The range is 0.75 × TDEE … 1.30 × TDEE, not ±20 %.
    expect(day.range.p10).toBeCloseTo(day.tdee * 0.75, 9);
    expect(day.range.p90).toBeCloseTo(day.tdee * 1.3, 9);
    expect(day.range.p10).toBeLessThan(day.tdee);
    expect(day.range.p90).toBeGreaterThan(day.tdee);

    const { resting, locomotion, neat, thermoregulation, tef } = day.breakdown;
    for (const value of [resting, locomotion, neat, thermoregulation, tef]) {
      expect(value).toBeGreaterThan(0);
    }
    expect(resting + locomotion + neat + thermoregulation + tef).toBeCloseTo(day.tdee, 6);
    // TEF is 10 % of intake, solved at energy balance.
    expect(tef / day.tdee).toBeCloseTo(0.1, 6);
  });

  it('counts the pack as mass, splits the grade, applies the terrain factor and uses Naismith hours', () => {
    const withPack = locomotionKcal(30_000, 1_200, 1_200, 90);
    const withoutPack = locomotionKcal(30_000, 1_200, 1_200, 75);
    expect(withPack / withoutPack).toBeCloseTo(90 / 75, 6);

    // A there-and-back day is ±v/d, not level.
    const split = gradeSplit(30_000, 1_200, 1_200);
    expect(split.upGrade).toBeCloseTo(0.08, 6);
    expect(split.downGrade).toBeCloseTo(-0.08, 6);
    expect(split.upShare).toBeCloseTo(0.5, 6);

    // The default terrain is T-marked trail (1.18×).
    const trail = locomotionKcal(10_000, 0, 0, 90, 1.18);
    const asphalt = locomotionKcal(10_000, 0, 0, 90, 1.0);
    expect(trail / asphalt).toBeCloseTo(1.18, 9);

    // Flat + 1 h/600 m up + 1 h/1000 m down.
    expect(walkingHours({ distanceM: 30_000, ascentM: 1_200, descentM: 1_200 })).toBeCloseTo(
      30 / 3.5 + 2 + 1.2,
      6,
    );

    // The documented terrain table, and a female reference day in band.
    expect(TERRAIN_FACTORS).toEqual({
      asphalt: 1.0,
      gravel: 1.15,
      trail: 1.18,
      rough: 1.5,
      bog: 1.9,
    });

    const female = estimateDay({
      body: FEMALE,
      packMassKg: 13,
      distanceM: 25_000,
      ascentM: 1_000,
      descentM: 1_000,
    });
    expect(female.tdee).toBeGreaterThan(3_200);
    expect(female.tdee).toBeLessThan(4_000);
  });
});

describe('zero distance and the intake ceiling', () => {
  const bigDay = estimateDay({
    body: MALE,
    packMassKg: 15,
    distanceM: 30_000,
    ascentM: 1_200,
    descentM: 1_200,
  });

  it('has no locomotion and no food at zero distance, and a big day is unavoidably in deficit', () => {
    const day = estimateDay({ body: MALE, distanceM: 0 });
    expect(day.breakdown.locomotion).toBe(0);
    expect(day.totalMassKg).toBe(75);
    expect(Number.isFinite(day.tdee)).toBe(true);

    // A 30 km / 1200 m day exceeds 2.5 × BMR — the deficit is unavoidable.
    expect(bigDay.tdee).toBeGreaterThan(bigDay.intakeCeilingKcal);
    const plan = planDeficit({ day: bigDay, body: MALE });
    expect(plan.sustainable).toBe(false);
    expect(plan.unavoidableDeficitKcalPerDay).toBeCloseTo(bigDay.tdee - bigDay.intakeCeilingKcal, 6);
    expect(plan.unavoidableDeficitKcalPerDay).toBeGreaterThan(300);

    const short = estimateDay({
      body: MALE,
      packMassKg: 15,
      distanceM: 7_500,
      ascentM: 150,
      descentM: 150,
    });
    expect(short.tdee).toBeLessThan(short.intakeCeilingKcal);
    expect(planDeficit({ day: short, body: MALE }).sustainable).toBe(true);
  });
});

describe('deficit planning', () => {
  const bigDay = estimateDay({
    body: MALE,
    packMassKg: 15,
    distanceM: 30_000,
    ascentM: 1_200,
    descentM: 1_200,
  });

  it('plans min(12 % of TDEE, 75 % of the fat ceiling), lets fat limit a lean hiker, and flags an assumed body fat', () => {
    const plan = planDeficit({ day: bigDay, body: { ...MALE, bodyFatPercent: 18 } });
    expect(plan.fatMassKg).toBeCloseTo(75 * 0.18, 9);
    expect(plan.fatCeilingKcalPerDay).toBeCloseTo(69 * 75 * 0.18, 9);
    expect(plan.plannedDeficitKcalPerDay).toBeCloseTo(
      Math.min(0.12 * bigDay.tdee, 0.75 * plan.fatCeilingKcalPerDay),
      9,
    );

    const lean = planDeficit({ day: bigDay, body: { ...MALE, bodyFatPercent: 5 } });
    expect(lean.maxDeficitFromFat).toBeLessThan(lean.maxDeficitFromTdee);
    expect(lean.plannedDeficitKcalPerDay).toBeCloseTo(lean.maxDeficitFromFat, 9);
    expect(lean.fatMassAssumed).toBe(false);

    // The assumed body-fat default is flagged, not hidden.
    const assumed = planDeficit({ day: bigDay, body: MALE });
    expect(assumed.fatMassAssumed).toBe(true);
    expect(assumed.fatMassKg).toBeGreaterThan(0);
  });
});

describe('cross-checks', () => {
  it('agrees at level, reports a divergence off level, and fails loudly on a units bug', () => {
    const result = crossCheck({ bodyMassKg: 75, packMassKg: 15, speedMs: 1.33, grade: 0 });
    expect(result.agreed).toBe(true);
    expect(result.spread).toBeLessThan(0.35);
    expect(result.minettiKcalPerHour).toBeGreaterThan(0);
    expect(result.santeeKcalPerHour).toBeGreaterThan(0);
    expect(result.acsmKcalPerHour).toBeGreaterThan(0);

    // bodyMass 0 collapses Minetti/ACSM while Santee keeps its 71.1 constant —
    // exactly the kind of broken input a units error produces.
    expect(() => crossCheck({ bodyMassKg: 0, speedMs: 1.33, grade: 0 })).toThrow(
      /cross-check disagreement/,
    );

    // Pandolf refuses a mirrored grade; Minetti prices braking.
    const input = { bodyMassKg: 75, packMassKg: 15, speedMs: 1.33 };
    expect(() => pandolfKcalPerHour({ ...input, grade: -0.1 })).toThrow(/negative-grade/);
    expect(() => pandolfKcalPerHour({ ...input, grade: 0 })).not.toThrow();
    expect(pandolfKcalPerHour({ ...input, grade: 0.1 })).toBeGreaterThan(500);
    expect(() => minettiGrossKcalPerHour({ ...input, grade: -0.1 })).not.toThrow();

    // Off level the equations legitimately diverge: reported, not thrown.
    const mirrored = crossCheck({ ...input, grade: -0.1 });
    expect(mirrored.agreed).toBe(false);
    expect(mirrored.spread).toBeGreaterThan(0.35);

    // Santee agrees with its own level formula.
    expect(santeeKcalPerHour({ bodyMassKg: 75, speedMs: 1.33, grade: 0 })).toBeCloseTo(
      (3.28 * 75 + 71.1) * 1,
      6,
    );
  });
});
