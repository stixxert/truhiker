# TruHiker — the pitch

## The problem

Planning a long walk in Norway is done in spreadsheets, screenshots and forum
posts. The hard questions are not "how far" but:

- Where are the shops, and how far apart are they really?
- How much food does that gap require, in kilograms?
- Can I physically eat enough on a 30 km day with a 15 kg pack?
- What will the weather be when I get there — and what don't I know?

Existing tools answer some of these, or answer them confidently and wrongly.

## The insight

**A planning tool's most valuable output is often "unknown".**

Weather beyond ten days does not exist. A Norwegian mountain hut's food status is
not published as data. A global 30 m DEM is not good enough for a 1,200 m climb.
The temptation is to fill those gaps with plausible numbers. The product decision
here is the opposite: state the limit, show the range, and leave the cell empty.

That turns an ordinary planner into something a hiker can actually trust with a
five-month walk.

## The product

A browser-only planner for multi-day hiking in Norway:

1. **Route** — import or draw a GPX, edit it with snapping and full undo/redo.
2. **Terrain** — elevation from Kartverket's national 1 m LiDAR model, so ascent
   and time are real.
3. **Resupply** — shops, fuel, post and huts along the route, with the gap to the
   next usable point and the food mass that gap demands.
4. **Energy** — a component model that returns a **range**, the intake ceiling,
   and the projected weight change; it says plainly when the deficit is
   structurally unavoidable.
5. **Weather** — MET Norway day by day along the route, with an explicit horizon.

<img src="screenshots/02-resupply.jpg" width="49%"> <img src="screenshots/03-energy.jpg" width="49%">

## Who it is for

- **The long-distance walker** planning *Norge på langs* or a section of it, who
  needs to know where the food comes from.
- **The trip organiser** who wants to hand someone a route with the gaps already
  identified.
- **The sceptical hiker** who would rather see "unknown" than a confident guess.

## Why it is credible

Not assertions — measurements, recorded in [`notes/`](notes/):

| Claim | Evidence |
| --- | --- |
| Elevation is accurate | Galdhøpiggen reads **2467.8 m** against a true **2469 m** |
| A full-length route is storable | 3,000 km / 100,000 points / **8.0 MB** saved and reloaded identically |
| The weather rule holds | a day +60 d has **zero numeric fields**; verified in the engine and in the DOM |
| We do not hammer public services | a 78-day trip made **6 requests**, not 39, once the horizon is known |
| The trail data is real | a bundled route from Kartverket Turrutebasen, 1,164 points, attributed |
| Licences are respected | an audit maps all **19 shipped files** to a licence and fails the build otherwise |
| It is tested | **246 hermetic cases**, five acceptance journeys, two rendered breakpoints |

## What it demonstrates

- Data engineering: raster DEM sampling, binary formats, GML/WFS, honest geometry.
- Product judgement: deciding what **not** to show, and enforcing it in tests.
- Front-end craft: MapLibre terrain, synchronised profile, accessible dialogs,
  responsive layout, no framework bloat (the app is ~60 KB brotli; MapLibre is the rest).
- Operating under constraints: static-only hosting, a 250-case test budget, a
  licence obligation per asset, and public services that must not be abused.

## Risks and how they are handled

| Risk | Handling |
| --- | --- |
| Live source outage | every source has a visible degraded state; derived numbers disable rather than zero |
| Licence drift | the build fails if a shipped file has no licence entry or a notice is missing |
| Silent wrong numbers | invariants are pinned by tests that assert key-level absence, not just values |
| Public-service limits | request budgets, caching, tiling, and no per-pan fetching |

## What is next

1. Routing along the trail network between arbitrary points (replacing snapping
   where a real path exists).
2. Mail-drop scheduling end to end, with parcel windows in the UI.
3. An offline mode for the trail itself — the one thing this planner deliberately
   does not yet do.
4. Climate normals beyond the forecast horizon, clearly labelled as normals.
