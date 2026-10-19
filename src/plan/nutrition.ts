/**
 * Food catalogue and the "what to buy" arithmetic.
 *
 * kcal/100 g are label/composition-table values for ordinary Norwegian
 * groceries. Prices are **indicative 2026 shelf prices** and are the volatile
 * part: treat `nokPer100g` as an order-of-magnitude, not a quote. The derived
 * kcal/NOK is what the planner actually uses, and it is the number that
 * separates a sensible resupply from a freeze-dried-only one:
 *
 *   staples              ~25–185 kcal/NOK
 *   REAL Turmat          ~4.0–4.4 kcal/NOK
 *
 * A 5,000 kcal freeze-dried day therefore costs ~1,100 NOK; the same day from
 * oats, oil, nuts and one freeze-dried dinner costs ~110–140 NOK. That ratio is
 * the reason the default mix exists.
 *
 * Sources: Norwegian Food Composition Table (Matvaretabellen) and producer
 * labels for kcal; REAL Turmat kcal range (450–516/100 g) and its 4.0–4.4
 * kcal/NOK from docs/01 §D8. Prices are the author's, not a live feed.
 */

type FoodCategory =
  | 'staple'
  | 'fat'
  | 'protein'
  | 'snack'
  | 'freeze-dried'
  | 'drink';

interface FoodItem {
  readonly id: string;
  readonly name: string;
  readonly nameEn: string;
  readonly kcalPer100g: number;
  /** Indicative shelf price, NOK per 100 g. Volatile — not a live price. */
  readonly nokPer100g: number;
  readonly category: FoodCategory;
  readonly note?: string;
}

/**
 * The catalogue. Dry weight unless stated; "makrell i tomat" and butter are
 * the wet exceptions, which is exactly why they are poor kcal/g.
 */
export const FOODS: readonly FoodItem[] = [
  {
    id: 'havregryn',
    name: 'Havregryn',
    nameEn: 'Rolled oats',
    kcalPer100g: 370,
    nokPer100g: 2.0,
    category: 'staple',
  },
  {
    id: 'ris',
    name: 'Ris (tørr)',
    nameEn: 'Rice (dry)',
    kcalPer100g: 350,
    nokPer100g: 3.0,
    category: 'staple',
  },
  {
    id: 'pasta',
    name: 'Pasta (tørr)',
    nameEn: 'Pasta (dry)',
    kcalPer100g: 360,
    nokPer100g: 2.5,
    category: 'staple',
  },
  {
    id: 'rapsolje',
    name: 'Rapsolje',
    nameEn: 'Rapeseed oil',
    kcalPer100g: 880,
    nokPer100g: 6.6,
    category: 'fat',
    note: 'Highest energy density in the bag; decant into a small bottle.',
  },
  {
    id: 'peanottsmor',
    name: 'Peanøttsmør',
    nameEn: 'Peanut butter',
    kcalPer100g: 600,
    nokPer100g: 15.0,
    category: 'fat',
  },
  {
    id: 'smor',
    name: 'Smør',
    nameEn: 'Butter',
    kcalPer100g: 720,
    nokPer100g: 10.0,
    category: 'fat',
    note: 'Poor in warm weather; use oil for long summer legs.',
  },
  {
    id: 'musli',
    name: 'Müsli',
    nameEn: 'Muesli',
    kcalPer100g: 380,
    nokPer100g: 6.0,
    category: 'staple',
  },
  {
    id: 'potetgull',
    name: 'Potetgull',
    nameEn: 'Crisps',
    kcalPer100g: 530,
    nokPer100g: 15.0,
    category: 'snack',
    note: 'Bulky but calorie-dense; a morale item, not a staple.',
  },
  {
    id: 'notter',
    name: 'Nøtter',
    nameEn: 'Nuts',
    kcalPer100g: 600,
    nokPer100g: 16.0,
    category: 'fat',
  },
  {
    id: 'knekkebrod',
    name: 'Knekkebrød',
    nameEn: 'Crispbread',
    kcalPer100g: 340,
    nokPer100g: 12.0,
    category: 'staple',
  },
  {
    id: 'rosiner',
    name: 'Rosiner',
    nameEn: 'Raisins',
    kcalPer100g: 300,
    nokPer100g: 12.0,
    category: 'snack',
  },
  {
    id: 'melkesjokolade',
    name: 'Melkesjokolade',
    nameEn: 'Milk chocolate',
    kcalPer100g: 540,
    nokPer100g: 20.0,
    category: 'snack',
  },
  {
    id: 'torrmelk',
    name: 'Tørrmelk',
    nameEn: 'Powdered milk',
    kcalPer100g: 500,
    nokPer100g: 14.0,
    category: 'protein',
  },
  {
    id: 'real-turmat',
    name: 'REAL Turmat',
    nameEn: 'REAL Turmat freeze-dried meal',
    kcalPer100g: 480,
    nokPer100g: 110.0,
    category: 'freeze-dried',
    note: 'Production range 450–516 kcal/100 g; ≈4.0–4.4 kcal/NOK. One dinner per day.',
  },
  {
    id: 'kvikklunsj',
    name: 'Kvikk Lunsj',
    nameEn: 'Kvikk Lunsj',
    kcalPer100g: 520,
    nokPer100g: 42.5,
    category: 'snack',
  },
  {
    id: 'makrell-i-tomat',
    name: 'Makrell i tomat',
    nameEn: 'Mackerel in tomato',
    kcalPer100g: 250,
    nokPer100g: 20.6,
    category: 'protein',
    note: 'Wet and heavy for its calories; protein and morale, not fuel.',
  },
];

