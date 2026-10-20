# Decisions — the default for every ambiguity

*Nothing here should be discovered by a user in the field. Each entry states the
default, the behaviour it produces, and why. If a decision is changed, change it
here first.*

---

## D1. Hut food availability

**Default: unknown means no food.**

Turrutebasen gives a hut's position, name and maintainer, but not whether it is
`betjent` (staffed), `selvbetjent` (self-service larder) or `ubetjent` (nothing at
all). That classification exists only as prose on DNT's pages.

- A hut never counts as a resupply point unless the user explicitly opts in.
- The UI labels it **"ikke bekreftet"** and links to DNT for the authoritative
  answer.
- A resupply plan that relies on huts says so in its warnings.

**Why:** assuming food at an unstaffed cabin is the failure mode that ends a trip.
An unknown that costs you a carried meal is survivable; an unknown that costs you
three days of food is not.

## D2. Opening hours, Sundays and holidays

**Default: assume closed unless the data says open.**

- `opening_hours` is present for 75.5 % of Norwegian groceries, 96.3 % of
  supermarkets, 39.5 % of fuel stations. Absence is shown as **unverified**, not
  as "open".
- Sunday: Norwegian law closes fixed retail; small shops (≤100 m²) and fuel
  stations (≤150 m²) may open. The app treats a shop as Sunday-open only when its
  hours say so.
- Public holidays (1 Jan, Maundy Thursday, Good Friday, Easter Monday,
  Ascension, Whit Monday, 25–26 Dec) are treated as closed unless stated.

**Why:** a plan that assumes a Sunday shop is a plan that skips a meal.

## D3. Mail drops and parcel windows

**Default: carry-all.** Mail drops are opt-in per trip.

When enabled, for a planned arrival date `A`:
- **Parcel to a Post i butikk:** collect within **7 days** → ship between `A−7`
  and `A−5`; warn if the hike cannot meet that window.
- **Poste restante:** **21 days** → ship between `A−21` and `A−5`.
- The planner never schedules a drop it cannot prove is collectable.

**Why:** an early parcel is returned; a late one is not there when you are.

## D4. Weather horizon

**Default: 10 days, derived from the response.** MET `Locationforecast 2.0`
returns ~10 days of hourly entries (measured 2026-10-19: 85 entries, +10.0 d).

- Inside the horizon: temperature, precipitation, wind, symbol, and **issued at**.
- Outside it: the badge **"utenfor varselhorisonten"** and **no numeric fields at
  all**. No averages, no interpolation, no placeholder.
- Requests use 4-decimal coordinates (MET returns 403 above that) and are never
  polled on a timer.
- If the first response establishes the horizon, points that could only serve
  later days are not requested at all.
