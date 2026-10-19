# NPL-Map — options, decisions and what you need to consider

*Status: feasibility complete. Nothing built yet. This document exists so the
expensive decisions are made once, deliberately.*

---

## 1. The finding that changes the shape of the project

**There is no official "Norge på langs" route, and no authority that defines one.**

That is not a technicality — it changes what the app must be. NPL is a *concept*
with agreed endpoints, a heavily-trafficked corridor, and roughly six recognised
variants. The de-facto reference track is a UT.no "turforslag" (a user
submission), not a DNT-designated trail. The completion register is one man's
website. The most rigorous modern line is self-published by a Czech runner.

Consequences:

1. The app must model **a set of candidate polylines with provenance**, not "the
   route". Presenting one line as official is the first way this project becomes
   dangerous.
2. **Every fact needs a provenance label** — official (Kartverket/DNT) /
   platform (UT.no) / self-published (FKT, Pavlíček) / blog claim. The NPL
   literature is unusually blog-heavy, and several attractive "facts"
   ("season: all year", "2 600 km", "official route") are self-publishing
   artefacts.
3. Related traps worth encoding as guards: `npl.no` is the police officers'
   union, not NPL. `norgepalangs.no` (one "e") is a personal blog, not an
   association. "Nordkapp" is not the northernmost point.

**This is the single most important thing to design around.** A route planner
that implies authority it does not have is a safety hazard, not a convenience.

---

## 2. What I verified myself (not read — measured)

| Claim | Result |
| --- | --- |
| Kartverket national DEM accessible & open | ✅ National 1 m DTM, **1.59 TB across 2033 tiles**, CC BY 4.0 |
| Can we sample it without downloading 1.6 TB? | ✅ **Yes.** Tiles are tiled GeoTIFFs **with internal overviews to ~64 m/px**. Remote 16×16 window read in **~370 ms** over HTTP range requests. This retires the main technical risk. |
| Kartverket raster tile service usable | ❌ Every tile at z≥4 returns the **same 854-byte blank PNG** (verified by md5, with and without an `apikey`). The public cache is gated. Cannot be a basemap source. |
| Open official trail database exists | ✅ **Turrutebasen** WFS: **137,196 foot routes**, 9,744 info points, 11,871 cycle routes. Open, bbox-queryable, no key. |
| Toolchain available | ⚠️ No GDAL, no numpy/PIL, **no pnpm**. Pure-JS works: `geotiff` + `proj4` (proven). |

Full details and commands: `docs/00-feasibility-spike.md`.

---

## 3. Decisions

### D1 — Which route line is the product?

| Option | What it is | Verdict |
| --- | --- | --- |
| **A. UT.no turforslag 1149 "Nordryggen/Geotrail"** | 2,712.5 km, 44,579 m, the most-cited line, hosted by DNT's platform | Best-known, but it is a submission, and UT.no content is **not openly licensed**. Its "season: all year" is a data-entry artefact. |
| **B. FKT "NPL Nordryggen" GPX (rev. 2026, 14.2 MB)** | Same corridor, revised "as the new golden standard", fixing Geotrail's known bad choices | Best track quality. No explicit open licence — **treat as proprietary, cite it, ask permission before republishing.** |
| **C. "Kun i Norge" (Pavlíček, 2025)** | 2,963 km, +101,443 m, <1 km asphalt, no Sweden/Finland | Ideologically pure; 200–250 km of pathless granite slab and a packraft crossing. A *style*, not a default. |
| **D. Road/FKT line** | 2,550–2,600 km, mostly E6, 47 days | Reference for the lower bound only. Not the product. |
| **E. Build our own from open data** | Turrutebasen (137k foot routes) + OSM + DEM | Legally cleanest, operationally most accurate, **but it cannot produce a national trunk line** — NPL has long unmarked sections that no open dataset contains. |

**Recommendation:** **B as the trunk, licensed properly, with A as a cross-check
and C/E as composable alternatives.** Ask FKT/Pavlíček for explicit permission to
bundle publicly (they will almost certainly say yes with attribution). If not
granted, keep the trunk personal-use-only and publish the app with a "bring your
own GPX" import — which we need anyway.

Do **not** present any of these as "the NPL".

### D2 — Direction

**Recommendation: south → north.** The evidence is lopsided:

- You walk *with* the spring rather than chasing the snowline.
- You finish before the Arctic autumn closes (first snow on Finnmarksvidda ~late
  Sept; the most-cited end-game risk).
- Daylight is front-loaded — midnight sun in the north in June/July, and you only
  lose light in the last weeks when you are nearly done.
