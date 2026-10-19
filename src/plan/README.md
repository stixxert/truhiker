# `src/plan` — energy, food and resupply

Pure functions. No DOM, no network, no dependencies. The planner turns a route
and a body into the two numbers that actually decide a long walk: **how much
you burn** and **whether you can carry (or buy) enough to eat**.

The research behind it is `docs/01-options-and-decisions.md` §D8 (calorie model)
and `docs/06-bundle-manifest.md` (why shops are bundled and huts are not).

```
src/plan/
  energy.ts      TDEE component sum, BMR, Minetti, ceiling, deficit, cross-checks
  nutrition.ts   food catalogue, kcal/NOK, mixed-load density, buy list
  resupply.ts    points, opening hours, legs, gaps, mail-drop scheduler
```

---

## 1. The energy model

**Never a single activity multiplier.** A multiplier spends resting metabolism
twice and puts pack weight in the wrong term. The day is an explicit sum:

```
TDEE = resting(BMR × weighted hours)
     + Σ net locomotion above rest      (Minetti 2002)
     + NEAT
     + thermoregulation
     + TEF (≈10 % of intake)
```

### BMR

| Equation | Formula | When |
| --- | --- | --- |
| **Mifflin–St Jeor** (default) | `10m + 6.25h − 5a + 5` (male) / `−161` (female) | mass, height, age, sex only |
| **Cunningham** | `500 + 22 × LBM` | when body-fat % is supplied |

Choosing between them moves the answer by **8–10 %** for a lean hiker. That is a
model choice, not a measurement — which is why the output is a range. A missing
body-fat percentage never silently selects Cunningham; picking it explicitly
without body fat throws.

### Rest of the day

| State | BMR multiplier | Default hours |
| --- | ---: | --- |
| Sleep | 0.95 | whatever remains |
| Camp-waking (chores, cooking, packing) | 1.5 | 3.5 |
| Walking | 1.0 | Naismith: `km / 3.5 + ascent/600 + descent/1000` |

The resting term is `BMR/24 × Σ(state × hours)`. Walking hours are *also* spent
at 1 × BMR; Minetti adds only the **net** cost above that.

### Locomotion — Minetti 2002, 5th order

```
Cw(i) = 280.5 i⁵ − 58.7 i⁴ − 76.8 i³ + 51.9 i² + 19.6 i + 2.5   [J·kg⁻¹·m⁻¹]
```

- `i` is clamped to **±0.45**. The polynomial has no data outside that and
  diverges quickly.
- It is the **net** cost: `i = 0` gives **2.50 J·kg⁻¹·m⁻¹**, and resting is
  added separately.
- It is the only widely used fit that covers **negative grades**. Pandolf has no
  downhill data and `pandolfKcalPerHour()` throws for `i < 0` on purpose.
- The widely copied 4th-order variant is **not** in the paper; it is not used.
- A day with 1200 m up and 1200 m down over 30 km is split as +8 % / −8 %
  (distance allocated in proportion to vertical work). It is therefore *not*
  priced as level: the U-shape makes the pair average 2.83, not 2.50.
- Pack mass is added to body mass (1 kg pack ≈ 1 kg body), then a terrain factor
  η multiplies the net cost.

### Terrain factor η

| Class | η | Note |
| --- | ---: | --- |
| `asphalt` | 1.00 | the treadmill surface Minetti fitted |
| `gravel` | 1.15 | |
| `trail` | 1.18 | **default**, Norwegian T-marked trail |
| `rough` / scree | 1.50 | |
| `bog` | 1.90 | suction and erratic step length; deliberately severe |

### NEAT, thermoregulation, TEF

- **NEAT** = 8 % of BMR (camp chores, fidgeting, gear).
- **Thermoregulation** = **+150 kcal/day**, a labelled **estimate**. It is a
  placeholder for real weather, not a weather model.
- **TEF** = 10 % of intake. At energy balance intake = TDEE, so the sum is solved
  as `TDEE = base / 0.9`. In a deficit this slightly *over*-estimates TDEE
  (TEF is charged on intake, not burn) — see §6.

### Output and range

```ts
{ tdee, breakdown: { resting, locomotion, neat, thermoregulation, tef },
  range: { p10, p90 }, bmr, bmrEquation, totalMassKg, hours,
  intakeCeilingKcal }
```

The range is **`tdee × 0.75 … tdee × 1.30`** — asymmetric on purpose.
Reputable equations spread **28–37 %** against each other, so ±20 % is an honest
floor and under-prediction is the dangerous direction. Do not present the
midpoint as a number to eat to.

