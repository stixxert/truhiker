# Phase 4 — resupply and energy in the UI: what was built, and what it refuses to say

*Companion to `docs/13-phase4-resupply-ui.md`. This file records what landed, the
places where the plan left a choice, and the limitations a reader should not have
to infer.*

---

## 1. The user question, answered

> "Where do I resupply on this route, what do I carry between those points, and
> will I be able to eat enough?"

One panel (`Forsyning` / `Resupply` in the top bar) with two tabs:

| Tab | Answers |
| --- | --- |
| **Forsyning** | every shop, fuel station, post point and hut in the corridor, in route order, with along-route km, detour, gap to the next usable point, an inline carry warning, per-leg kg/kcal/NOK, and the caveats |
| **Energi** | TDEE as a **band**, the intake ceiling as a line, the projected mass change as a curve, the unavoidable-deficit verdict, and the two editable assumptions |

## 2. What was built

| File | Owns |
| --- | --- |
| `src/ui/resupply-view.ts` | the panel as data: rows, legs, warnings, every failure state. All honesty rules live here |
| `src/ui/supply-panel.ts` | the DOM: tabs, point list with kind filters, legs, caveats, the range band and mass curve (SVG), the assumptions, the map card |
| `src/ui/energy-view.ts` | `computeEnergyModel()` over `src/plan/energy.ts`, and the view model (range, ceiling, mass change, assumptions) |
| `src/app/supply-service.ts` | lazy `loadShopIndex(fetch)` + `fetchHutsAlong(route)` → candidates, with the two failure modes kept apart |
| `src/map/map-controller.ts` | `resupply` GeoJSON source, colour-by-kind markers, hollow markers for non-food, hover/select card, `focusOn()` |
| `src/ui/trip-settings.ts` | D3's parcel windows shown whenever mail drops are chosen |
| `index.html`, `src/styles.css` | panel markup, the OSM/ODbL entry in "Om data", responsive rules |

The correlation and the plan are the engine's, not a copy:

```ts
const index = await loadShopIndex(fetch);                 // /data/shops.osm.bin, once
const shops = index.alongRoute(route.points, radiusM);    // default 5,000 m
const huts  = await fetchHutsAlong(route, { radiusM: 5_000 });
const plan  = planResupplyForTrip(trip, [...shops, ...huts]);
```

`planResupplyForTrip()` supplies every gap, every `foodKg`, every `carryDanger`
and the whole kcal model. The UI adds words, never arithmetic: the carry warning
is printed only where the plan says `carryDanger`, and the kg in it is
`leg.foodKg`.

## 3. The honesty rules, as behaviour

| Rule | Where it is enforced |
| --- | --- |
| a hut is **"ikke bekreftet"** and closes no gap | `resupply-view.ts` `badgesFor()`; membership in `plan.resupplyPoints` decides `countsAsFood` |
| an unmanned fuel station is not food | engine (`usable()`), surfaced as an `ubemannet` badge and a caveat |
| no point is ever "open" | the binary stores only *whether* OSM had `opening_hours`, so the badges are `åpningstid ukjent` / `åpningstid ikke lest` — never "åpen" |
| TDEE is a range | `energy-view.ts`: the band is the headline number; the midpoint is labelled `modellens midtpunkt` |
| the unavoidable deficit is the headline | `energy.unsustainableTitle` sits above the numbers, in red, with TDEE, ceiling and the kcal/day you cannot eat |
| elevation missing → numbers disabled, with the reason | `EnergyPanelState` → `elevation-missing`; the panel shows no band, no curve, no zeros |
| every failure visible | `no-trip`, `no-route`, `no-profile`, `loading`, `index-failed`, `plan-failed`, plus `hutsError` as a *partial* result |

## 4. Choices the plan left open (and why)

1. **Hut radius is capped at 5 km, independently of the shop corridor.** The
   shop corridor is a user control (5 / 10 / 25 / 30 km) because a 9 km demo
   route has nothing inside 5 km — but at 30 km Turrutebasen returns 35 huts for
   that same 9 km route, which buries the three shops. `docs/13` §1 says
   `fetchHutsAlong(route)` — i.e. its own default — so the hut query keeps
   `DEFAULT_HUT_RADIUS_M`; the hint states it.
2. **Kind filters (`Alle / Mat / Hytter`), default "Alle".** A long route passes
   dozens of huts; nothing is hidden by default, but the shops are reachable in
   one click. The counts are shown on the chips.