- You build fitness on the flat, boring, tarmac south before the hard north, and
  can stage heavier winter kit northward with family/friends.
- Every guidebook, register entry and stage table is written S→N.

N→S is defensible (Kim Norberg did it 17 Jun → 5 Oct, 2,742.6 km, 111 days),
and the app should **model direction as a strategy object**, not a toggle — it
changes gear staging, daylight exposure, snow-chase direction and start date.

Start window: **mid-May to mid-June**, target Nordkapp **by late September**.
Caveat: early-season walkers are stopped by snow in **Setesdalheiane /
Hardangervidda / Jotunheimen**, not in Finnmark — the north's interior plateau is
continental and dry (<400 mm/yr, snow <50 cm) and clears earlier than the wet
coastal mountains.

### D3 — Which "north end"?

Four answers are in active use and they are not interchangeable:

| Endpoint | Claim | Extra cost |
| --- | --- | --- |
| **Nordkapp** | What ~everyone registers | — (but on Magerøya, not the mainland; reached by the E69 tunnel where **pedestrians are banned**) |
| **Knivskjelodden** | 1,450 m further north than Nordkapp | +~18 km round trip on foot |
| **Kinnarodden** | Northernmost point of mainland Europe | ~70 km east, different final section |
| Lindesnes | Universal start (southernmost mainland point) | — |

**Recommendation:** model as a first-class 4-way choice with the *reason* shown.
Default Lindesnes → Nordkapp with Knivskjelodden ticked.

### D4 — Basemap: the licensing constraint nobody expects

Kartverket's terms say levels **12–20** of the WMS/cache contain Geovekst (FKB)
data they do not solely own, and **copying those tiles into an offline archive
requires special permission from the rights holders**. Meanwhile the live cache
returns blank tiles anyway.

So scraping topo tiles is both the most likely licence violation *and*
technically broken. Two clean paths:

| Option | Work | Result | Licence |
| --- | --- | --- | --- |
| **A. N50 Raster GeoTIFF** (open, 20×20 km tiles) as a pre-rendered basemap | Low | Classic topo look, zero styling control, not interactive | CC BY 4.0 ✅ |
| **B. Build own vector tiles from N50/N100/N250 Kartdata + DTM** → tippecanoe → PMTiles | Medium | Full interactivity (click a lake, toggle contours, dynamic styling), one consistent pyramid | CC BY 4.0 ✅ |
| C. Live WMTS z≤11 only | Low | Looks broken above overview zoom | Boundary unclear |

**Recommendation: B.** Your brief says "highly interactive"; vector tiles are what
makes that real. It is also the only path that lets us draw contours from the
*same* DEM we compute the profile from, so the map and the numbers cannot
disagree. Keep A as a fallback layer.

**Not allowed / not viable:** FKB (private actors must purchase), Matrikkel, the
`landtopo` pilot MVT (FKB/Matrikkel-derived at high zoom, and `/test/` status),
`felles.naturbase.no` API (requires prior agreement).

### D5 — Terrain and 3D

| Option | Notes |
| --- | --- |
| **A. Kartverket DTM → our own terrarium PMTiles** | Source of truth, CC BY 4.0, z9–13 corridor ≈ 0.5–0.9 GB (z14 ≈ 1.8–3.6 GB) |
| B. Mapterhorn live tiles (Norway at 1 m) | Zero ops, zero storage, what MapLibre's own 3D example uses. Third-party dependency; attribution.json required |
| C. Mapzen/AWS terrarium | ❌ For Norway the underlying source is SRTM/GMTED ~30 m — visibly wrong in steep terrain |

**Recommendation: A for the shipped app, B for the prototype.** One source of
truth matters: if terrain and profile come from different DEMs, the 3D view and
the calorie maths will silently disagree. Use **DTM (bare earth), never DOM** —
DOM includes canopy and would inflate forest sections 15–25 m and wreck ascent
totals.

3D specifics we can rely on: `raster-dem` (terrarium), `setTerrain`, `setSky`,
`hillshade`, `color-relief`, and **lines are draped onto terrain automatically**
(symbols are not). Known performance cliff: MapLibre's terrain is weak on long,
narrow, high-pitch scenes — cap pitch ~60°, set an explicit `maxzoom`, simplify
the route to ~5–10k vertices.

The "slightly detailed 3D model" can also be exported as a printable STL of the
corridor from the same DEM. Cheap add-on, genuinely nice for planning on a table.

### D6 — Hosting on free tiers

