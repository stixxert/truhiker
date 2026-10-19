/**
 * Energy model — a component sum, never a single activity multiplier.
 *
 *   TDEE = resting (BMR × weighted hours)
 *        + Σ net locomotion above rest   (Minetti 2002)
 *        + non-walking NEAT
 *        + thermoregulation
 *        + TEF (≈10 % of intake)
 *
 * Why a sum: an activity multiplier ("BMR × 2.2") silently spends the resting
 * metabolism twice — once in the multiplier and once in the day's hours — and
 * it puts the pack weight in the wrong term. A sum makes each assumption
 * visible and lets the cross-check in `crossCheck()` catch a units mistake.
 *
 * ## Locomotion: Minetti et al. (2002), 5th-order polynomial
 *
 *   Cw(i) = 280.5 i⁵ − 58.7 i⁴ − 76.8 i³ + 51.9 i² + 19.6 i + 2.5   [J·kg⁻¹·m⁻¹]
 *
 * This is the **net** cost of walking, above standing/resting, and it is the
 * only widely used fit that covers negative gradients (−45 %…+45 %). It gets
 * the U-shape right: −10 % is the cheapest gradient (~0.27 kcal·kg⁻¹·km⁻¹) and
 * steeper descents get expensive again because braking costs energy.
 *
 * Do **not** substitute the widely copied 4th-order variant: it is not from the
 * paper. Do **not** substitute Pandolf for downhill: Pandolf has **no negative
 * grade data at all** and produces nonsense there (see `pandolfKcalPerHour`,
 * which throws for i < 0 on purpose).
 *
 * ## Load
 *
 * Pack mass is added to body mass: field evidence supports treating 1 kg of pack
 * much like 1 kg of body. A terrain factor η is then applied — 1.18 by default
 * for Norwegian T-marked trail. η is not a fudge: it captures surface
 * compliance, stepping, and course correction that a treadmill polynomial
 * cannot see.
 *
 * ## Honest uncertainty
 *
 * Reputable equations spread 28–37 % against each other. The range returned
 * here is therefore `tdee × 0.75 … tdee × 1.30`, which is wider than ±20 % on
 * the high side because under-prediction is the dangerous direction: it makes
 * you carry less food than you need. **Commit to the range, not the midpoint.**
 *
 * ## The ceiling matters more than the estimate
 *
 * Max sustainable intake is about 2.5 × BMR (Thurber et al. 2019), and fat
 * oxidation is capped at ≈69 kcal/day per kg of fat mass. On a 30 km / 1200 m
 * day a 75 kg male burns ~4,700 kcal while the ceiling is ~4,325 kcal: the
 * deficit is **structurally unavoidable**. `planDeficit()` says so explicitly
 * (`sustainable: false`) instead of hiding it.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Sex = 'male' | 'female';
export type BmrEquation = 'mifflin-st-jeor' | 'cunningham';

/** Terrain classes with the multiplicative cost factor η applied to Minetti. */
export type TerrainClass = 'asphalt' | 'gravel' | 'trail' | 'rough' | 'bog';

/**
 * Terrain factor η (dimensionless, multiplies Minetti's net cost).
 *
 * Anchor: 1.18 for Norwegian T-marked trail. Asphalt is the treadmill surface
 * the polynomial was fitted on, so 1.0. Bog is deliberately extreme (1.9):
 * energy cost there is dominated by mud suction and erratic step length, and it
 * is more honest to over-warn than to flatter a route.
 */
export const TERRAIN_FACTORS: Readonly<Record<TerrainClass, number>> = {
  asphalt: 1.0,
  gravel: 1.15,
  trail: 1.18,
  rough: 1.5,
  bog: 1.9,
};

/** Resolve a terrain class or a numeric η. Throws on a non-positive factor. */
export function terrainFactor(terrain: TerrainClass | number = 'trail'): number {
  const eta = typeof terrain === 'number' ? terrain : TERRAIN_FACTORS[terrain];
  if (!Number.isFinite(eta) || eta <= 0) {
    throw new Error(`invalid terrain factor: ${String(terrain)}`);
  }
  return eta;
}

export interface BodyProfile {
  readonly massKg: number;
  readonly heightCm: number;
  readonly ageYears: number;
  readonly sex: Sex;
  /**
   * Body-fat percentage. When present, Cunningham is the default BMR equation
   * (it needs lean body mass); otherwise Mifflin–St Jeor.
   */
  readonly bodyFatPercent?: number;
}