const FOOD_BY_ID: ReadonlyMap<string, FoodItem> = new Map(
  FOODS.map((food) => [food.id, food]),
);

export function foodById(id: string): FoodItem {
  const food = FOOD_BY_ID.get(id);
  if (!food) throw new Error(`unknown food id: ${id}`);
  return food;
}

/** kcal per NOK for one item at the indicative price. */
export function kcalPerNok(food: FoodItem): number {
  if (!(food.nokPer100g > 0)) return Number.NaN;
  return food.kcalPer100g / food.nokPer100g;
}

// ---------------------------------------------------------------------------
// Mixes
// ---------------------------------------------------------------------------

interface MixComponent {
  readonly foodId: string;
  /** Share of the mix's **calories**, not its weight. Shares are normalised. */
  readonly kcalShare: number;
}

export interface FoodMix {
  readonly id: string;
  readonly label: string;
  readonly components: readonly MixComponent[];
}

/**
 * Default profile: "staples + one freeze-dried dinner".
 *
 * Shares are by calories. The default resolves to ≈4.38 kcal/g, which is the
 * ~4.4 kcal/g planning figure from docs/01 §D8: 4,000 kcal/day therefore
 * weighs ~0.91 kg and a 7-day carry ~6.4 kg. A freeze-dried-only mix is far
 * heavier per calorie *and* far more expensive; this profile is the sensible
 * middle that still contains one hot dinner.
 */
export const DEFAULT_MIX: FoodMix = {
  id: 'staples-plus-freeze-dried-dinner',
  label: 'Staples + one freeze-dried dinner',
  components: [
    { foodId: 'havregryn', kcalShare: 0.195 },
    { foodId: 'ris', kcalShare: 0.06 },
    { foodId: 'pasta', kcalShare: 0.135 },
    { foodId: 'rapsolje', kcalShare: 0.08 },
    { foodId: 'peanottsmor', kcalShare: 0.1 },
    { foodId: 'smor', kcalShare: 0.05 },
    { foodId: 'musli', kcalShare: 0.05 },
    { foodId: 'potetgull', kcalShare: 0.04 },
    { foodId: 'notter', kcalShare: 0.06 },
    { foodId: 'knekkebrod', kcalShare: 0.06 },
    { foodId: 'rosiner', kcalShare: 0.03 },
    { foodId: 'melkesjokolade', kcalShare: 0.04 },
    { foodId: 'torrmelk', kcalShare: 0.04 },
    { foodId: 'real-turmat', kcalShare: 0.04 },
    { foodId: 'kvikklunsj', kcalShare: 0.01 },
    { foodId: 'makrell-i-tomat', kcalShare: 0.01 },
  ],
};

/** A stress-test mix: everything freeze-dried. Useful for showing the cost. */
export const FREEZE_DRIED_MIX: FoodMix = {
  id: 'freeze-dried-only',
  label: 'Freeze-dried only',
  components: [{ foodId: 'real-turmat', kcalShare: 1 }],
};