**The trap:** Cloudflare Pages returns **HTTP 200 for Range requests, not 206**,
so **PMTiles on Pages fails** — and fails badly: the browser downloads the whole
archive, then the client throws "check that your storage backend supports HTTP
Byte Serving". Looks like loading, is not.

| Host | Free limit | PMTiles? | Verdict |
| --- | --- | --- | --- |
| **Cloudflare R2 + custom domain** | 10 GB, 1M writes, **10M reads/mo, zero egress** | ✅ native | **The answer for tiles.** `r2.dev` is documented non-production — use a custom domain |
| **Cloudflare Pages** | 20,000 files, 25 MiB/file, unmetered requests | ❌ Range=200 | **The answer for the app** |
| GitHub Pages | 1 GB site, 100 GB/mo | ✅ | Viable *only* if you cap at ~700 MB of tiles |
| Netlify free | 300 credits ≈ 15 GB **and 20 deploys/mo** | ✅ | Site paused on exhaustion — unusable |
| Vercel Hobby | 100 GB, 1M req | ✅ | ToS: **non-commercial personal use only** |
| Deno Deploy | 20 GiB egress/mo | ⚠️ | 3 GB of tiles evaporates |

**Recommendation: app + data on Pages, terrain PMTiles on R2 behind a custom
domain.** Budget: ~400–450 KB gzip JS (MapLibre alone is 274 KB). Skip deck.gl
(≈+147 KB gzip and it roughly doubles payload for overlays MapLibre already
does); skip whole-package Turf (30 lines of haversine beats it).

Free ceiling to be honest about: **~6.5M tile-views/month** before Class B
overage. Fine for a personal project; gone in a week if it goes viral.

### D7 — Resupply data

**There is no authoritative open store register in Norway.** No chain publishes an
API; the state publishes none. What exists:

| Layer | Source | Quality |
| --- | --- | --- |
| Geometry & identity | **OSM** — 4,042 `shop=supermarket` + 577 `convenience`; brand counts already match reality (Kiwi 734, Rema 702, Extra 602, Joker 439) | Good, ODbL |
| Hours | **Chain store pages** (all `Allow: /` in robots) — validate only the ~150–400 shops near the route | Authoritative, must be crawled |
| Completeness audit | **Enhetsregisteret** NACE 47.110 (6,210 units, no coordinates) → geocode via Kartverket Adresse-API → diff against OSM | Finds unregistered village shops |
| Hut food | Manual curation — **no dataset exists** | The key gap |
| Nutrition | Seed table (below) + live prices | Prices volatile |

**Recommendation: OSM as backbone, chain pages as an hours-verification pass over
the ~300 shops that matter, everything else curated by hand with a
"last verified" date on every shop.**

The honesty requirement here is a feature: **never present a single number as
"the shop"**. Present `OSM-only` / `OSM+chain-verified` / `confirmed this season`.

**The DNT food model is the part most planners get wrong**, and it inverts
north-to-south:

- **Betjent** (46 lodges) — *served meals*, and **bringing your own food indoors
  is prohibited**. It is a restaurant, not a shop.
- **Selvbetjent** — an honour-system larder (tinned goods, crispbread, soup,
  coffee, gas). **Stock is not guaranteed** — "if a shelf is empty, it's empty".
  Model *probability*, not a boolean. **Geographically limited to Agder →
  Trøndelag.**
- **Ubetjent** — **nothing at all, including no gas.** Full food and fuel carry.

So the south is soft and the north is hard — and the north is exactly where the
food deserts are. The Børgefjell box (100×100 km) contains **six shops and zero
in the plateau core**.

### D8 — Calorie model: how to be rigorous without lying

**Do not use a single equation with an activity multiplier.** Use an explicit
component sum so nothing is double-counted:

```
TDEE = resting(BMR × hours, weighted by activity state)
     + Σ net locomotion above rest      (Minetti 2002, 5th-order polynomial)
     + non-walking NEAT
     + thermoregulation
     + TEF (≈10% of intake)
```

Why Minetti and not Pandolf: **Pandolf has no negative-grade data at all** — using
it downhill produces nonsense. Minetti covers −45%…+45% and gets the U-shape
right (−10% is the *cheapest* gradient at 0.27 kcal/kg/km; steeper descents get
expensive again as braking costs). Cross-check against Santee/USARIEM and surface
the disagreement.

Honest uncertainty: reputable models spread **28–37%** against each other and
field trials show Pandolf erring −33% to +17% depending on protocol. So:

- **Present a range, not a number.** Male default ≈ **4,800 kcal/day, presented
  3,600–6,200**.