export interface EnergyInput {
  readonly body: BodyProfile;
  /** Pack + worn kit, kg. Added to body mass for locomotion. */
  readonly packMassKg?: number;
  /** Horizontal route distance for the day. */
  readonly distanceM: number;
  readonly ascentM?: number;
  readonly descentM?: number;
  readonly terrain?: TerrainClass | number;
  /** Flat-walking speed. Naismith-style climb/descent penalties are added. */
  readonly speedKmh?: number;
  /** Override the computed walking hours (e.g. from a pitch/pace model). */
  readonly walkingHours?: number;
  /** Camp-waking hours at 1.5 × BMR. Sleep fills the rest of the day. */
  readonly campHours?: number;
  /** Override sleep hours; camp hours then fill whatever remains. */
  readonly sleepHours?: number;
  /** Thermoregulation allowance, kcal/day. Default +150 (an estimate). */
  readonly thermoregulationKcal?: number;
  /** NEAT as a fraction of BMR. Default 0.08. */
  readonly neatFactor?: number;
  /** Force a BMR equation instead of the body-fat-driven default. */
  readonly bmrEquation?: BmrEquation;
}

export interface EnergyBreakdown {
  /** BMR × weighted hours (sleep 0.95, camp 1.5, walking 1.0). */
  readonly resting: number;
  /** Net Minetti locomotion above rest, including pack and terrain factor. */
  readonly locomotion: number;
  /** Non-walking NEAT (camp chores, fidgeting, gear). */
  readonly neat: number;
  /** Thermoregulation allowance. */
  readonly thermoregulation: number;
  /** Thermic effect of food: 10 % of intake, solved at energy balance. */
  readonly tef: number;
}

export interface DayHours {
  readonly walking: number;
  readonly camp: number;
  readonly sleep: number;
}

export interface EnergyRange {
  /** tdee × 0.75 — the low end of the honest model spread. */
  readonly p10: number;
  /** tdee × 1.30 — the high end; under-prediction is the dangerous direction. */
  readonly p90: number;
}

export interface EnergyDay {
  readonly tdee: number;
  readonly breakdown: EnergyBreakdown;
  readonly range: EnergyRange;
  readonly bmr: number;
  readonly bmrEquation: BmrEquation;
  readonly totalMassKg: number;
  readonly hours: DayHours;
  /** 2.5 × BMR (Thurber 2019) — max sustainable intake, kcal/day. */
  readonly intakeCeilingKcal: number;
}

export interface DeficitInput {
  readonly day: EnergyDay;
  readonly body: BodyProfile;
  /** Explicit fat mass, kg. If absent, derived from body-fat percentage. */
  readonly fatMassKg?: number;
  /** Explicit body-fat percentage, overriding the body profile. */
  readonly bodyFatPercent?: number;
}

export interface DeficitPlan {
  readonly tdee: number;
  readonly intakeCeilingKcal: number;
  readonly fatMassKg: number;
  /** True when body fat was assumed from a sex-typical default. */
  readonly fatMassAssumed: boolean;
  /** 69 kcal/day per kg of fat mass. */
  readonly fatCeilingKcalPerDay: number;
  /** min(0.12 × TDEE, 0.75 × fat ceiling). */
  readonly plannedDeficitKcalPerDay: number;
  readonly maxDeficitFromTdee: number;
  readonly maxDeficitFromFat: number;
  /** Intake implied by the planned deficit: TDEE − planned deficit. */
  readonly plannedIntakeKcal: number;
  /**
   * The headline. False when TDEE exceeds the intake ceiling, i.e. when the
   * deficit is structurally unavoidable no matter how well you eat.
   */
  readonly sustainable: boolean;
  /**
   * The part of the deficit you cannot avoid even eating at the intake
   * ceiling: max(0, TDEE − ceiling). Zero when sustainable.
   */
  readonly unavoidableDeficitKcalPerDay: number;
}

export interface CrossCheckInput {
  readonly bodyMassKg: number;
  readonly packMassKg?: number;
  /** Walking speed in metres/second. Default 1.33 m/s (4.8 km/h). */
  readonly speedMs?: number;
  /** Gradient as a fraction (0.10 = +10 %). May be negative. */
  readonly grade?: number;
  /** Resting metabolism for the Minetti gross figure. Default ≈1 kcal/kg/h. */
  readonly restingKcalPerHour?: number;
}

