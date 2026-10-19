# Phase 4 — resupply and energy in the UI

*The missing half of the acceptance scenario. The engines exist and are tested;
nothing yet shows them to a user.*

---

## 0. What the user must be able to answer

> **"Where do I resupply on this route, what do I carry between those points, and
> will I be able to eat enough?"**

1. Every shop, fuel station, post point and hut shown **on the route**, with the
   distance along the route and the detour from it.
2. The **gap** between successive resupply points, in km and days, with a warning
   where the gap exceeds what the user can carry.
3. Per leg: days, kcal needed, **kg of food to buy**, cost, and a carry warning.
4. An energy verdict: TDEE **range**, the intake ceiling, whether the deficit is
   structurally unavoidable, and the projected body-mass change.
5. Every number traceable: OSM/ODbL, `opening_hours` confidence, hut evidence,
   and when it was fetched.

## 1. Module surface (fixed)

```ts
// src/resupply/index.ts
export interface ShopIndex {
  readonly count: number;
  readonly builtAt: string;
  /** Points within `radiusM` of the route polyline, with along-route distance. */
  alongRoute(points: readonly LonLat[], radiusM: number): ResupplyCandidate[];
  near(point: LonLat, radiusM: number): ResupplyCandidate[];
}
export interface ResupplyCandidate {
  readonly kind: 'supermarket' | 'convenience' | 'general' | 'grocery' | 'fuel' | 'post' | 'parcel' | 'hut';
  readonly name: string;
  readonly point: LonLat;
  readonly alongRouteM: number;
  readonly detourM: number;
  /** OSM confidence: hours present, brand known, hut type confirmed. */
  readonly evidence: 'osm' | 'chain-verified' | 'curated';
  readonly openingHours?: string;
}
export function loadShopIndex(fetchImpl: typeof fetch): Promise<ShopIndex>;

// huts come live from Turrutebasen app:RuteInfoPunkt (same WFS, lon,lat bbox)
export function fetchHutsAlong(route: readonly LonLat[], opts?: { radiusM?: number }): Promise<ResupplyCandidate[]>;

// src/resupply/plan.ts — wraps src/plan
export interface ResupplyPlan {
  readonly legs: ResupplyLeg[];
  readonly warnings: string[];
  readonly totalFoodKg: number;
  readonly totalCostNok: number;
}
export function planResupplyForTrip(
  trip: Trip,
  candidates: readonly ResupplyCandidate[],
  opts?: { detourPenaltyM?: number; maxCarryDays?: number },
): ResupplyPlan;
```

## 2. Data and honesty rules

| Data | Source | Rule |
| --- | --- | --- |
| Shops / fuel / post | bundled `data/shops.osm.bin` (ODbL) | show the licence; mark `opening_hours` as unverified when absent (75.5 % coverage) |
| Huts | live `app:RuteInfoPunkt` (CC BY 4.0 ©Kartverket) | the betjent/selvbetjent/ubetjent **classification is not machine-readable**: treat an unknown hut as **no food**, and say so |
| Unmanned fuel stations | heuristic flag in the binary | label as "check the station", never assert |
| kcal | `src/plan/energy.ts` | present a **range**; never a single number |
| intake ceiling | 2.5 × BMR | when TDEE exceeds it, say the deficit is unavoidable |
| food mass | 4.4 kcal/g default | show the assumption and let it be changed |

**Never**: assume a shop is open, assume a hut sells food, or present the TDEE
point estimate without its range.

## 3. UI

- A **Resupply** panel/tab listing the route's resupply points in order, with
  along-route km, detour, gap-to-next, and an inline warning on long gaps.
- Map layer with kind-specific icons and a hover card; clicking centres the
  profile cursor on that distance.
- An **Energy** panel with the TDEE range as a band, the ceiling as a line, and
  the projected mass change as a curve — numbers disabled when elevation or
  profile data is missing.
- Support-model switch (`carry-all` / `mail-drops`) with the parcel-window
  scheduler when mail drops are chosen.
- All strings NO + EN; all states keyboard reachable; all numbers with a
  provenance badge.

## 4. Acceptance tests (add to `test/acceptance/`)

1. **corridor**: a synthetic route past a known shop yields that shop with a
   plausible along-route distance and detour; a shop 50 km away does not appear.
2. **gap**: a 110 km stretch with no shop produces a warning naming the required
   food mass, and the mass matches `days × kcal/day ÷ 4.4 kcal/g` within 5 %.
3. **energy honesty**: when TDEE > 2.5 × BMR the plan reports
   `sustainable: false` and an unavoidable deficit; the panel shows the range,
   not a point estimate.
4. **hut caution**: a hut with no confirmed food produces "assume no food" rather
   than a resupply point that counts toward the plan.
5. **binary loader**: `loadShopIndex` parses the committed
   `data/shops.osm.bin` offline and returns 8,571 points.

## 5. Ownership for the next wave

| Agent | Owns | Must not touch |
| --- | --- | --- |
| resupply-engine | `src/resupply/**`, `test/resupply/**` | everything else |
| resupply-ui | `src/ui/**`, `src/app/**`, `src/map/**`, `index.html`, `src/styles.css` | the engine, `src/plan`, `src/store` |

The contracts above are fixed before either starts, so they meet without
negotiation.

## 6. Deferred deliberately

- **Weather beyond 10 days**: climate normals are a different dataset and a
  different promise. Not in this wave.
- **Offline/PWA**: still out of scope; the app is planning-first.
- **Routing along trails between arbitrary points**: snapping only, as designed.