- **The ceiling matters more than the estimate.** Max sustainable intake is about
  **2.5 × BMR** (~4,475 kcal/day for a 75 kg male). On a 30 km / 1,200 m day, burn
  (≈5,000) *exceeds* that ceiling — **the deficit is structurally unavoidable**.
  That is the single most useful output the planner can give.
- Consequence for planning: a lean male capping at ~22–26 km / 900 m/day can hold
  a 3–5 kg loss over five months. A 30 km/day plan for five months is **not
  physiologically sustainable** — it is a 15 kg loss. **Route difficulty and body
  composition are coupled, and the app must say so.**
- Food weight follows: 4.4 kcal/g realistic → **~0.9 kg/day** at 4,000 kcal →
  **6–9 kg carried** for a 7–8 day leg. A 110 km Hardangervidda leg is a *weight*
  problem as much as a food problem.

For "how many kg to buy at the shop": `kg = kcal_needed / 4400`, priced against
the real shelf (staples 70–125 kcal/NOK; REAL Turmat ≈4.5 kcal/NOK — a
freeze-dried-only 5,000 kcal day costs ~1,100 NOK).

### D9 — Planning tool, or trail tool? (you did not ask; it decides the architecture)

These are different products and conflating them is how on-trail apps fail.

- **Planning** (at home, big screen): 3D terrain, full profile, resupply
  simulation, "what if" start dates. **Needs no offline.**
- **On trail** (phone, Finnmark, no signal): must work **fully offline** — cached
  tiles, cached data, GPS, no network calls. That means a PWA with an explicit
  region download, and probably a printable/PDF + GPX fallback.

**Recommendation: build the planning tool first, and treat offline as a separate,
later deliverable with its own download UX.** Do not assume the planning app
"just works" offline — PMTiles over Range requests is a poor offline story, and a
map that silently blanks 40 km from a shop is exactly the failure you cannot
afford.

---

## 4. Things you need to consider

**Safety / liability**
1. **This must not look like a navigation device.** Kartverket explicitly marks
   its elevation point service "must not be used for navigation". A hiking planner
   carries the same implication. Every screen needs a visible "planning aid, verify
   on the ground" frame, and we should never present a single track as
   authoritative. Decide how strongly you want to state this.
2. **The Nordkapptunnel (E69, 6.9 km subsea) bans pedestrians.** The plan must
   route you onto a bus/taxi — or model the packraft alternative.
3. **Namsvatnet requires a boat** (`skyssbåt`) — a timetable dependency, not a walk.
4. **33 fords** on a comparable walk. These need to be first-class objects with
   seasonality and "worst at peak melt / after rain" logic, not incidental.
5. **Hut stock is not a plan.** Any leg where a self-service larder is the only
   in-between option must require a carried reserve.
6. **DNT key dependency:** required for every selvbetjent/ubetjent hut, member-only,
   collectable only at staffed lodges. The app should warn if the itinerary reaches
   its first unstaffed hut without passing a staffed one.
7. **Parcel windows:** parcels have a **7-day** pickup window; poste restante
   **3 weeks**. A depot plan that ships too early silently fails. The scheduler
   must be deadline-aware in *both* directions.

**Data honesty**
8. **`opening_hours` is the weak point**, not the geometry. Rural Norwegian shops
   close and reopen between seasons; a 2019 hours string is a hazard.
9. **`automat` vs `bemannet` fuel stations** — an automat has no shop. OSM mostly
   does not distinguish this. Manual classification, or the app over-promises food.
10. **Sunday is law, not convention** (helligdagsfred §5), with size-based
    exemptions: ≤100 m² shops and ≤150 m² stations may open. Big supermarket =
    hard closed. So "what can I buy at 20:40 Saturday within 20 km" is a different
    question from "where is the nearest shop".
11. **Svalbard is not Norway** for this purpose, and "DTM 20" for the mainland
    **does not exist** (only 1 / 10 / 50 m).

**Trip realities the app should surface, not hide**
12. **Interannual snow varies by six weeks.** Model year-specific snow, not
    climatology; offer 2–3 alternate lines for the first month (2021: several
    north-starters had to reroute for flooding).
13. **Reindeer**: Finnmarksvidda is winter pasture; herds are on the coast in
    summer. Never walk through a herd; dogs leashed. On the Sweden variant, dogs
    are banned outright in several national parks.
14. **Direction interacts with body composition** (see D8) — do not let the user
    pick 30 km/day and 70 kg lean without saying what it costs.