- The panel has two windows: **Trip** (the trip's own start date, the default) and
  **Now** (a quick look that plans the same route from today without changing the
  trip). A trip without a start date has no timeline to draw, so it opens in
  **Now** and the Trip option is disabled — the weather is never a dead end that
  says "set a start date first". The preference is remembered per trip: setting a
  start date returns the panel to Trip.

**Why:** a fabricated forecast is worse than an absent one.

## D5. Snapping radius and off-trail behaviour

**Default: 75 m, sticky at 120 m.**

- A click or vertex within the radius snaps to the nearest trail.
- Once snapped, leaving requires 1.5 × radius, so parallel paths do not flicker.
- No trail within the radius → the segment is drawn **dashed** and labelled
  **off-trail**, and the leg records that in its provenance.
- Re-snapping a span never bridges two trails that do not connect; the gap stays
  visible.

**Why:** a router would silently invent a path. A dashed line and a label do not.

## D6. Storage limits

**Default: IndexedDB, per-trip ceiling 50 MB.**

- Trips are stored in IndexedDB (`bodies` + `summaries`, one transaction).
- `navigator.storage.persist()` is requested once; the trip library reports **the
  size of what this origin stores** and nothing about a maximum.
  `navigator.storage.estimate().quota` is a heuristic about the free disk (it reads
  as "~247 GB" on an ordinary laptop), not a limit a user can fill or act on, so
  "1 MB of ~247 GB used" is noise dressed as information.
- If IndexedDB is unavailable (private browsing), the app falls back to
  localStorage with a **1.5 MB** per-trip limit and says so.
- An unsaved trip is flushed on `pagehide`; a save that has not committed is never
  shown as saved.
- Quota failures name the size that failed.

**Why:** localStorage cannot hold a 3,000 km trace (5–10 MB), and a silent
truncation would be data loss.

## D7. When a live source is down

**Default: degrade visibly; disable derived numbers.**

| Source | On failure |
| --- | --- |
| Kartverket WMTS basemap | fall back to the Geonorge WMS, show a banner |
| Mapterhorn terrain | 3D toggle disabled with the reason |
| hoydedata elevation | profile unavailable; **ascent, descent, time, kcal disabled** |
| Turrutebasen trails | snapping unavailable; drawing stays, off-trail styling |
| MET weather | that day marked unavailable with the reason; other days unaffected |

No zeroes, no blanks that look like data.

## D8. Units, language, time

**Default:** metric (m, km, kg, °C, m/s), **Norwegian** UI with an English toggle,
times in `Europe/Oslo`, dates as `nb-NO`/`en-GB` via `Intl`. Place names are shown
as published and never translated.

## D9. Elevation provenance

**Default:** Kartverket DTM (bare earth, 1 m LiDAR) for every sampled profile;
an uploaded GPX's own elevations are kept and labelled `gpx`. The two are never
silently mixed — the profile names its source.

**Resolution follows the route, and the work is shared.** Sampling at 10 m over
165 km is ~10 MB of raster for detail nobody can see on a 900 px chart, and the
cost is request latency, not bandwidth:

| Route length | Pixel size | DEM window | Requests for a 165 km route |
| --- | --- | --- | --- |
| ≤ 20 km | 10 m | 5 km | 47 (was the default for every route) |
| ≤ 60 km | 15 m | 10 km | 17 |
| ≤ 150 km | 20 m | 15 km | ~12 |
| above | 30 m | 20 km | 11 |

- Measured on a 165 km straight line: **28.8 s → 4.6 s**, 47 → 11 requests.
- There is **one worker per page**, and its `HoydedataDem` caches are kept per
  pixel size for the worker's lifetime. Re-sampling the same route after an edit
  is a cache hit, not a second download (measured: 4.8 s → 1.3 s).
- The panel says which wait it is: **"Fetching terrain data from Kartverket …
  7 of 12 tiles"** while windows are on the wire, then **"Downloaded —
  calculating the profile …"** for the (synchronous) profile maths. A progress bar
  is shown only for the part that has progress to report.

## D10. Energy model and food weight

**Default:** component-sum model (Minetti for grade, Mifflin–St Jeor or
Cunningham for BMR). A **range** is shown, never a point estimate. Intake ceiling
2.5 × BMR. Food density 4.4 kcal/g, adjustable; cost in NOK from a seed table that
states its date.

When TDEE exceeds the intake ceiling the planner says the deficit is structurally
unavoidable — it does not quietly plan a 15 kg loss.

## D11. Data freshness

**Default:** every fetched fact names its source, and shows a time only when the
time is a fact about the data.

- Turrutebasen metadata carries `oppdateringsdato` (often years old). The bundled
  demo export has no such field, so the demo shows its source and maintainer
  rather than a freshness date the file does not contain.
- Shops show the **extract date**, whether their hours are unverified, and the
  ODbL line. That date is the data's vintage; when *we* read the file is not.
- The supply panel shows **no "hentet HH:MM"**. The shops are a bundled local
  file, the corridor and the plan are computed in the browser, and the only live
  part (the hut query) has its own failure warning. A fetch time over local data
  reads as machine output and answers no question the user has.
- Weather shows the **issue time** (a MET fact) and the horizon.
- Elevation names its source (Kartverket DTM) and says nothing about a clock: a
  national terrain model does not become stale at 13:14.
- Trail metadata fetched during a snap keeps `oppdateringsdato`; the current UI
  does not display it.

## D12. What the app refuses to claim

**Default: refuse, and say so on screen.**

- It is not a navigation device. **About data** says the numbers are estimates and
  asks the reader to check conditions on the ground; the map footer carries data
  credits, not a slogan.
- No route is "official". Provenance is always shown.
- No season is promised by the app itself; opening data belongs to the sources.
- No mountain safety advice: avalanche and flood warnings are shown if available,
  but absence is not safety.

## D13. Fuel stations as food

**Default: a station sells food unless it is flagged unmanned.**

The binary carries a heuristic "unmanned" bit (`automated`, vending-only, or a
name containing "automat"). A flagged station counts for nothing; an unflagged
one counts as a food source **and the plan says so**, with "confirm it is not a
card-only automat" attached.

This is deliberately the opposite default to a hut (D1). A hut's food status is an
administrative fact we cannot observe; a fuel station's is a physical one that the
planner can verify in seconds on arrival, and treating every station as empty
would produce absurd carry plans in northern Norway. The asymmetry is intentional
and is stated in the UI.

## D14. Missing daily distance

**Default: assume 25 km/day — and say so.**

If the trip has no usable `dailyKm`, every day count needs a number. The plan uses
25 km/day and emits an explicit warning: *"No daily distance is set … every day
count below follows from that guess."* It never substitutes silently.

## D15. Elevation that is only partly known

**Default: unknown, not partial.**

A leg's ascent/descent is reported only when **every** consecutive pair has
elevation. One missing sample makes the whole figure `null` rather than a smaller
number that looks complete. The same rule applies to imported GPX files, whose own
`<ele>` values are labelled `gpx` and never blended with DEM samples.

Known limitation (declared, not hidden): a GPX exported from a mixed-source trip
and re-imported relabels its DEM points as `gpx`, because GPX has no field for
provenance. The elevation values are preserved.

**Sea level is a surface, not a hill.** The DTM is a bare-earth model that returns
exactly 0 m over the sea, and a lake's surface is whatever the model holds there.
So:

- A contiguous stretch at or below 0.5 m is measured (`Profile.seaLevelM`) and, when
  it is at least 300 m long *and* the rest of the route rises more than 50 m above
  it, named in a banner: "About {distance} of this route is at sea level. If the
  line crosses water, that stretch cannot be walked."
- The readout at such a point says **"0 m · sea level"**, not "0 m a.s.l." — the
  number is the sea, and calling it a measured height is the lie.
- Nothing is rewritten: a coastal walk that really is at 0 m stays 0 m. The banner
  is a question ("if the line crosses water"), not a correction.

## D16. Trail routing

**Default: route only where the fetched trail network connects the two points.**

- The source is **Turrutebasen** (CC BY 4.0), fetched live through Geonorge WFS
  for a bounded box around the endpoints: at most 1.5° per side, 1.5 square
  degrees, and 5,000 features. OSM is not used.
- A clicked point may be up to **250 m** from a trail; it snaps to the nearest
  segment and the route starts at the snapped point, not at an arbitrary vertex.
- Vertices within **5 m** are the same node. Nothing else connects routes: two
  trails that cross without a shared or near-shared vertex are not joined.
- If the network does not connect the points, the app says so. It never draws a
  straight line, never bridges components, and never offers "as the crow flies".
- A routed polyline **replaces the active leg** as an undoable edit, with
  Turrutebasen provenance (service URL, fetch time, licence, modified marker).
- Seasonal and one-way attributes are not asserted: `sesong` and `merking` are
  empty in the available data.
- Endpoints are placed with the pointer. The map is keyboard-pannable, but placing
  an arbitrary endpoint without a pointer is not supported yet; this is stated in
  the README limits rather than hidden.

**Why:** a path that crosses a river, a cliff or a gap it never checked is the
one routing failure that can end a trip. An honest "no path" is the product.

## D17. Basemap choice

**Default: three basemaps — Topo, Grå and Flyfoto. WMS exists only as the
fallback for Topo/Grå, never as a button.**

- Kartverket's WMTS `topo` and the Geonorge `wms.topo` it falls back to render the
  **same cartography**: one N50–N2000 stack, drawn once into tiles and once
  server-side. Measured on the same tile box: mean pixel difference 5.95/255 at
  z12 (Oslo) and 1.63/255 at z16 (Jotunheimen) — renderer differences only, and
  they shrink as you zoom in.
- The WMS is therefore **not a choice**: same map, rendered per request by the
  origin instead of served from a cache — slower, and rate-limited by someone
  else's server. It stays wired exactly as D7 requires (automatic fallback, named
  in the banner while in use).
