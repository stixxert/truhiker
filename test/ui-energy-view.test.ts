/**
 * `buildEnergyView` — the energy panel's two promises.
 *
 *  1. A range, never a point estimate: the band is always present, and the
 *     midpoint is labelled as a midpoint.
 *  2. When TDEE exceeds 2.5 × BMR the deficit is *structurally unavoidable* and
 *     that is the headline — with numbers, in both languages.
 *
 * Plus the degradation rules: no elevation, no numbers; and the assumptions the
 * user can change (food density, pack mass) actually change the output.
 */

import { describe, expect, it } from 'vitest';

import type { UserProfile } from '../src/contracts';
import { createI18n } from '../src/i18n';
import {
  DEFAULT_FOOD_KCAL_PER_G,
  buildEnergyView,
  computeEnergyModel,
  type EnergyInputs,
} from '../src/ui/energy-view';

const no = createI18n('no');
const en = createI18n('en');

const PROFILE: UserProfile = {
  massKg: 75,
  heightCm: 180,
  ageYears: 30,
  sex: 'male',
  packBaseKg: 12,
  dailyKm: 30,
  dailyHours: 9,
  support: 'carry-all',
};

function inputs(overrides: Partial<EnergyInputs> = {}): EnergyInputs {
  return {
    profile: PROFILE,
    routeDistanceM: 120_000,
    ascentM: 4_800,
    descentM: 4_800,
    assumptions: { foodKcalPerGram: DEFAULT_FOOD_KCAL_PER_G, packMassKg: 12 },
    ...overrides,
  };
}

describe('energy view — the honest range and the unavoidable deficit', () => {
  it('shows the range as the headline number and the deficit as unavoidable when TDEE > 2,5 × BMR', () => {
    const model = computeEnergyModel(inputs())!;
    const view = buildEnergyView({ kind: 'ready', model }, no);

    expect(model.day.tdee).toBeGreaterThan(model.day.intakeCeilingKcal);
    expect(view.unsustainable).toBe(true);
    expect(view.headline).toBe('Underskuddet er strukturelt uunngåelig');
    expect(view.headlineBody).toContain('kan du ikke spise deg bort fra');

    // The band comes from the model, and the midpoint is named as one.
    const low = no.format.number(Math.round(model.day.range.p10), { maximumFractionDigits: 0 });
    const high = no.format.number(Math.round(model.day.range.p90), { maximumFractionDigits: 0 });
    expect(view.rangeLabel).toBe(`${low}–${high} kcal/dag`);
    expect(view.centreLabel).toContain('midtpunkt');
    expect(view.band).not.toBeNull();
    expect(view.band!.low).toBeLessThan(view.band!.ceiling);
    expect(view.band!.max).toBeGreaterThan(view.band!.high);

    // A four-day trip loses mass, and the curve is monotonic downwards.
    expect(view.massLabel).toContain('kg');
    expect(view.curve.length).toBeGreaterThan(2);
    const values = view.curve.map((point) => point.kg);
    expect(values[values.length - 1]).toBeLessThan(values[0]);
    expect(values[0]).toBe(0);

    const english = buildEnergyView({ kind: 'ready', model }, en);
    expect(english.headline).toBe('The deficit is structurally unavoidable');
    expect(english.ceilingLabel).toContain('2.5');
  });

  it('says so when the intake ceiling is enough, and disables everything without elevation', () => {
    // A short, flat day: the ceiling is above TDEE, so the deficit is a choice.
    const easy = computeEnergyModel(
      inputs({ profile: { ...PROFILE, dailyKm: 12 }, ascentM: 400, descentM: 400 }),
    )!;
    const view = buildEnergyView({ kind: 'ready', model: easy }, no);
    expect(view.unsustainable).toBe(false);
    expect(view.headline).toBe('Du kan spise nok');
    expect(view.headlineBody).toContain('et valg, ikke et krav');

    // Elevation missing is a disabled panel with a reason — never a zero.
    const disabled = buildEnergyView({ kind: 'elevation-missing', reason: 'dem' }, no);
    expect(disabled.state).toBe('message');
    expect(disabled.message).toContain('Høydedata mangler');
    expect(disabled.message).toContain('slått av');
    expect(disabled.rangeLabel).toBeNull();
    expect(disabled.band).toBeNull();
    expect(disabled.curve).toEqual([]);
    expect(disabled.headline).toBe('');

    // The model itself refuses to invent numbers without elevation.
    expect(computeEnergyModel(inputs({ ascentM: null }))).toBeNull();
    expect(computeEnergyModel(inputs({ profile: null }))).toBeNull();
  });

  it('lets the food density and pack mass be changed, and shows them', () => {
    const base = computeEnergyModel(inputs())!;
    const dense = computeEnergyModel(
      inputs({ assumptions: { foodKcalPerGram: 5.5, packMassKg: 12 } }),
    )!;
    const heavy = computeEnergyModel(
      inputs({ assumptions: { foodKcalPerGram: 4.4, packMassKg: 22 } }),
    )!;

    // 5.5 kcal/g carries less mass for the same energy; a heavier pack burns more.
    expect(dense.foodKg).toBeLessThan(base.foodKg);
    expect(heavy.day.tdee).toBeGreaterThan(base.day.tdee);

    const view = buildEnergyView({ kind: 'ready', model: dense }, no);
    expect(view.assumptions).toEqual({ foodKcalPerGram: 5.5, packMassKg: 12 });
    expect(view.foodDensityLabel).toContain('kcal/g');
    expect(view.packMassLabel).toContain('kg');
    expect(view.foodMassLabel).toMatch(/kg/);
  });
});