**Legal**
15. **Attribution is mandatory**: "©Kartverket" with a link; SSR requires the exact
    string "all place names are obtained from SSR ©Kartverket"; OSM is ODbL with
    **share-alike** on derived data; MET Norway needs a real identifying
    User-Agent and must go through a caching proxy at volume; NVDB is NLOD 1.0
    with its own verbatim text.
16. **Prices and stock change**; a shipped static dataset needs a visible "as of"
    date or it becomes misinformation.

---

## 5. Proposed build plan

**Phase 0 — decisions** (this document). You pick D1–D3 and confirm D9.

**Phase 1 — data pipeline (no UI).** Route GPX → 300 m resample → sample
Kartverket DTM via range reads → profile, cumulative ascent (with hysteresis
threshold or you count DEM noise as thousands of metres of false climbing),
terrain class per segment. Output: a versioned JSON that is the single source of
truth for all numbers.

**Phase 2 — map & 3D.** Own vector tiles from N50/N100/N250 + contours from the
same DEM; terrarium PMTiles for terrain; draped route; elevation profile synced
to camera.

**Phase 3 — resupply engine.** Shops + DNT huts + fuel + Post i butikk along the
corridor; gap analysis; "carry 7 days" flags; what to buy and how many kg.

**Phase 4 — calories.** Component-sum model, range presentation, pack-weight
curve, body-mass projection, calibration against actual weight change.

**Phase 5 — interactivity.** Start-date slider driving snow/daylight/hut-opening;
segment cards; filters; risk flags; provenance badges on every fact.

**Phase 6 — publish** on Pages + R2, with full attribution page.

**Phase 7 (separate) — offline PWA** for the trail.

---

## 6. What I need from you

1. **Route:** trunk = FKT-revised line (recommended), or "kun i Norge", or build
   from open data? Do you want me to request public-use permission from the GPX
   authors?
2. **Direction and start date:** S→N mid-May (recommended) or N→S July?
3. **North end:** Nordkapp, +Knivskjelodden, or Kinnarodden?
4. **You, the hiker:** body mass/height/age/sex, pack target, and how many km/day
   you actually want. Without these the calorie model is a demo, not a plan.
5. **Support model:** unsupported (carry everything), mail drops, or resupply from
   family? This changes the resupply engine materially.
6. **Dog?** Hard constraints (Swedish NPs, reindeer, DNT fees).
7. **Basemap:** vector tiles (interactive, more work) vs N50 raster (fast, static)?
8. **Offline:** planning-only first, or is on-trail use in scope from day one?
9. **Language:** Norwegian, English, or both? (Norwegian map data reads better in
   Norwegian; your brief is in English.)
10. **Hosting account:** do you have Cloudflare? R2 free tier may require a card.

---

## 7. Data sources — the shortlist

| Purpose | Source | Licence |
| --- | --- | --- |
| Elevation, profiles, ascent | Kartverket **DTM 1** (ATOM tiles, range-read) / DTM 10 (WCS) | CC BY 4.0 |
| Basemap vectors | **N50 / N100 / N250 Kartdata** → tippecanoe → PMTiles | CC BY 4.0 |
| Basemap raster (fallback) | **N50 Raster** GeoTIFF | CC BY 4.0 |
| Marked trails, cabin points | Kartverket **Turrutebasen** WFS (137k routes) | CC BY 4.0 |
| Shops / fuel / post | **OSM** (Geofabrik NO extract + osmium) | ODbL |
| Shop hours | Chain store pages (Rema/Kiwi/Coop/Joker/Bunnpris) | factual, respect robots |
| Shop completeness audit | **Enhetsregisteret** NACE 47.110 + Kartverket Adresse-API | NLOD |
| DNT hut type/opening | Manual curation (no API — ut.no's Turbase was closed) | — |
| Place names | Kartverket **SSR** API | CC BY 4.0 + DB right |
| Weather | **MET Norway** Locationforecast 2.0 (via caching proxy) | NLOD / CC BY 4.0 |
| Avalanche / flood / slide | **NVE** varsom APIs (no key) | NLOD |
| River levels (fords) | **NVE HydAPI** (free key) | NLOD |
| Rest areas | **NVDB** `Rasteplass` | NLOD 1.0 |
| Protected areas / motorferdsel | Miljødirektoratet downloads + WMS | NLOD |

**Do not use:** FKB (paid), Matrikkel, z≥12 cache tile copying, `landtopo` pilot
MVT, `felles.naturbase.no` API, Terrarium/Mapzen as primary DEM for Norway.