- `toporaster` exists in the same cache but is the old scanned N50 (serif labels,
  coarse generalisation, no coverage above ~z14 in the mountains), so it is not
  offered.

### Flyfoto: which aerial actually shipped, and why that one

**Kartverket's Sentinel-2 cloud-free mosaic**, `wms.geonorge.no/skwms1/wms.sentinel2`,
layer `2025`:

- **Open data**: the Geonorge metadata says *Tilgangsrestriksjon: Åpne data* and
  *"No conditions apply to access and use"*, with one credit condition: the mosaic
  is processed Copernicus Sentinel-2 data and must be credited as
  `Copernicus Sentinel-2 data (year) / processed by the Norwegian Mapping Authority`.
  Shown in the map footer while the layer is active, in **About data** and in
  `docs/LICENSES.md`.
- **Same 10 m source as any Sentinel-2 mosaic.** This does not raise the
  resolution — nothing key-free does (see the table below). What it changes is
  provenance, currency (2025, updated annually) and cost: it is a Norwegian
  official service on `wms.geonorge.no`, an origin already allowed for the topo
  fallback, so the layer adds **no third-party host** and no second licence.
- The service renders tiles per request rather than serving a CDN cache, so the
  useful zoom stops at **z13** (10 m native at 61°N) and MapLibre overzooms past
  it. That is what keeps the per-view request count and render cost down.
