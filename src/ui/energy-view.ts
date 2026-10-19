/**
 * The energy panel, as data.
 *
 * Two rules from `docs/DECISIONS.md` D10 and `docs/13` §2 shape everything here:
 *
 *  1. **A range, never a point estimate.** The band is TDEE × 0.75 … × 1.30.
 *     The midpoint is shown only *with* the band, labelled as the model's
 *     midpoint, because a single number is the one thing this panel must not
 *     become.
 *  2. **When TDEE exceeds the intake ceiling (2.5 × BMR) the deficit is
 *     structurally unavoidable** — that is the headline, not a footnote.
 *
 * The arithmetic belongs to `src/plan/energy.ts` (`estimateDay`, `planDeficit`);
 * this module only decides what to say about it. Elevation is a hard
 * prerequisite: without ascent and descent a day's expenditure would be a
 * guess dressed as a number, so the panel is **disabled with a reason** (D7).
 */

import type { UserProfile } from '../contracts';
import type { I18n, MessageKey } from '../i18n';
import {
  estimateDay,
  planDeficit,
  type BmrEquation,
  type DeficitPlan,
  type EnergyDay,
} from '../plan/energy';

/** The documented default food energy density (`docs/DECISIONS.md` D10). */
export const DEFAULT_FOOD_KCAL_PER_G = 4.4;
/** Energy in one kilogram of body fat: the usual planning constant. */
export const KCAL_PER_KG_FAT = 7700;

export interface EnergyAssumptions {
  /** kcal per gram of carried food. Editable; 4.4 is the documented default. */
  readonly foodKcalPerGram: number;
  /** Base pack mass without food, kg. Editable. */
  readonly packMassKg: number;
}

export interface EnergyInputs {
  readonly profile: UserProfile | null;
  /** Route length, metres. */
  readonly routeDistanceM: number | null;
  /** Total ascent over the route, metres. `null` = elevation unknown. */
  readonly ascentM: number | null;
  readonly descentM: number | null;
  readonly assumptions: EnergyAssumptions;
}

export type EnergyPanelState =
  | { kind: 'no-trip' }
  | { kind: 'no-route' }
  | { kind: 'no-profile' }
  | { kind: 'elevation-missing'; reason: 'dem' | 'scope' | 'loading' | 'none' }
  | { kind: 'invalid'; message: string }
  | { kind: 'ready'; model: EnergyModel };

export interface MassPoint {
  readonly day: number;
  readonly kg: number;
}

/** The numbers the panel renders. Every one of them comes from the model. */
export interface EnergyModel {
  readonly day: EnergyDay;
  readonly deficit: DeficitPlan;
  readonly days: number;
  /** km/day used for the representative day. */
  readonly dailyKm: number;
  /** Planned daily intake, kcal: TDEE − deficit, capped by the ceiling. */
  readonly intakeKcal: number;
  /** Daily deficit actually implied by `intakeKcal`. */
  readonly dailyDeficitKcal: number;
  /** Projected body-mass change over the trip, kg. Negative = loss. */
  readonly massChangeKg: number;
  /** Body mass the projection is relative to, kg (never body + pack). */
  readonly bodyMassKg: number;
  readonly massCurve: readonly MassPoint[];
  /** kg of food for the whole trip at the chosen density. */
  readonly foodKg: number;
  /** The editable inputs the model ran with. */
  readonly assumptions: EnergyAssumptions;
}

