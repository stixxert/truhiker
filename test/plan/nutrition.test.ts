import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MIX,
  FOODS,
  FREEZE_DRIED_MIX,
  KCAL_PER_GRAM_MIXED_DRY,
  buyList,
  costFor,
  foodById,
  foodGramsFor,
  foodWeightFor,
  kcalPerNok,
  mixStats,
} from '../../src/plan/nutrition';

describe('food catalogue', () => {
  it('carries every researched kcal/100 g value and rejects an unknown id', () => {
    const expected: Record<string, number> = {
      havregryn: 370,
      ris: 350,
      pasta: 360,
      rapsolje: 880,
      peanottsmor: 600,
      smor: 720,
      musli: 380,
      potetgull: 530,
      notter: 600,
      knekkebrod: 340,
      rosiner: 300,
      melkesjokolade: 540,
      torrmelk: 500,
      'real-turmat': 480,
      kvikklunsj: 520,
      'makrell-i-tomat': 250,
    };
    for (const [id, kcal] of Object.entries(expected)) expect(foodById(id).kcalPer100g).toBe(kcal);
    expect(FOODS).toHaveLength(Object.keys(expected).length);

    expect(() => foodById('nope')).toThrow(/unknown food/);
  });

  it('puts REAL Turmat in its researched range and makes the staple-versus-freeze-dried cost gap visible', () => {
    const real = foodById('real-turmat');
    expect(real.kcalPer100g).toBeGreaterThanOrEqual(450);
    expect(real.kcalPer100g).toBeLessThanOrEqual(516);
    expect(kcalPerNok(real)).toBeGreaterThanOrEqual(4.0);
    expect(kcalPerNok(real)).toBeLessThanOrEqual(4.4);

    // docs/01 §D8: staples 70–125 kcal/NOK at conservative shelf prices;
    // REAL ≈4.5 kcal/NOK. Our catalogue spans that.
    expect(kcalPerNok(foodById('knekkebrod'))).toBeGreaterThan(20);
    expect(kcalPerNok(foodById('real-turmat'))).toBeLessThan(5);
    expect(kcalPerNok(foodById('havregryn'))).toBeGreaterThan(100);
  });
});

describe('default mix', () => {
  it('is "staples + one freeze-dried dinner" at the ~4.4 kcal/g planning density, normalised', () => {
    expect(DEFAULT_MIX.label).toMatch(/staples/i);
    expect(DEFAULT_MIX.components.some((c) => c.foodId === 'real-turmat')).toBe(true);

    const stats = mixStats(DEFAULT_MIX);
    expect(stats.kcalPerGram).toBeGreaterThan(4.3);
    expect(stats.kcalPerGram).toBeLessThan(4.5);
    expect(stats.kcalPerGram).toBeCloseTo(KCAL_PER_GRAM_MIXED_DRY, 0);

    // A 7-day / 4000 kcal leg weighs ≈6.2–6.6 kg.
    const kg = foodWeightFor(28_000);
    expect(kg).toBeGreaterThan(6.2);
    expect(kg).toBeLessThan(6.6);

    // Shares need not sum to exactly 1.
    const doubled = {
      ...DEFAULT_MIX,
      components: DEFAULT_MIX.components.map((c) => ({ ...c, kcalShare: c.kcalShare * 2 })),
    };
    expect(mixStats(doubled).kcalPerGram).toBeCloseTo(mixStats(DEFAULT_MIX).kcalPerGram, 9);

    // A freeze-dried-only mix is far more expensive per calorie.
    const staples = costFor(4_000, DEFAULT_MIX);
    const freezeDried = costFor(4_000, FREEZE_DRIED_MIX);
    expect(staples).toBeLessThan(200);
    expect(freezeDried).toBeGreaterThan(800);
    expect(freezeDried / staples).toBeGreaterThan(4);
  });
});

describe('weight and cost arithmetic', () => {
  it('is zero at zero kcal, linear in kcal, and rejects negative intake', () => {
    expect(foodWeightFor(0)).toBe(0);
    expect(foodGramsFor(0)).toBe(0);
    expect(costFor(0)).toBe(0);
    expect(foodWeightFor(8_000)).toBeCloseTo(foodWeightFor(4_000) * 2, 9);
    expect(costFor(8_000)).toBeCloseTo(costFor(4_000) * 2, 9);

    expect(() => foodWeightFor(-1)).toThrow(/invalid kcal/);
    expect(() => costFor(Number.NaN)).toThrow(/invalid kcal/);
  });

  it('buyList grams sum to the kg figure, kcal to the request, and nok to the cost', () => {
    const list = buyList(28_000);
    const grams = list.reduce((sum, item) => sum + item.grams, 0);
    const kcal = list.reduce((sum, item) => sum + item.kcal, 0);
    const nok = list.reduce((sum, item) => sum + item.nok, 0);
    expect(grams / 1000).toBeCloseTo(foodWeightFor(28_000), 6);
    expect(kcal).toBeCloseTo(28_000, 6);
    expect(nok).toBeCloseTo(costFor(28_000), 6);
  });

  it('a typo in a mix fails at mixStats, not in the UI', () => {
    expect(() =>
      mixStats({ id: 'bad', label: 'bad', components: [{ foodId: 'nope', kcalShare: 1 }] }),
    ).toThrow(/unknown food/);
    expect(() => mixStats({ id: 'empty', label: 'empty', components: [] })).toThrow(/empty/);
  });
});