### The ceiling, and the deficit

- **Intake ceiling** = `2.5 × BMR` (Thurber et al. 2019).
- **Fat supply ceiling** = `69 kcal/day per kg of fat mass`.
- `planDeficit()`:
  - `deficit = min(0.12 × TDEE, 0.75 × fatCeiling)`;
  - `sustainable = TDEE ≤ intakeCeiling`;
  - when false, `unavoidableDeficitKcalPerDay = TDEE − ceiling`.

**This is the most important output.** A 75 kg male on a 30 km / 1200 m day burns
≈4,740 kcal while the ceiling is ≈4,325: no menu fixes that. The planner must
say so, and say what it implies for pace and body composition. A 30 km/day plan
for five months is a different person at the end.

### Worked examples (from the tests)

| Body | Pack | Day | TDEE | Range |
| --- | ---: | --- | ---: | --- |
| 75 kg male, 180 cm, 30 | 15 kg | 30 km, ±1200 m | **4,742** | 3,557–6,165 |
| 65 kg female, 168 cm, 30 | 13 kg | 25 km, ±1000 m | **3,641** | 2,731–4,733 |

Both fall inside the documented bands (4,200–5,300 and 3,200–4,000).

### Cross-checks

`crossCheck()` returns Minetti (gross), **Santee/USARIEM** and an **ACSM** VO₂
estimate for the same walking hour:

```
Santee level = (3.28·mTotal + 71.1) × (V / 1.33)
        uphill + 3.5·mTotal·g·h
      downhill + 2.4·mTotal·g·h·0.3^(α/7.65)
   gross clamped to ≥ 25 % of level

ACSM  VO₂ = 0.1·V + 1.8·V·grade + 3.5     [ml·kg⁻¹·min⁻¹]
```

At level the three must agree within **35 %**, or `crossCheck()` **throws** — a
wider spread is almost always a units bug (speed in km/h read as m/s). Off level
the equations legitimately diverge (ACSM's linear downhill term is clamped;
Minetti prices braking), so the spread is reported without throwing.

---

## 2. Food

`nutrition.ts` carries the researched catalogue: kcal/100 g and indicative
NOK/100 g, from which kcal/NOK is derived. The headline ratio is the planning
insight:

| | kcal/NOK | A 4,000 kcal day |
| --- | ---: | ---: |
| Staples (oats, rice, oil) | 25–185 | ~110 NOK |
| REAL Turmat (450–516 kcal/100 g) | 4.0–4.4 | ~900–1,100 NOK |

The **default mix** is "staples + one freeze-dried dinner" (shares by calories).
It resolves to **≈4.38 kcal/g** — the ~4.4 kcal/g planning figure — so:

- 4,000 kcal ≈ **0.91 kg**;
- a **7-day leg ≈ 6.4 kg**;
- a 7-day leg costs ≈ **750 NOK** at indicative prices.

`foodWeightFor(kcal, mix)` returns **kilograms**; `foodGramsFor`, `costFor` and
`buyList` (grams and NOK per item) are the actionable variants. `FREEZE_DRIED_MIX`
exists to price the expensive alternative. Prices are stale by definition —
treat them as an order of magnitude.

---

## 3. Resupply

`planResupply(route, points, opts)` models a **general route**, not a curated
itinerary. Points are located by `routeDistanceM` or projected onto the polyline.

### Point model

```ts
ResupplyPoint { id, kind: supermarket|convenience|fuel|post|hut|cache,
                position, hours?, confidence: osm|chain-verified|curated,
                lastVerified?, hasShop?, sellsFood?, hutKind?, postKind?,
                routeDistanceM? }
```

### Conservative defaults — never assume availability

| Situation | Result |
| --- | --- |
| Hut with no `sellsFood` | **no food**, warning |
| `ubetjent` hut, even with `sellsFood: true` | **no food**, no gas either |
| `fuel` without `hasShop` | **automat, not a shop**, warning |
| `post` | never a food source; mail-drop destination only |
| `osm` confidence with no hours | **"verify"** warning |
| No `lastVerified` | "never verified" info |
| Verification older than 540 days | "stale, re-verify" warning |
| Unparseable hours | `openAt()` → **`unknown`**, never "open" |
| `selvbetjent` larder | warning: stock is **not guaranteed**, carry a reserve |

### Both support models

**`carry-all`** — legs between usable food points. The worst continuous stretch
is returned as `gap`:

```ts
gap { maxDays, distanceM, foodKg, costNok, fromId, toId,
      maxCarryDays, exceedsMaxCarry }
```