export interface EnergyViewModel {
  readonly state: 'message' | 'ready';
  readonly message: string | null;
  readonly detail: string | null;
  readonly action: 'none' | 'settings' | 'open-route';
  /**
   * The badge for a body nobody entered (B3): the numbers are computed from
   * `defaultProfile()`, and saying so is the only honest thing to do.
   */
  readonly profileNotice: string | null;
  /** The one sentence that matters: unavoidable, or not. */
  readonly headline: string;
  readonly headlineBody: string | null;
  readonly unsustainable: boolean;
  readonly rangeLabel: string | null;
  readonly rangeTitle: string;
  readonly centreLabel: string | null;
  readonly ceilingLabel: string | null;
  readonly bmrLabel: string | null;
  readonly intakeLabel: string | null;
  readonly rangeNote: string;
  readonly massTitle: string;
  readonly massLabel: string | null;
  readonly daysLabel: string | null;
  readonly foodMassLabel: string | null;
  readonly fatNote: string | null;
  readonly assumptionsTitle: string;
  readonly foodDensityLabel: string;
  readonly foodDensityHint: string;
  readonly packMassLabel: string;
  readonly packMassHint: string;
  readonly assumptions: EnergyAssumptions | null;
  /** Axis geometry for the range band, in kcal/day. Null when disabled. */
  readonly band: {
    readonly low: number;
    readonly high: number;
    readonly centre: number;
    readonly ceiling: number;
    readonly max: number;
  } | null;
  readonly curve: readonly MassPoint[];
}

type ViewI18n = Pick<I18n, 't' | 'locale' | 'format'>;

/** Extra inputs the panel needs to describe the inputs it was given. */
export interface EnergyViewOptions {
  /** The profile the numbers were computed from (the trip's own profile). */
  readonly profile?: UserProfile | null;
  /** `defaultProfile()` for this build; equality means the body was never entered. */
  readonly defaults?: UserProfile | null;
}

/**
 * True when the *body* is still the built-in placeholder.
 *
 * Only the body fields count: daily distance and start date are trip settings a
 * user reaches for first, and changing one of those does not mean the mass,
 * height and age were ever entered. `defaultProfile()` is 75 kg / 178 cm / 35 y
 * / male, and every energy number is derived from exactly those.
 */
export function isPlaceholderBody(profile: UserProfile, defaults: UserProfile): boolean {
  return (
    profile.massKg === defaults.massKg &&
    profile.heightCm === defaults.heightCm &&
    profile.ageYears === defaults.ageYears &&
    profile.sex === defaults.sex &&
    profile.bodyFatPercent === defaults.bodyFatPercent
  );
}

/**
 * The visible badge sentence for a placeholder body, or `null` when the profile
 * is the user's own. Used by the energy panel and the stats bar, so the two
 * cannot word the same caveat differently.
 */
export function placeholderProfileNotice(
  profile: UserProfile | null | undefined,
  defaults: UserProfile | null | undefined,
  i18n: ViewI18n,
): string | null {
  if (!profile || !defaults) return null;
  if (!isPlaceholderBody(profile, defaults)) return null;
  return i18n.t('energy.placeholderProfile', {
    mass: i18n.format.number(profile.massKg, { maximumFractionDigits: 0 }),
    height: i18n.format.number(profile.heightCm, { maximumFractionDigits: 0 }),
    age: i18n.format.number(profile.ageYears, { maximumFractionDigits: 0 }),
  });
}

const BMR_KEYS: Record<BmrEquation, MessageKey> = {
  'mifflin-st-jeor': 'energy.equation.mifflin',
  cunningham: 'energy.equation.cunningham',
};

/**
 * Compute the model for one representative day.
 *
 * A multi-day leg is `days ×` one day at the trip's own daily distance — the
 * energy model's own rule (`src/plan/energy.ts`), not a giant single day.
 * Returns `null` when the inputs cannot produce an honest number.
 */