/** The planning figure people quote: mixed dry load ≈4.4 kcal/g. */
export const KCAL_PER_GRAM_MIXED_DRY = 4.4;

interface MixStats {
  /** g of food per kcal of intake. */
  readonly gramsPerKcal: number;
  readonly kcalPerGram: number;
  readonly kcalPerKg: number;
  /** NOK per kcal at indicative prices. */
  readonly nokPerKcal: number;
  readonly nokPerKg: number;
  readonly kcalPerNok: number;
}

/** Energy density and cost of a mix, normalised over its calorie shares. */
export function mixStats(mix: FoodMix = DEFAULT_MIX): MixStats {
  if (mix.components.length === 0) throw new Error(`empty food mix: ${mix.id}`);
  let shareSum = 0;
  for (const component of mix.components) {
    if (!Number.isFinite(component.kcalShare) || component.kcalShare < 0) {
      throw new Error(`invalid kcalShare for ${component.foodId}: ${component.kcalShare}`);
    }
    // Validates the id eagerly so a typo fails here, not in a UI far away.
    foodById(component.foodId);
    shareSum += component.kcalShare;
  }
  if (!(shareSum > 0)) throw new Error(`food mix has no calories: ${mix.id}`);

  let gramsPerKcal = 0;
  let nokPerKcal = 0;
  for (const component of mix.components) {
    const food = foodById(component.foodId);
    const share = component.kcalShare / shareSum;
    const grams = share / (food.kcalPer100g / 100);
    gramsPerKcal += grams;
    nokPerKcal += grams * (food.nokPer100g / 100);
  }
  const kcalPerGram = 1 / gramsPerKcal;
  return {
    gramsPerKcal,
    kcalPerGram,
    kcalPerKg: kcalPerGram * 1000,
    nokPerKcal,
    nokPerKg: nokPerKcal * 1000,
    kcalPerNok: 1 / nokPerKcal,
  };
}

/**
 * Mass of food to carry/buy for `kcal`, in **kilograms**.
 *
 * `foodWeightFor(28000)` with the default mix is ≈6.4 kg — the number the
 * planner puts next to a 7-day gap.
 */
export function foodWeightFor(kcal: number, mix: FoodMix = DEFAULT_MIX): number {
  if (!Number.isFinite(kcal) || kcal < 0) throw new Error(`invalid kcal: ${kcal}`);
  if (kcal === 0) return 0;
  return (kcal * mixStats(mix).gramsPerKcal) / 1000;
}

/** Mass of food to carry/buy for `kcal`, in grams. */
export function foodGramsFor(kcal: number, mix: FoodMix = DEFAULT_MIX): number {
  return foodWeightFor(kcal, mix) * 1000;
}

/** Cost in NOK for `kcal` of a mix at indicative shelf prices. */
export function costFor(kcal: number, mix: FoodMix = DEFAULT_MIX): number {
  if (!Number.isFinite(kcal) || kcal < 0) throw new Error(`invalid kcal: ${kcal}`);
  if (kcal === 0) return 0;
  return kcal * mixStats(mix).nokPerKcal;
}

interface BuyListItem {
  readonly food: FoodItem;
  readonly kcal: number;
  readonly grams: number;
  readonly nok: number;
}

/**
 * The shopping list behind `foodWeightFor`: how many grams of each item to buy
 * for a leg. This is what makes the kg number actionable at the shelf.
 */
export function buyList(kcal: number, mix: FoodMix = DEFAULT_MIX): BuyListItem[] {
  if (!Number.isFinite(kcal) || kcal < 0) throw new Error(`invalid kcal: ${kcal}`);
  const shareSum = mix.components.reduce((sum, c) => sum + c.kcalShare, 0);
  if (!(shareSum > 0)) throw new Error(`food mix has no calories: ${mix.id}`);
  return mix.components.map((component) => {
    const food = foodById(component.foodId);
    const componentKcal = (kcal * component.kcalShare) / shareSum;
    const grams = componentKcal / (food.kcalPer100g / 100);
    return {
      food,
      kcal: componentKcal,
      grams,
      nok: (grams * food.nokPer100g) / 100,
    };
  });
}