- It replaced the EOX `s2cloudless-2017` WMTS that shipped first: same 10 m class
  of imagery, older (2017), murkier colour, a third-party host, and every later
  EOX year is CC BY-NC-SA (non-commercial), so 2017 was the only lawful EOX
  option. Kartverket's own mosaic is simply the better version of the same data.
- Known limitation: August composites still carry snow on the high plateaus, so
  Jotunheimen's summits read white. That is the imagery, not a rendering bug, and
  it is why Topo remains the layer for ground detail.

### Aerial options that were rejected (verified, so nobody re-litigates)

| Option | Verdict |
| --- | --- |
| **Norge i bilder** (`wms.nib*`, `wms.ortofoto`, `services.norgeibilder.no`, `tilecache.norgeibilder.no`) | Closed. Public `GetMap` gets an authorisation `ServiceException`; `wms.ortofoto` 500; `tilecache` **499 "Token Required"**; Kartverket has announced the last *open* WMTS instances are shut for good — access is for Norge digitalt parties via GeoID, in 1-hour/1-day/1-week tokens. |
| **Esri World Imagery** | Licensing, not coverage. Coverage is real (0.00 % no-data measured at z11/z13/z16 over Jotunheimen — the white is snow) but the product terms require an ArcGIS Online subscription for use in non-Esri software. Corrected from the first draft of this entry, which called the white "no-data gaps". |
| **Mapbox Satellite** | Paid per tile request and only reachable with an access token shipped in a static bundle — extractable, and quota theft waiting to happen. |
| **Google** | Prohibited outright: GMP terms §3.2.4(e) "No Use With Non-Google Maps" forbids Google imagery in a MapLibre map. |
| **Bing Maps** | Free/Basic retired June 2025, hardcoded tile URLs forbidden, and imagery may not be used with a competing mapping platform. |
| **Azure Maps** | Subscription key + per-transaction billing, no anonymous tier, and a render API that is being retired. |
| **Sentinel Hub / CDSE** | OAuth2 client-credentials only; no anonymous WMTS. EOX *is* the key-free derivative of this data. |
| **Per-municipality FKB orthophoto** | Open as files, never as a tile service; each municipality would be another CSP origin. |
| **DEM relief as a pseudo-aerial** (Mapterhorn) | Possible, greyscale, unlabelled, ~7–13× the bytes per area of the satellite JPEG. Kept as the fallback if EOX ever disappears. |

- If the aerial source ever stops answering, the app falls back to Topo and says
  so in a banner — it never leaves the map showing a photo that will not load.
- The slot costs what D17 always said it would: one raster source, one CSP origin
  and one row in `docs/LICENSES.md`.

**Why:** a "WMS" button teaches the user that the app has two maps when it has
one; and an aerial layer is worth a button only when its licence and its pixels
both survive a walk in Jotunheimen. Sentinel-2 at 10 m does not show you a bridge
— it shows you the valley you are walking into, which is the question a photo
answers.

## D18. Nothing paints over the basemap's own labels

**Default: no overlay layer above a basemap raster.**

- Kartverket's tiles carry **both** the relief shading and the place labels
  (summit names, spot heights, contours) baked into the same PNG.