3. **No glyph server, so no icons.** The style deliberately has no `glyphs`
   (no third-party fonts, no external style). Kind is carried by marker colour
   plus the hover/select card, which has the words.
4. **A selected point keeps its card open.** Hover and selection are the same
   question ("what is this?"), so `setResupplySelection()` shows the same card
   the pointer does.
5. **The mass curve is hidden below 0.1 kg.** At that size the projection is
   inside the model's own noise; the panel says "ingen vektendring" instead of
   drawing a line that looks like a measurement.
6. **The plan engine's own sentences are shown verbatim, in English**, inside a
   collapsed `<details>` ("Maskinelle merknader"). They are the audit trail for
   the translated caveats, and translating them twice would risk the two
   drifting apart.
7. **`vite.config.ts` now runs `scripts/copy-licences.mjs` at the end of the
   build.** `vite build` empties `dist/`, so `node scripts/licence-audit.mjs`
   failed on a clean build even though every notice was committed. `package.json`
   and `scripts/` were out of scope for this wave, so the copy is invoked from
   the one file that owns the bundle. If `npm run build` later calls the script
   itself, delete the plugin.

## 5. Testing

- `test/acceptance/resupply-corridor.test.ts` — the four acceptance items:
  corridor in / 50 km away out, a 110 km gap whose warning names the mass within
  5 % of `days × kcal/day ÷ 4.4`, a hut that does not close the gap, and
  `sustainable: false` with a range when TDEE > 2.5 × BMR.
- `test/ui-resupply-view.test.ts` — the mandated labels, "never open", the
  carry warning in both languages, and every failure state having a message.
- `test/ui-energy-view.test.ts` — range + labelled midpoint, unavoidable
  deficit, disabled states, and the assumptions actually changing the output.
- `test/app-supply-service.test.ts` — index loaded once, hut failure partial,
  index failure retryable.

**249 of the 250-case budget.** Six cases were merged away inside files this wave
owns (`ui-weather-view` 13 → 7, `ui-library-labels` 11 → 10, `ui-settings-view`
7 → 6): the same assertions, grouped, no behaviour dropped.

## 6. Known limits

- **The bundled extract has no `opening_hours` text.** 75.5 % of Norwegian
  groceries have the tag in OSM; the binary keeps only a presence bit. So the
  panel can say "OSM had hours, we cannot read them", and nothing more. A user
  must still check before relying on a shop.
- **Turrutebasen hut names include placeholders** (`Rett i kartet`, empty →
  `(unnamed hut)`). Those are route-info points, often trail junctions rather
  than buildings. They are shown because the source says they are there, they
  never count as food, and the caveat names them.
- **The demo route is 9.2 km.** Its energy panel is therefore half a day: the
  band and the ceiling are meaningful, the mass change is not (< 0.1 kg). The
  multi-day behaviour is shown with a 130 km synthetic route in the screenshots.
- **Detours are reported, not added.** A 25 km detour to Coop Prix Bøverdalen is
  a warning, not extra distance in the plan — re-deriving the route is routing,
  which this app does not do.

## 7. Screenshots (Playwright, `npx vite preview --port 5199`)

| File | Shows |
| --- | --- |
| `/tmp/npl-phase4/1440-resupply.png` | demo route, 4 points (3 shops + 1 hut), kind filters, detours, gaps |
| `/tmp/npl-phase4/1440-resupply-selected.png` | a shop selected: map card + profile cursor moved to 8.46 km |
| `/tmp/npl-phase4/1440-energy.png` | the TDEE band, the ceiling line, "du kan spise nok" |
| `/tmp/npl-phase4/390-resupply.png` | the same at 390 px, bottom sheet |
| `/tmp/npl-phase4/390-resupply-selected.png` | a point selected at 390 px: the ringed marker is lifted above the sheet (no card — it would be covered) |
| `/tmp/npl-phase4/390-energy.png` | the band and the assumptions at 390 px |
| `/tmp/npl-phase4/1440-long-energy.png` | 130 km synthetic route, 30 km/day: **unavoidable deficit** and the mass curve |
| `/tmp/npl-phase4/1440-long-settings.png` | mail drops chosen: D3's parcel windows |
| `/tmp/npl-phase4/1440-long-resupply.png` | the same route with the "Mat" filter: 42 food points out of 99 |
| `/tmp/npl-phase4/1440-energy-en.png` | the panel in English |
| `/tmp/npl-phase4/390-resupply-en.png` | English at 390 px (`?lang=en`), no overflow |
| `/tmp/npl-phase4/long-route.gpx` | the synthetic route used for the multi-day shots |