export interface CrossCheckResult {
  /** Minetti net cost + resting, kcal/h. */
  readonly minettiKcalPerHour: number;
  /** Santee/USARIEM walking equation, kcal/h. */
  readonly santeeKcalPerHour: number;
  /** ACSM walking VO₂ equation, kcal/h. */
  readonly acsmKcalPerHour: number;
  /** (max − min) / mean, as a fraction. */
  readonly spread: number;
  /** Spread within `CROSS_CHECK_TOLERANCE`. */
  readonly agreed: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const J_PER_KCAL = 4184;
export const GRAVITY = 9.81;

/** Minetti 2002 is only fitted within ±45 %. Outside it we clamp. */
export const MINETTI_GRADE_LIMIT = 0.45;

/** BMR multipliers for the three day states. */
export const SLEEP_BMR_FACTOR = 0.95;
export const CAMP_BMR_FACTOR = 1.5;
export const WALK_BMR_FACTOR = 1.0;

export const DEFAULT_SPEED_KMH = 3.5;
/** Naismith climb penalty: one hour per 600 m of ascent. */
export const ASCENT_HOURS_PER_M = 1 / 600;
/** Descent penalty: one hour per 1000 m of descent (quadriceps braking). */
export const DESCENT_HOURS_PER_M = 1 / 1000;
export const DEFAULT_CAMP_HOURS = 3.5;
/** Label this as an estimate: it is a placeholder for real weather. */
export const DEFAULT_THERMOREGULATION_KCAL = 150;
export const DEFAULT_NEAT_FACTOR = 0.08;
/** TEF is ~10 % of intake; at energy balance intake == TDEE. */
export const TEF_FRACTION = 0.1;

/** Max sustainable intake, multiple of BMR (Thurber et al. 2019). */
export const INTAKE_CEILING_BMR_MULTIPLE = 2.5;
/** Fat oxidation ceiling, kcal/day per kg of fat mass. */
export const FAT_KCAL_PER_KG_DAY = 69;
/** Largest deficit taken from TDEE at maintenance. */
export const SUSTAINABLE_DEFICIT_FRACTION = 0.12;
/** Largest fraction of the fat-oxidation ceiling a plan may use. */
export const FAT_DEFICIT_FRACTION = 0.75;

/** Range multipliers. Not ±20 %: asymmetric on purpose. */
export const RANGE_LOW_FACTOR = 0.75;
export const RANGE_HIGH_FACTOR = 1.3;

/** Sex-typical body-fat defaults, used only when nothing better is supplied. */
export const DEFAULT_BODY_FAT_PERCENT: Readonly<Record<Sex, number>> = {
  male: 18,
  female: 28,
};

/** Reputable equations spread 28–37 %. Beyond 35 % something is wrong. */
export const CROSS_CHECK_TOLERANCE = 0.35;
/** Level band within which a cross-check disagreement is treated as a bug. */
export const CROSS_CHECK_LEVEL_BAND = 0.02;

/** 1 W = 1 J/s = 3600 J/h = 3600/4184 kcal/h. */
const KCAL_PER_HOUR_PER_WATT = 3600 / J_PER_KCAL;

// ---------------------------------------------------------------------------
// BMR
// ---------------------------------------------------------------------------

/**
 * Mifflin–St Jeor (1990): 10 m + 6.25 h − 5 a + 5 (male) / −161 (female).
 * The default: it needs only mass, height, age and sex, and is the best-validated
 * general-population equation.
 */
export function mifflinStJeor(body: BodyProfile): number {
  const sign = body.sex === 'male' ? 5 : -161;
  return 10 * body.massKg + 6.25 * body.heightCm - 5 * body.ageYears + sign;
}

/**
 * Cunningham (1991): 500 + 22 × lean body mass (kg). Needs body-fat percentage.
 *
 * Choosing Cunningham over Mifflin–St Jeor moves the answer by roughly 8–10 %
 * for a lean hiker — that is a model choice, not a measurement. The range in
 * `EnergyDay` is deliberately wide enough to contain both.
 */
export function cunningham(body: BodyProfile): number {
  if (body.bodyFatPercent === undefined || !Number.isFinite(body.bodyFatPercent)) {
    throw new Error('Cunningham BMR needs bodyFatPercent');
  }
  if (body.bodyFatPercent < 0 || body.bodyFatPercent >= 75) {
    throw new Error(`bodyFatPercent out of range: ${body.bodyFatPercent}`);
  }
  const leanMassKg = body.massKg * (1 - body.bodyFatPercent / 100);
  return 500 + 22 * leanMassKg;
}

/**
 * BMR, kcal/day. Cunningham is the default when body fat is known; pass
 * `equation` to force one.
 */
export function bmr(body: BodyProfile, equation?: BmrEquation): number {
  validateBody(body);
  const chosen =
    equation ?? (body.bodyFatPercent !== undefined ? 'cunningham' : 'mifflin-st-jeor');
  return chosen === 'cunningham' ? cunningham(body) : mifflinStJeor(body);
}

function validateBody(body: BodyProfile): void {
  if (!Number.isFinite(body.massKg) || body.massKg <= 0) {
    throw new Error(`invalid body mass: ${body.massKg}`);
  }
  if (!Number.isFinite(body.heightCm) || body.heightCm <= 0) {
    throw new Error(`invalid height: ${body.heightCm}`);
  }
  if (!Number.isFinite(body.ageYears) || body.ageYears <= 0) {
    throw new Error(`invalid age: ${body.ageYears}`);
  }
  if (body.sex !== 'male' && body.sex !== 'female') {
    throw new Error(`invalid sex: ${String(body.sex)}`);
  }
}

// ---------------------------------------------------------------------------
// Locomotion — Minetti 2002, net of rest
// ---------------------------------------------------------------------------

/**
 * Minetti (2002) net walking cost in J·kg⁻¹·m⁻¹.
 *
 * `grade` is a fraction (0.10 = +10 %). Values outside ±0.45 are clamped
 * because the polynomial has no data there and diverges fast.
 */
export function minettiCost(grade: number): number {
  if (!Number.isFinite(grade)) throw new Error(`invalid grade: ${grade}`);
  const i = Math.max(-MINETTI_GRADE_LIMIT, Math.min(MINETTI_GRADE_LIMIT, grade));
  return (
    280.5 * i ** 5 -
    58.7 * i ** 4 -
    76.8 * i ** 3 +
    51.9 * i ** 2 +
    19.6 * i +
    2.5
  );
}


/**
 * Average net gradient of the uphill and downhill halves of a day.
 *
 * A day with 1200 m up and 1200 m down over 30 km is not "level": the U-shape
 * means up (+8 %) and down (−8 %) average 2.83 J·kg⁻¹·m⁻¹, not the 2.50 of a
 * flat walk. We split distance in proportion to vertical work, which is exact
 * for a there-and-back day and a good approximation otherwise.
 */
export function gradeSplit(
  distanceM: number,
  ascentM: number,
  descentM: number,
): { upGrade: number; downGrade: number; upShare: number; downShare: number } {
  const up = Math.max(0, ascentM);
  const down = Math.max(0, descentM);
  const vertical = up + down;
  if (!(distanceM > 0) || vertical <= 0) {
    return { upGrade: 0, downGrade: 0, upShare: 0, downShare: 0 };
  }
  // Both halves get the same magnitude: vertical work over the horizontal
  // distance allocated to that half.
  const grade = vertical / distanceM;
  return {
    upGrade: Math.min(MINETTI_GRADE_LIMIT, grade),
    downGrade: Math.max(-MINETTI_GRADE_LIMIT, -grade),
    upShare: up / vertical,
    downShare: down / vertical,
  };
}

/**
 * Net locomotion above rest, kcal for the day.
 *
 * `distanceM` is horizontal. Pack mass is part of `totalMassKg`; `eta` is the
 * terrain factor.
 */
export function locomotionKcal(
  distanceM: number,
  ascentM: number,
  descentM: number,
  totalMassKg: number,
  eta = TERRAIN_FACTORS.trail,
): number {
  if (!(distanceM > 0) || !(totalMassKg > 0)) return 0;
  const { upGrade, downGrade, upShare, downShare } = gradeSplit(
    distanceM,
    ascentM,
    descentM,
  );
  const vertical = Math.max(0, ascentM) + Math.max(0, descentM);
  const costPerKgM =
    vertical > 0
      ? upShare * minettiCost(upGrade) + downShare * minettiCost(downGrade)
      : minettiCost(0);
  return (costPerKgM * eta * totalMassKg * distanceM) / J_PER_KCAL;
}

/**
 * Walking hours for a day. Naismith flat speed plus explicit climb and descent
 * penalties, because a Minetti day with 1200 m of descent is longer on the feet
 * than the same distance flat.
 */
export function walkingHours(input: {
  distanceM: number;
  ascentM?: number;
  descentM?: number;
  speedKmh?: number;
}): number {
  const speed = input.speedKmh ?? DEFAULT_SPEED_KMH;
  if (!(speed > 0)) throw new Error(`invalid speed: ${speed}`);
  const distanceKm = Math.max(0, input.distanceM) / 1000;
  return (
    distanceKm / speed +
    Math.max(0, input.ascentM ?? 0) * ASCENT_HOURS_PER_M +
    Math.max(0, input.descentM ?? 0) * DESCENT_HOURS_PER_M
  );
}

// ---------------------------------------------------------------------------
// The day
// ---------------------------------------------------------------------------

/**
 * Estimate one day. Everything is per day: a multi-day leg is
 * `days × estimateDay()` with the daily distance, not one giant day.
 */
export function estimateDay(input: EnergyInput): EnergyDay {
  validateBody(input.body);
  const distanceM = input.distanceM;
  if (!Number.isFinite(distanceM) || distanceM < 0) {
    throw new Error(`invalid distance: ${distanceM}`);
  }
  const ascentM = Math.max(0, input.ascentM ?? 0);
  const descentM = Math.max(0, input.descentM ?? 0);
  const packMassKg = Math.max(0, input.packMassKg ?? 0);
  if (!Number.isFinite(packMassKg)) throw new Error(`invalid pack mass: ${input.packMassKg}`);

  const totalMassKg = input.body.massKg + packMassKg;
  const eta = terrainFactor(input.terrain);
  const bmrEquation =
    input.bmrEquation ??
    (input.body.bodyFatPercent !== undefined ? 'cunningham' : 'mifflin-st-jeor');
  const bmrKcal = bmr(input.body, bmrEquation);

  // Hours: walking, then camp, then sleep fills the rest.
  const computedWalking = walkingHours({
    distanceM,
    ascentM,
    descentM,
    speedKmh: input.speedKmh,
  });
  const walking = Math.min(24, Math.max(0, input.walkingHours ?? computedWalking));
  let camp: number;
  let sleep: number;
  if (input.sleepHours !== undefined) {
    sleep = Math.max(0, Math.min(24 - walking, input.sleepHours));
    camp = Math.max(0, 24 - walking - sleep);
  } else {
    camp = Math.max(0, Math.min(24 - walking, input.campHours ?? DEFAULT_CAMP_HOURS));
    sleep = Math.max(0, 24 - walking - camp);
  }

  const bmrPerHour = bmrKcal / 24;
  const resting =
    bmrPerHour *
    (sleep * SLEEP_BMR_FACTOR + camp * CAMP_BMR_FACTOR + walking * WALK_BMR_FACTOR);
  const locomotion = locomotionKcal(distanceM, ascentM, descentM, totalMassKg, eta);
  const neat = bmrKcal * (input.neatFactor ?? DEFAULT_NEAT_FACTOR);
  const thermoregulation = Math.max(
    0,
    input.thermoregulationKcal ?? DEFAULT_THERMOREGULATION_KCAL,
  );

  const beforeTef = resting + locomotion + neat + thermoregulation;
  // TEF = 10 % of intake; at energy balance intake == TDEE, so solve directly.
  const tdee = beforeTef / (1 - TEF_FRACTION);
  const tef = tdee - beforeTef;

  return {
    tdee,
    breakdown: { resting, locomotion, neat, thermoregulation, tef },
    range: { p10: tdee * RANGE_LOW_FACTOR, p90: tdee * RANGE_HIGH_FACTOR },
    bmr: bmrKcal,
    bmrEquation,
    totalMassKg,
    hours: { walking, camp, sleep },
    intakeCeilingKcal: INTAKE_CEILING_BMR_MULTIPLE * bmrKcal,
  };
}

// ---------------------------------------------------------------------------
// Deficit and the ceiling
// ---------------------------------------------------------------------------

/** Fat-oxidation supply ceiling, kcal/day (69 × fat mass). */
export function fatSupplyCeilingKcal(fatMassKg: number): number {
  if (!Number.isFinite(fatMassKg) || fatMassKg < 0) {
    throw new Error(`invalid fat mass: ${fatMassKg}`);
  }
  return FAT_KCAL_PER_KG_DAY * fatMassKg;
}

/**
 * The most important output in the planner.
 *
 * A safe deficit is the smaller of 12 % of TDEE and 75 % of the fat-oxidation
 * ceiling. But when TDEE exceeds 2.5 × BMR the deficit is not a choice: you
 * cannot eat enough. `sustainable: false` says that out loud, and
 * `unavoidableDeficitKcalPerDay` quantifies the gap. A planner that hides this
 * is recommending a 15 kg weight loss over five months without saying so.
 */
export function planDeficit(input: DeficitInput): DeficitPlan {
  const { day, body } = input;
  let fatMassAssumed = false;
  let fatMassKg: number;
  if (input.fatMassKg !== undefined) {
    fatMassKg = input.fatMassKg;
  } else {
    let bodyFatPercent = input.bodyFatPercent ?? body.bodyFatPercent;
    if (bodyFatPercent === undefined) {
      bodyFatPercent = DEFAULT_BODY_FAT_PERCENT[body.sex];
      fatMassAssumed = true;
    }
    if (!Number.isFinite(bodyFatPercent) || bodyFatPercent < 0) {
      throw new Error(`invalid bodyFatPercent: ${bodyFatPercent}`);
    }
    fatMassKg = (body.massKg * bodyFatPercent) / 100;
  }

  const fatCeiling = fatSupplyCeilingKcal(fatMassKg);
  const maxFromTdee = SUSTAINABLE_DEFICIT_FRACTION * day.tdee;
  const maxFromFat = FAT_DEFICIT_FRACTION * fatCeiling;
  const planned = Math.max(0, Math.min(maxFromTdee, maxFromFat));
  const plannedIntake = day.tdee - planned;
  const sustainable = day.tdee <= day.intakeCeilingKcal;
  // Even eating at the ceiling, a TDEE above it leaves a deficit.
  const unavoidable = Math.max(0, day.tdee - day.intakeCeilingKcal);

  return {
    tdee: day.tdee,
    intakeCeilingKcal: day.intakeCeilingKcal,
    fatMassKg,
    fatMassAssumed,
    fatCeilingKcalPerDay: fatCeiling,
    plannedDeficitKcalPerDay: planned,
    maxDeficitFromTdee: maxFromTdee,
    maxDeficitFromFat: maxFromFat,
    plannedIntakeKcal: plannedIntake,
    sustainable,
    unavoidableDeficitKcalPerDay: unavoidable,
  };
}

// ---------------------------------------------------------------------------
// Cross-checks
// ---------------------------------------------------------------------------

/**
 * Pandolf et al. (1977) metabolic rate in watts, as kcal/h.
 *
 * **Throws for any negative grade.** Pandolf's data contained no downhill
 * trials, so applying it below zero is a units-and-semantics error, not an
 * approximation. Tests assert that a mirrored grade throws here and does not
 * throw in Minetti.
 *
 * M = 1.5W + 2.0(W+L)(L/W)² + η(W+L)(1.5V² + 0.35VG)   [W]
 * W = body mass, L = load, V = m/s, G = grade in percent.
 */
export function pandolfKcalPerHour(input: {
  bodyMassKg: number;
  packMassKg?: number;
  speedMs?: number;
  grade?: number;
}): number {
  const grade = input.grade ?? 0;
  if (grade < 0) {
    throw new Error(
      'Pandolf (1977) has no negative-grade data; use Minetti for downhill',
    );
  }
  const body = input.bodyMassKg;
  const load = Math.max(0, input.packMassKg ?? 0);
  const speed = Math.max(0, input.speedMs ?? 1.33);
  const total = body + load;
  const watts =
    1.5 * body +
    2.0 * total * (load / body) ** 2 +
    total * (1.5 * speed ** 2 + 0.35 * speed * grade * 100);
  return watts * KCAL_PER_HOUR_PER_WATT;
}

/**
 * Santee/USARIEM walking equation (kcal/h), as specified in docs/01 §D8.
 *
 *   level = (3.28 × mTotal + 71.1) × (V / 1.33)
 *   uphill   + 3.5 × mTotal × g × h
 *   downhill + 2.4 × mTotal × g × h × 0.3^(α / 7.65)
 *
 * with h the vertical metres gained/lost per hour and α the grade in percent.
 * Gross is clamped to at least 25 % of the level value: an unclamped downhill
 * term can go negative, which is physically impossible.
 */
export function santeeKcalPerHour(input: CrossCheckInput): number {
  const body = input.bodyMassKg;
  const total = body + Math.max(0, input.packMassKg ?? 0);
  const speed = input.speedMs ?? 1.33;
  const grade = input.grade ?? 0;
  const level = (3.28 * total + 71.1) * (speed / 1.33);
  if (!(speed > 0)) return 0;
  const verticalPerHour = speed * 3600;
  const upM = verticalPerHour * Math.max(0, grade);
  const downM = verticalPerHour * Math.max(0, -grade);
  const alphaPercent = Math.abs(grade) * 100;
  const uphill = (3.5 * total * GRAVITY * upM) / J_PER_KCAL;
  const downhill =
    (2.4 * total * GRAVITY * downM * Math.pow(0.3, alphaPercent / 7.65)) / J_PER_KCAL;
  return Math.max(level + uphill + downhill, 0.25 * level);
}

/**
 * ACSM walking VO₂ equation, kcal/h.
 *
 *   VO₂ = 0.1 V + 1.8 V × grade + 3.5      [ml·kg⁻¹·min⁻¹], V in m/min
 *
 * Gross is clamped to ≥25 % of the level value for the same reason as Santee:
 * the linear grade term goes negative on steep descents.
 */
export function acsmKcalPerHour(input: CrossCheckInput): number {
  const total = input.bodyMassKg + Math.max(0, input.packMassKg ?? 0);
  const speed = input.speedMs ?? 1.33;
  if (!(speed > 0)) return 0;
  const metresPerMinute = speed * 60;
  const grade = input.grade ?? 0;
  const levelVo2 = 0.1 * metresPerMinute + 3.5;
  const vo2 = levelVo2 + 1.8 * metresPerMinute * grade;
  const clamped = Math.max(vo2, 0.25 * levelVo2, 0);
  // 1 L O₂ ≈ 5 kcal; ml/kg/min × kg / 1000 × 5 × 60 min.
  return (clamped * total * 5 * 60) / 1000;
}

/** Minetti gross (net + resting) in kcal/h, for comparison with Santee/ACSM. */
export function minettiGrossKcalPerHour(input: CrossCheckInput): number {
  const body = input.bodyMassKg;
  const total = body + Math.max(0, input.packMassKg ?? 0);
  const speed = input.speedMs ?? 1.33;
  if (!(speed > 0)) return 0;
  const resting = input.restingKcalPerHour ?? body;
  const net =
    (minettiCost(input.grade ?? 0) * total * speed * 3600) / J_PER_KCAL;
  return net + resting;
}

/**
 * Run all three estimators for the same walking hour.
 *
 * At level the three must agree within `CROSS_CHECK_TOLERANCE` (35 %). A larger
 * spread is almost always a units bug (speed in km/h treated as m/s is the
 * classic one), so this **throws** at level rather than returning a number you
 * might trust. Off level the equations legitimately diverge on steep grades —
 * the spread is reported but not thrown on.
 */
export function crossCheck(input: CrossCheckInput): CrossCheckResult {
  const minettiKcalPerHour = minettiGrossKcalPerHour(input);
  const santee = santeeKcalPerHour(input);
  const acsm = acsmKcalPerHour(input);
  const values = [minettiKcalPerHour, santee, acsm];
  const max = Math.max(...values);
  const min = Math.min(...values);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const spread = mean > 0 ? (max - min) / mean : 0;
  const agreed = spread <= CROSS_CHECK_TOLERANCE;
  const grade = input.grade ?? 0;
  if (!agreed && Math.abs(grade) <= CROSS_CHECK_LEVEL_BAND) {
    throw new Error(
      `cross-check disagreement ${(spread * 100).toFixed(0)} % at level ` +
        `(minetti ${minettiKcalPerHour.toFixed(0)}, santee ${santee.toFixed(0)}, ` +
        `acsm ${acsm.toFixed(0)} kcal/h) — likely a units bug`,
    );
  }
  return {
    minettiKcalPerHour,
    santeeKcalPerHour: santee,
    acsmKcalPerHour: acsm,
    spread,
    agreed,
  };
}