- This style has **no glyph server** — deliberately, per the CSP — so there is no
  label layer that could be drawn above an overlay. Anything painted above the
  basemap therefore paints over the labels.
- A `hillshade` layer was drawn above the basemap for depth. It was removed: on
  the steep shaded faces where a hiker actually reads them, summit names and spot
  heights (`Surtningssue 2368`, `Besshøe 2258`) washed out, and the wash moved as
  the map was pitched. A/B on the same view: hide the layer and the labels are
  crisp, with the relief unchanged, because the relief was already in the tiles.
- Consequence: the DEM (Mapterhorn) feeds **3D terrain only** and is fetched when
  3D is switched on. In a steep pitch, labels near the horizon stay soft — a
  raster drape is minified there, and no styling fixes that. That is a limit, not
  a bug; vector tiles would be the fix and they need a glyph server.
- If a basemap without relief is ever added, a hillshade may come back — **below**
  its labels, which for a raster basemap means it does not come back at all.

**Why:** an unreadable summit name is not a cosmetic flaw on a route planner; it
is the one thing on the map the user is looking for.

## D19. Panels dock, scroll, and never clip

**Default: a panel is a full-height dock on desktop and a bottom sheet on a phone.
It scrolls, and the map chrome moves out of its way rather than being covered.**

- The panel head (tabs, refresh, close) stays pinned while the body scrolls, so
  the way out is always on screen.
- The scrollbar is a classic, always-visible one with a reserved gutter, not the
  OS overlay kind that only appears while scrolling. A panel that runs out of
  room must *look* scrollable, because a card cut in half at the panel edge is
  indistinguishable from a bug.
- While a panel is open, the zoom/compass/fit stack and the attribution step left
  of the dock. Nothing is hidden underneath the panel, and the map still pans and
  zooms behind it.
- On a phone the panel is a bottom sheet, capped so a strip of live map and the
  editor bar stay visible; on a viewport under 680px tall it is viewport-fixed
  and scrolls as a whole.
- One accent-filled action per surface: in the top bar that is **Save**, so
  "Open GPX" is a secondary button there. A panel keeps its own primary action,
  because a panel is its own surface.

**Why:** the resupply list is read, not skimmed — the panel exists to show the
distance to the next food. Hiding the bottom third of that answer, behind an
invisible scrollbar, is failing at the one thing the panel is for.

## D20. Resupply points are on the map, not only in the panel

**Default: the shops, fuel, post points and huts in the corridor are drawn as soon
as a route is known — panel open or not — and each kind has its own glyph.**

- The map layer is **viewport-scoped, not route-scoped**: the bundled shop index
  is queried for the current view (a local scan of 8 571 records), so shops and
  fuel stations are on the map anywhere in Norway, route or no route. Huts are the
  live half, so they are asked for only at zoom ≥ 12, where the box is small, with
  a five-minute cache per rounded box and the same request cap as a corridor query.
- Below the cluster threshold they **compact into one count badge** per group
  (`cluster: true`, radius 48, breaking up at z12): a screen of 250 glyphs is not
  readable, a badge saying "99+" is. Clicking a badge zooms to where it splits.
- The badge is a **pre-rendered image**, not a text layer: 30 px, 2 px ring, a
  heavy count, drawn once per bucket at load time (2–9, 10, 20, 50, 99+, 250+) in
  two tones. A `clusterProperties.food` sum decides the tone — a group with food in
  it gets a sea-green ring, a group of huts gets ochre — so a zoomed-out view says
  whether the group is worth walking to without a legend. No glyph server, no text
  shaping, no per-frame work: MapLibre blits a texture.
- Badges are **bigger when further out** (`icon-size` 1.2 at z3 → 0.85 at z12):
  at z5 the badge is the only readable thing on screen.
- Markers below the cluster threshold **collide as a unit** (disc, rim and glyph
  are one image) and are sorted so food wins a contested slot. Measured over Oslo:
  z8 45 features → 36 badges; z12 126 → 76 badges + 16 markers; z14 125 → 61
  markers (decluttered), each view reaching map idle in ~0.9–1.1 s including
  basemap tiles.
- The corridor query still runs when the route or the profile changes, so the
  route's own points carry their plan numbers (distance, gap, detour). A point in
  view that is also on the route is drawn once, from the corridor row.