export function computeEnergyModel(inputs: EnergyInputs): EnergyModel | null {
  const { profile } = inputs;
  if (!profile) return null;
  if (!(profile.massKg > 0) || !(profile.heightCm > 0) || !(profile.ageYears > 0)) return null;
  const distanceM = inputs.routeDistanceM;
  if (distanceM === null || !(distanceM > 0)) return null;
  if (inputs.ascentM === null || inputs.descentM === null) return null;
  const dailyKm = profile.dailyKm > 0 ? profile.dailyKm : 0;
  if (!(dailyKm > 0)) return null;

  const days = distanceM / 1000 / dailyKm;
  const perDayAscent = Math.max(0, inputs.ascentM) / Math.max(1, days);
  const perDayDescent = Math.max(0, inputs.descentM) / Math.max(1, days);

  const body = {
    massKg: profile.massKg,
    heightCm: profile.heightCm,
    ageYears: profile.ageYears,
    sex: profile.sex,
    ...(profile.bodyFatPercent !== undefined
      ? { bodyFatPercent: profile.bodyFatPercent }
      : {}),
  };

  const day = estimateDay({
    body,
    packMassKg: Math.max(0, inputs.assumptions.packMassKg),
    distanceM: dailyKm * 1000,
    ascentM: perDayAscent,
    descentM: perDayDescent,
    terrain: 'trail',
  });

  const deficit = planDeficit({ day, body });
  // Eating at the ceiling is the most you can do; the planned deficit is the
  // smaller, chosen one. The binding one is whichever is larger.
  const plannedIntake = Math.min(
    day.intakeCeilingKcal,
    Math.max(0, day.tdee - deficit.plannedDeficitKcalPerDay),
  );
  const dailyDeficitKcal = Math.max(0, day.tdee - plannedIntake);
  const massChangeKg = -(dailyDeficitKcal * days) / KCAL_PER_KG_FAT;

  const wholeDays = Math.max(1, Math.round(days));
  const massCurve: MassPoint[] = [];
  for (let index = 0; index <= wholeDays; index += 1) {
    const loss = (dailyDeficitKcal * Math.min(index, days)) / KCAL_PER_KG_FAT;
    // `-0` is not a number a user should ever see in an aria-label.
    massCurve.push({ day: index, kg: loss === 0 ? 0 : -loss });
  }

  // Food mass at the *user's* density, not the mix's: the assumption is shown
  // and editable, and this is the number it changes.
  const density = inputs.assumptions.foodKcalPerGram;
  const kcalPerGram = density > 0 ? density : DEFAULT_FOOD_KCAL_PER_G;
  const foodKg = (day.tdee * days) / (kcalPerGram * 1000);

  return {
    day,
    deficit,
    days,
    dailyKm,
    intakeKcal: plannedIntake,
    dailyDeficitKcal,
    massChangeKg,
    bodyMassKg: profile.massKg,
    massCurve,
    foodKg,
    assumptions: {
      foodKcalPerGram: inputs.assumptions.foodKcalPerGram,
      packMassKg: Math.max(0, inputs.assumptions.packMassKg),
    },
  };
}

export function buildEnergyView(
  state: EnergyPanelState,
  i18n: ViewI18n,
  options: EnergyViewOptions = {},
): EnergyViewModel {
  const profileNotice = placeholderProfileNotice(options.profile, options.defaults, i18n);
  const shell = (): EnergyViewModel => ({
    state: 'message',
    message: null,
    detail: null,
    action: 'none',
    profileNotice,
    headline: '',
    headlineBody: null,
    unsustainable: false,
    rangeLabel: null,
    rangeTitle: i18n.t('energy.rangeTitle'),
    centreLabel: null,
    ceilingLabel: null,
    bmrLabel: null,
    intakeLabel: null,
    rangeNote: i18n.t('energy.rangeNote'),
    massTitle: i18n.t('energy.massTitle'),
    massLabel: null,
    daysLabel: null,
    foodMassLabel: null,
    fatNote: null,
    assumptionsTitle: i18n.t('energy.assumptions'),
    foodDensityLabel: i18n.t('energy.foodDensity'),
    foodDensityHint: i18n.t('energy.foodDensityHint'),
    packMassLabel: i18n.t('energy.packMass'),
    packMassHint: i18n.t('energy.packMassHint'),
    assumptions: null,
    band: null,
    curve: [],
  });

  const unusable = (
    message: string,
    action: EnergyViewModel['action'],
    detail: string | null = null,
  ): EnergyViewModel => ({ ...shell(), message, action, detail });

  switch (state.kind) {
    case 'no-trip':
      return unusable(i18n.t('energy.noTrip'), 'open-route');
    case 'no-route':
      return unusable(i18n.t('energy.noRoute'), 'open-route');
    case 'no-profile':
      return unusable(i18n.t('energy.noProfile'), 'settings');
    case 'elevation-missing':
      return unusable(
        i18n.t('energy.elevationMissing', { reason: reasonOf(state.reason, i18n) }),
        'none',
        state.reason,
      );
    case 'invalid':
      return unusable(state.message, 'settings', state.message);
    case 'ready':
      return buildReady(state.model, i18n, shell());
  }
}