Any leg longer than `maxCarryDays` (default **7**) gets a **critical** warning
that includes the required food mass. With no usable point at all, the whole
route is the gap.

**`mail-drops`** — for each parcel point:

```
arrival   = legStart + N days
shipBy    = arrival − 5
notBefore = arrival − 7    (parcel)
          = arrival − 21   (poste restante)
```

A parcel whose `shipBy` precedes the trip start is flagged **critical**: it
cannot have been posted in time. A missing start date is flagged separately.

### Opening hours and Sunday

`openAt(point, date)` returns `unknown | open | closed`.

- `Mo-Sa 09:00-17:00` is **closed on Sunday** (the statutory case).
- `Tu-Su 09:00-17:00` **includes Sunday** — OSM defines `Su` as Sunday. (The
  task brief's wording suggested Tu-Su was Sunday-closed; standard OSM semantics
  are implemented and tested, because silently treating Sunday as Saturday would
  make every Sunday check wrong.)
- Overnight intervals (`Fr 22:00-02:00`) are read correctly across midnight.
- A Date at exactly midnight is a **date-only** query ("open at all that day").
- Public/school holidays (`PH`, `SH`) and unsupported syntax → `unknown`.
- A leg whose only option is closed on the estimated arrival date gets
  `sunday-closed-only-option` (**critical**); if another usable point is within
  15 km it is softened to `closed-check-alternatives`.

### Output

```ts
{ support, stops, legs, gap, mailDrops, totals, warnings }
```

Every warning is `{ code, severity, message, pointId?, legId? }`; the codes are
stable for i18n. Messages are English defaults, never the only representation.

---

## 4. Constants

| Constant | Value | Source / role |
| --- | ---: | --- |
| Minetti coefficients | 280.5, −58.7, −76.8, 51.9, 19.6, 2.5 | Minetti 2002, 5th order |
| Minetti grade limit | ±0.45 | fitted range |
| Terrain η | 1.0 / 1.15 / **1.18** / 1.5 / 1.9 | asphalt / gravel / trail / rough / bog |
| Floor speed | 3.5 km/h | Naismith |
| Climb penalty | 1 h / 600 m | Naismith |
| Descent penalty | 1 h / 1000 m | braking cost |
| Sleep / camp / walking BMR | 0.95 / 1.5 / 1.0 | component sum |
| Camp hours | 3.5 h/day | default |
| NEAT | 0.08 × BMR | estimate |
| Thermoregulation | +150 kcal/day | **estimate** |
| TEF | 10 % of intake | solved at balance |
| Intake ceiling | 2.5 × BMR | Thurber 2019 |
| Fat ceiling | 69 kcal/day/kg | fat oxidation |
| Sustainable deficit | 12 % of TDEE | planning cap |
| Fat-deficit use | 75 % of ceiling | safety margin |
| Range | 0.75 × … 1.30 × TDEE | 28–37 % model spread |
| Mixed dry load | ≈4.4 kcal/g | default mix computes 4.38 |
| Max carry | 7 days | default |
| Mail transit | 5 days (`shipBy`) | **assumption** |
| Pickup window | 7 days / 21 days | parcel / poste restante |
| Cross-check tolerance | 35 % | units-bug guard |

---

## 5. Tests

`npm test` (or `npx vitest run test/plan`). The model tests assert numbers, not
shapes:

- Minetti at `i=0` is **2.50**; at −0.10 **1.127**, +0.10 **4.899**,
  +0.45 **17.600** J·kg⁻¹·m⁻¹.
- Galdhøpiggen-style male day **4,742** (band 4,200–5,300); female reference
  **3,641** (band 3,200–4,000).
- A 30 km / 1200 m day exceeds 2.5 × BMR ⇒ `sustainable: false` with
  `unavoidableDeficitKcalPerDay = TDEE − ceiling`.
- Cross-check spread **16.8 %** at level; a deliberately broken input throws.
- Mirrored negative grade: Minetti fine, Pandolf throws.
- 0 km route ⇒ 0 kcal, 0 kg, 0 NOK, no legs.
- 7-day gap ⇒ **6.39 kg** at the default mix (band 6.2–6.6).
- A mail drop whose `shipBy` precedes the start is flagged critical.
- `Mo-Sa` closed Sunday; absent hours `unknown`; unsupported hours `unknown`.

81 plan tests in three files.

---

## 6. Where this will be wrong

This model is a planning aid. These are the honest failure modes, roughly in
order of how much they can mislead.