- A point that counts as food is a filled disc with a white glyph; anything that
  is not confirmed food (huts, unmanned fuel) is hollow with a dark glyph, so
  "not food" is visible without reading the card. Kind is carried by the glyph
  (basket, pump, envelope, hut) and by colour — the two together do not need a
  legend.
- The glyphs are drawn on a canvas at load time and registered with
  `map.addImage`: an icon needs no glyph server, so the style still fetches no
  font and the CSP is unchanged.
- A hover card and a click still answer with words and move the profile cursor.

## D21. The editor is an object, not a wall of verbs

**Default: the left rail is the editor. The bar holds mode, history and status;
everything that acts on something lives in the dock, next to that something.**

- **New route** is a first-class action in the header: an empty trip keeps the
  current profile, switches to Draw, and the first map click creates the first
  point. Before this, the only ways in were a file and the demo.
- The dock lists the **trip and its legs** (name, distance, point count). The
  active leg is marked in the list and drawn highlighted on the map, and picking a
  leg frames it. This is the object model made visible: the old bar had verbs
  ("reverse leg", "trim to selection") whose object the user could not see.
- The **inspector** shows only what applies to the current selection — a point, a
  span, or a leg — and it is built from `availableCommands()`, so nothing can
  appear that the command layer would refuse. A row of greyed-out buttons is a
  menu; a toolbar shows the three things that can be done now.
- **Snap settings** (toggle, radius, point count) belong to drawing, so they live
  in the dock. **Save** moves into the dock while the rail is open and returns to
  the top bar in View mode: one accent action per surface, never two.
- **Keys** are stated, not implied: Escape leaves the mode, Backspace takes back
  the last drawn point, Delete removes a single-vertex selection. The hint line
  names the ones that apply, and `editorKeyAction()` is the pure mapping a test
  pins.
- The dock is a bottom sheet on a phone, capped so the map stays visible.

**Why:** the editor was described as fragmented, and it was — six verbs in a row,
no visible trip structure, no way to start from scratch, and a Save that lived a
corner away from the work. Naming the object and putting its actions beside it is
the fix; more buttons was the disease.

## D22. The resupply layer ships with the app, it is not queried live

**Default: one committed ODbL extract, served by us, rebuilt deliberately.**

- **Where it comes from.** Geofabrik's `norway-latest.osm.pbf` (extract 2026-10-18,
  1.38 GB) is filtered by `tools/build-shops.mjs` to **8,571 points** — supermarket
  3,971, convenience 554, general 288, grocery 24, fuel 2,283, post office 1,252,
  parcel locker 199 — deduped from 8,813, and written as `data/shops.osm.bin`
  (175 KB) with the provenance in `data/shops.osm.json`: tag filter, primary-type
  priority, exclusions, opening-hours coverage, unmanned-fuel heuristic, sizes and
  a checksum.
- **Where it is served from.** Ourselves, as a static file beside the app
  (`/data/shops.osm.bin`), with the ODbL text at `/data/ODbL-1.0.txt` and the
  attribution in the map footer, **About data** and the licence notice. That public
  copy is what ODbL's share-alike and access terms require; nothing re-hosts or
  reshapes it for someone else.
- **Why not live.** Overpass is the only free query route and it cannot carry a
  pan. Measured 2026-10-20: a 0.07° × 0.14° box over Oslo returned **502**; a
  0.4° × 0.7° box returned **200 after 38.2 s** with **417 KB of JSON for 1,017
  points**. That is per view, debounced on every pan, against a rate-limited public
  service. The same country as our own file is **175 KB, once, in roughly 100 ms**.
- **Why not a commercial places API.** They are keyed, per-request billed, and
  their terms forbid caching the results — which is exactly what a map layer is.
- **Huts are the opposite case and stay live** (Turrutebasen WFS, CC BY 4.0): they
  are few, tied to a place and change, they are fetched on demand, and the view
  layer holds them to zoom ≥ 12 with a five-minute cache (D20).
- **Rebuilding** is `node --max-old-space-size=1400 tools/build-shops.mjs --pbf
  <norway-latest.osm.pbf> --out data`. The checksum, the per-kind counts and the
  coordinate bounds are pinned by a validation test, so a stale or corrupted
  artefact cannot ship quietly.