function reasonOf(reason: 'dem' | 'scope' | 'loading' | 'none', i18n: ViewI18n): string {
  switch (reason) {
    case 'dem':
      return i18n.t('energy.reasonDem');
    case 'scope':
      return i18n.t('energy.reasonScope');
    case 'loading':
      return i18n.t('energy.reasonLoading');
    case 'none':
      return i18n.t('energy.reasonNoRoute');
  }
}

function kcal(value: number, i18n: ViewI18n): string {
  return i18n.format.number(Math.round(value), { maximumFractionDigits: 0 });
}

function buildReady(
  model: EnergyModel,
  i18n: ViewI18n,
  shell: EnergyViewModel,
): EnergyViewModel {
  const { day, deficit } = model;
  const tdee = kcal(day.tdee, i18n);
  const ceiling = kcal(day.intakeCeilingKcal, i18n);
  const unavoidable = kcal(deficit.unavoidableDeficitKcalPerDay, i18n);
  const planned = kcal(deficit.plannedDeficitKcalPerDay, i18n);
  const unsustainable = !deficit.sustainable;

  const days = i18n.t('supply.dayValue', {
    value: i18n.format.number(model.days, { maximumFractionDigits: 1 }),
  });
  const massKg = i18n.format.number(model.massChangeKg, { maximumFractionDigits: 1 });

  return {
    ...shell,
    state: 'ready',
    message: null,
    // The headline is the verdict, never buried under the numbers.
    headline: i18n.t(
      unsustainable ? 'energy.unsustainableTitle' : 'energy.sustainableTitle',
    ),
    headlineBody: i18n.t(unsustainable ? 'energy.unsustainableBody' : 'energy.sustainableBody', {
      tdee,
      ceiling,
      deficit: unsustainable ? unavoidable : planned,
    }),
    unsustainable,
    rangeLabel: i18n.t('energy.rangeValue', {
      low: kcal(day.range.p10, i18n),
      high: kcal(day.range.p90, i18n),
    }),
    centreLabel: i18n.t('energy.centreLabel', { value: tdee }),
    ceilingLabel: i18n.t('energy.ceilingLabel', { value: ceiling }),
    bmrLabel: i18n.t('energy.bmrLabel', {
      value: kcal(day.bmr, i18n),
      equation: i18n.t(BMR_KEYS[day.bmrEquation]),
    }),
    intakeLabel: i18n.t('energy.plannedIntake', { value: kcal(model.intakeKcal, i18n) }),
    // Below 0.1 kg the projection is inside the model's own noise; saying
    // "no change" is more honest than printing a curve of a third of a gram.
    massLabel:
      model.dailyDeficitKcal <= 0 || Math.abs(model.massChangeKg) < 0.1
        ? i18n.t('energy.massNoChange')
        : i18n.t('energy.massResult', { kg: massKg, days }),
    daysLabel: i18n.t('energy.daysLabel', {
      days,
      km: i18n.format.distance(model.dailyKm * 1000),
    }),
    foodMassLabel: i18n.t('energy.foodMass', {
      kg: i18n.format.number(model.foodKg, { maximumFractionDigits: 1 }),
    }),
    fatNote: deficit.fatMassAssumed
      ? i18n.t('energy.fatAssumed', {
          // Relative to body mass: `totalMassKg` includes the pack, and body fat
          // is not a fraction of the pack.
          percent: i18n.format.number(
            (deficit.fatMassKg / Math.max(1, model.bodyMassKg)) * 100,
            { maximumFractionDigits: 0 },
          ),
        })
      : null,
    assumptions: { ...model.assumptions },
    band: {
      low: day.range.p10,
      high: day.range.p90,
      centre: day.tdee,
      ceiling: day.intakeCeilingKcal,
      max: Math.max(day.range.p90, day.intakeCeilingKcal) * 1.06,
    },
    // Below the model's own noise floor there is no curve to draw; the label
    // says so instead of showing a flat line that looks like a measurement.
    curve: Math.abs(model.massChangeKg) < 0.1 ? [] : model.massCurve,
  };
}