1. **Minetti is a treadmill fit.** Sea level, temperate, no pack, no poles, no
   scrambling, no snow, no mud. The terrain factor η is where all of that reality
   is hidden. It is a single number standing in for surface, stepping, route
   finding and vegetation — and it is not calibrated against Norwegian field
   data. On bog or boulder fields the error can be large in either direction.
2. **The grade split is an approximation.** Ascent and descent are distributed
   over the day in proportion to vertical work. A day of rolling 50 m climbs and
   one 1200 m climb have the same totals but different U-shape costs. Beyond
   ±45 % Minetti is clamped, so very steep off-trail days are underestimated.
3. **BMR equations are ±8–10 % against each other**, and worse for very lean,
   very heavy, very old or very young bodies. Cunningham with a guessed body-fat
   percentage is not better than Mifflin — it is just differently wrong. Fat mass
   defaults (18 % male / 28 % female) are population placeholders, flagged in
   the output.
4. **TEF is solved at energy balance.** When you are in deficit, TEF is charged
   on *intake*, so TDEE is over-estimated by roughly `0.1 × deficit` (tens of
   kcal/day). Small, but it is a real bias.
5. **NEAT and thermoregulation are constants.** Cold rain, wind, altitude,
   shivering, a heavy pack's postural cost and long evenings in a tent are not
   modelled. Altitude above ~2,000 m raises BMR; Norwegian routes rarely sit
   there for weeks, but Jotunheimen days do. Thermoregulation is labelled an
   estimate for exactly this reason.
6. **The ceiling is a population number.** 2.5 × BMR is a mean; gut adaptation
   varies, some people sustain more for weeks and some less. It is also an
   *intake* limit, not an appetite limit — many hikers cannot physically eat
   even that much after week three. Fatigue, nausea and food aversion are the
   real constraint and are not modelled.
7. **The fat ceiling assumes fat adaptation.** 69 kcal/kg/day is not available
   on day three of a trek; early deficits come with glycogen and water, and the
   first week's weight loss is mostly not fat. The 75 % safety factor helps but
   does not fix the physiology.
8. **The 4.4 kcal/g density is optimistic for the bag.** It ignores packaging,
   the water in wet food, gas canisters, repackaging losses and the food you
   waste. A real pack is often 10–15 % heavier per usable calorie. The catalogue
   kcal values are label values with their own ±10–20 % variance.
9. **Prices are stale the day they are written.** `nokPer100g` is indicative
   2026 shelf data, not a feed. kcal/NOK is the stable part; NOK is not.
10. **Resupply data is the weakest layer.** OSM shops are incomplete and can be
    years out of date; rural Norwegian shops close and reopen between seasons.
    Hut status and stock are manually curated and **stock is never guaranteed**,
    even at a `selvbetjent` larder. The engine's answer to uncertainty is
    "assume no food", which is safe but can understate real options.
11. **Opening hours are a parsed subset.** Public holidays, seasonal hours,
    "by appointment", Easter/Christmas exceptions, size-based Sunday exemptions
    for ≤100 m² shops and ≤150 m² stations, and staffed-versus-automat fuel
    stations are not resolved. Unsupported syntax becomes `unknown`, and a
    `verify` warning — not a guess. A shop verified in May may be closed in
    September.
12. **Mail drops assume a five-day transit and a fixed pickup window.** Real
    postage is faster or slower, a parcel can be returned before you arrive, and
    poste restante is not available everywhere. The scheduler flags a window that
    cannot fit the trip, but it cannot know the actual transit time. A parcel
    arriving early is a silent failure the model cannot detect.
13. **Resupply days use a flat daily distance.** `days = km / dailyDistanceKm`
    with no per-leg elevation. A 25 km leg with 1,500 m of climb takes longer
    than a flat 25 km leg; the kcal-per-day and food mass are therefore
    understated on the hard legs and overstated on the easy ones. Feed the
    planner a realistic `dailyDistanceKm`, or split hard legs manually.
14. **Off-route points are warned about, not costed.** A shop 2 km off the route
    adds 4 km of walking that never appears in the leg distance or the calories.
15. **Dates are calendar dates.** `openAt` uses the host's local day-of-week;
    there is no timezone-aware itinerary, no rest days, no weather days and no
    time-of-day schedule. A Date at exactly midnight means "date only", which is
    a deliberate convention rather than a claim about midnight opening.
16. **Not modelled at all:** water sources and treatment, stove fuel/gas, dog
    food, river fords, snow, ferries/buses, packraft, altitude illness, injury,
    and the fact that appetite and morale are as important as kcal. This is a
    planning aid, not a navigation device and not medical advice.
