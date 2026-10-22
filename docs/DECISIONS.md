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

- `opening_hours` is present for **97.2 % of supermarkets, 75.0 % of groceries,
  42.8 % of convenience stores, 40.7 % of fuel stations, 98.5 % of post offices**
  — 76.9 % overall, 6 594 of 8 571 records (measured from the shipped extract's
  own provenance, `data/shops.osm.json`). Absence is shown as **unverified**, not
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
- Once snapped, leaving requires 1.5 × radius (flooring at 120 m, so a very small
  radius does not make an existing snap flicker), which is why parallel paths do
  not oscillate. The sticky radius is **derived** from the radius (`max(120 m, 1.5 × radius)`),
  not fixed: the dock offers 20–300 m, and a fixed 120 m made every call above it
  throw — so the wider the setting, the more certainly snapping was dead.
- No trail within the radius → the segment is drawn **dashed** and labelled
  **off-trail**, and the leg records that in its provenance.
- **The record is per vertex, not per leg.** `RoutePoint.snapped` is set by every
  command that places a point — `insert`, `move`, a snapped `replace-span`, and a
  span re-snap — so a leg can say *which* vertices are on a trail. A leg-level
  marker alone claimed the whole leg was snapped when one corner was, and that is
  the kind of claim this project does not make.
- **A drawn step follows the trail when both ends snapped.** The click becomes the
  trail between the two points (the routing engine's own A*, on the same 5 m merge
  as D16), applied as one undoable edit. If the network does not connect them the
  step is a plain vertex and the off-trail styling says so — never a bridged path.
- `snapped` never means "verified walkable": it means the geometry came from a
  mapped trail. Absent means "not known to be on a trail", which is not the same
  as "off trail".
- **Measured, so the claim is not taken on trust.** With a captured Turrutebasen
  response served to the app (2 269 trails, Oslo), two clicks ~0.5 km apart along
  one trail produced a leg of **105 vertices, 0.61 km drawn against a 0.53 km
  chord, with a maximum deviation of 101 m from that chord** — geometry from the
  trail, not a straight line between two snapped points. Snapping status read
  "Snapp på" for the whole test.
- **When the trail service hangs, the app says so within 12 s** and offers a
  retry (`PREFETCH_DEADLINE_MS`), rather than spinning on "Load trails…" for the
  minutes the WFS client's own retry ladder would take.
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
  demo export has no such field, so the demo showed its source and maintainer
  (the demo itself is gone, D26)
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
- **A view is a box, in both halves.** The hut query sends the box itself
  (`fetchHutsInBounds`) instead of handing two opposite corners to the corridor
  client: a corridor around a box's diagonal drops everything more than a radius
  off it, which measured 2 of 3 waypoints kept at z12 over Gjendesheim.
- **The box is the view plus a margin, and the layer is merged, not replaced.**
  The query covers 1.3× the view (`placesDrawBounds`), and a new answer is merged
  with what is already drawn, keeping every point still inside that box. Sampling
  the shops by zoom was tried and removed: it made the set change shape whenever
  the view moved, so panning dropped and re-placed every glyph — the shops in
  front of you vanished and came back as "new" ones. Every shop in the covered
  box is drawn; the source's own clustering is what compacts a country view.
- **The index is fetched at boot, not on the first camera settle.** It is 175 KB
  and the layer needs it with the first paint (D20 is not conditional on the
  panel), so `App.prefetchShopIndex()` starts it with the app; the panel's own
  query joins that same request. The settle debounce is 200 ms — enough to
  collapse a drag's camera frames into one query — and an identical point set is
  not pushed to the source again, because `setData` on a clustered source rebuilds
  the cluster index and re-places every symbol.
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
  point. Before this, the only ways in were a file and the demo (D26 removed the
  demo).
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

**Default: one ODbL extract, built by the pipeline and served by us.**

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
- **Rebuilding** is `npm run data:build` with `$OSM_PBF` pointing at a
  `norway-latest.osm.pbf` (or `node --max-old-space-size=3072
  tools/build-shops.mjs --pbf <file> --out data`). The artefact is a build output
  and is never committed (D24); the provenance file beside it is. The checksum, the
  per-kind counts and the coordinate bounds are pinned by a validation test, so a
  stale or corrupted artefact cannot ship quietly.

## D23. The resupply artefact refreshes monthly from a cron Worker, and the build runs in a build container

**Question.** The OSM extract is served by us (D22), so it ages. Who refreshes it,
and does that fit the free plan?

**Decision.** A cron Worker posts a Cloudflare **Deploy Hook**; the build runs on
Workers Builds. The Worker is the trigger, never the builder.

**Why the Worker cannot build it.** The source is `norway-latest.osm.pbf` (1.38 GB)
read twice, which wants ~1.4 GB of heap. A Worker has 128 MB of memory and, on the
free plan, 10 ms of CPU per invocation. There is no plan on which a Worker parses
that file. What a cron invocation can do — POST one URL — costs well under a
millisecond.

**What the build container gives (free plan).** 3,000 build minutes a month,
20-minute timeout, 2 vCPU, 8 GB of RAM, deploy hooks at 10 builds/minute per Worker.
One refresh is a download plus two passes: minutes, not hours, so the monthly job
uses a fraction of a percent of the allowance, with room for retries.

**Wiring.**

- `worker/wrangler.jsonc` — the `truhiker-refresh` Worker: `crons: ["0 4 1 * *",
  "0 4 4 * *"]` (1st of the month, plus a retry on the 4th in case Geofabrik or
  the build is temporarily broken). No assets, no routes, so the site's
  static-only contract in `wrangler.jsonc` is untouched and the hosting gate still
  has nothing to waive.
- `worker/cron.ts` — `scheduled()` POSTs `env.DEPLOY_HOOK_URL` and logs the hook's
  status. A rejected hook returns 502 and says so in the log: a silent success
  would look like a refresh that happened. `POST /trigger` with an
  `x-trigger-key` header (secret `TRIGGER_KEY`) is the manual pull after an outage.
- Workers Builds job: build `npm ci && bash tools/refresh-shops.sh && npm run
  build`, deploy `npx wrangler deploy`. The refresh step is the producer, the
  `npm run build` after it is the consumer (`tools/ensure-data.mjs` verifies what
  was just produced), and the deploy ships that freshly built
  `data/shops.osm.bin`.
- `tools/refresh-shops.sh` — downloads with `curl -fL --retry` (an HTML error page
  must not be parsed as a PBF), refuses a file under 500 MB (a truncated extract
  parses as "no POIs", the worst failure: an empty index would ship silently),
  builds with `--max-old-space-size=3072` inside the container's 8 GB, then runs
  `inspect-shops --verify` so a refresh that breaks the checksum, the counts or the
  coordinate bounds fails the build instead of deploying. The temp PBF is deleted
  in the same run: the container's disk holds the extract (1.4 GB), `node_modules`
  and `dist` at once, and nothing more is needed.

**Consequence, stated plainly.** The deployed artefact can be newer than the
committed provenance. The committed *provenance* is the pin a rebuild has to
reproduce; the binary itself is a build output and is never in git (D24), so the
site no longer depends on someone remembering, and a checkout no longer carries a
second copy of a file we already serve. `<meta>`/`About data` report the extract date
of whichever file is actually served, so the UI cannot claim freshness it does not
have.

**Manual paths.** `npm run refresh:shops` locally, and
`npm run deploy:cron` to publish the trigger Worker.

## D24. Generated data is built, never committed

**Default: nothing under `data/` is in git — not the binary, not its provenance,
not the build notes. The pin is `tools/data-manifest.json`.**

- **What is committed.** `tools/data-manifest.json`: for each artefact, its file
  name, SHA-256, byte size and record count, plus the source URL, the extract date,
  the licence and the attribution. It is *configuration* — the same category as a
  lockfile — and it is the only thing about a derived dataset that git holds.
- **The licence text is generated too.** There used to be a `licences/` directory
  holding a committed copy of the ODbL text. It is gone: the text is not authored
  here, so it is build output like everything else. `ensure-data` fetches it from
  its publisher into `data/ODbL-1.0.txt` and verifies it against a pinned SHA-256 in
  the manifest — the same discipline as the data — and the build copies it to
  `/data/ODbL-1.0.txt` and `dist/licences/`, because ODbL §4.3/§4.6 require the
  offer to travel with the database.
- **What is not.** `data/shops.osm.bin`, `data/shops.osm.json` (the provenance the
  deployed site serves), and anything else a build writes there. `.gitignore` drops
  the whole directory and the gate fails if *any* path under `data/` is tracked —
  an allow-list was tried first and is what let a provenance file stay committed.
- **Who produces it.** `tools/ensure-data.mjs` runs first in `npm run build`:
  - *producer* — with `$OSM_PBF` (or `--from-pbf <file>`) it rebuilds from
    Geofabrik's extract, rewrites the provenance, and **warns** if the bytes differ
    from the committed pin: the monthly refresh ships newer data than the commit
    describes (D23).
  - *consumer* — with no PBF it reuses a local artefact **only if it matches the
    pin**, or fetches a published copy from `$TRUHIKER_DATA_URL` and verifies it.
  - with neither, the build **fails** and names the three paths. It never ships an
    empty index: an empty list reads on screen as "there are no shops in Norway"
    (D7).
- **What the pin does and does not prove.** A consumer build proves the bytes are
  the ones the commit describes, and that the served provenance agrees on the
  count. It cannot prove the data came from the same extract: the manifest records
  the source URL and extract date, not the PBF's own hash.
- **What is *not* an artefact.** Sourced fixtures are inputs and stay committed:
  the route fixture (`test/fixtures/memurubu-glitterheim-jot21.gpx`, CC BY 4.0
  Turrutebasen — formerly the bundled demo, D26) and the other test fixtures: a
  captured Kartverket DEM window (`galdhopiggen-128.tif`), a captured Turrutebasen
  WFS response (`huts-wfs.xml`), and two small GPX files. They are hand-picked
  inputs with their own licence entries in `docs/LICENSES.md`, not outputs of a
  build.
- **History, because it matters.** This was decided once before (`c9e889c`:
  release asset + SHA-256 manifest + `tools/fetch-data.mjs`) and reverted silently
  inside a commit about security headers (`bf71ca4`), which re-added the 175 KB
  binary and deleted the manifest. A first pass at restoring it kept the generated
  *provenance* committed — still generated data, still in git. This entry is the
  third and final version, and the gate now tests the rule rather than a filename.

**Why:** a rule that lives only in a commit message is not a rule. It is only as
load-bearing as the gate that fails when it is broken — and a gate written against
one filename is a gate that misses the next one.

## D25. The routing graph stays Turrutebasen; OSM is measured and declined

**Default: no OSM in the snapping or routing graph. Turrutebasen is the only
source of trail geometry, and it stays live (D16).**

The question was whether OSM's much larger path network would make drawing and
routing materially better. It was measured, over two boxes, with this repository's
own `buildTrailGraph` (5 m node merge, D16) and A*, on 200 seeded node pairs at
least 1 km apart:

| Box | Graph | lines | km | components | km in largest | pairs routed |
|---|---|---|---|---|---|---|
| Jotunheimen 1 416 km² | Turrutebasen | 278 | 439 | 23 | 84 % | **67.5 %** |
| | OSM `highway=path` | 470 | 683 | 72 | 56 % | 31.0 % |
| | union | 748 | 1 122 | 70 | 89 % | 77.5 % |
| | union, Turrutebasen precedence | 558 | 839 | 85 | 70 % | 51.5 % |
| Reisadalen 878 km² | Turrutebasen | 9 | 30 | 2 | 82 % | **72.5 %** |
| | OSM `highway=path` | 132 | 98 | 80 | 25 % | 7.0 % |
| | union | 141 | 129 | 78 | 39 % | 9.5 % |

- **OSM is more kilometres and less network.** In Jotunheimen 470 path ways share
  only 414 node ids, 39 share none, and 19.9 % of endpoints have another vertex
  within 5 m; even at a 50 m merge tolerance it is 59 components holding 60 % of
  the length. Marked routes interconnect where people actually change route — at
  the huts — which is why 84 % of Turrutebasen's length sits in one component.
- **More path is not more routing.** OSM loses on pair routability in both boxes,
  including the one where the official register is thinnest (Reisadalen: 18 km of
  marked routes against 98 km mapped as paths, and still 7 % vs 72.5 %).
- **The union is the one case that helps, and it does not survive deduplication.**
  C gives 77.5 % against 67.5 %, but only by proximity-bridging two sources that
  then double-count the same paths; removing OSM where it runs along Turrutebasen
  (41 % of its length) drops it to 51.5 %, i.e. worse than Turrutebasen alone.
  In Reisadalen the two layers barely overlap (14.4 %), so dedupe changes nothing
  and the union stays at 9.5 %.
- **The licence is the smaller half of the argument.** OSM would mean a second
  committed-to-ODbL artefact, a second build pipeline, and a second layer that
  cannot share a file with the CC BY 4.0 data (D24, `docs/LICENSES.md`). Given the
  numbers above, that cost buys nothing.
- **What OSM would still be good for** — snapping candidates in regions where the
  official register is nearly empty — is not worth a pipeline either: a 7 %
  routable fragment set would put a user on a path the app cannot continue.

**Why:** the honest unit for routing is connectivity, not kilometres. Counting
kilometres is what made OSM look like the answer; measuring components is what
made the answer "no".

## D26. No bundled demo route

**Default: the app ships no sample route. A first visit is the empty state, and its
primary action starts a new route.**

- **Removed:** `public/demo/memurubu-glitterheim-jot21.gpx` (56 KB, CC BY 4.0
  Turrutebasen), the automatic load on first visit and on `#demo`, the "Demorute"
  chip and its provenance popover, the empty-state "try the demo" button, and every
  string, style rule and licence entry that existed only for them.
- **The empty state now offers the two things that are actually there:** import a
  GPX file, or start a new route. `#btn-empty-new` is the same action as the
  header's *Ny rute*.
- **The GPX itself moved to `test/fixtures/`** and is imported through the file
  input by the e2e journey and the render gate. That keeps the journey on real
  geometry (the deterministic WFS mock is built around it) *and* makes the gates
  exercise the import path a user takes — better coverage than loading a file the
  app preloaded for them.
- **No compatibility shim, deliberately.** `origin` was never persisted (it is
  derived from how the route was loaded), so removing `'demo'` from `RouteOrigin`
  needs no migration and has none. `ProvenanceKind` lost `'demo'` too; the store's
  reader keeps only known kinds — generic schema validation that predates this
  change and would drop *any* unrecognised marker — so an old trip loses that one
  marker and nothing else. No demo behaviour remains (`grep -rn demo src/` finds
  only the word "demoted" in a CSS comment).
- **The share link** no longer has a `#demo` form: a shared route is the encoded
  route, as it always was for imports and drawings.

**Why:** a demo route is a second product to maintain — a licence to keep current,
a provenance popover, a failure path, an origin tag that other code branches on —
and it teaches a first-time visitor to look at someone else's walk instead of
starting their own. The import path is the thing worth showing, and now the gates
prove it works.

## D27. One route, one distance

**Default: every panel reports the same length for the same route — the length its
geometry measures — even though the profile is sampled more coarsely.**

- **The problem:** a GPX with dense points (the test track has 1,164 points over
  9 km) is resampled at 25 m for the map and the elevation profile. Resampling
  interpolates along the polyline, so the sampled path is a little shorter than
  the file's: the route panel said 9.16 km while the profile's Distance said
  9.01 km, on one screen, for one route.
- **The fix:** `buildRoute` keeps the measured length (`pathLength` of the input
  coordinates) and scales the sampled cumulative distances so their last value is
  that length. Sample positions stay ordered and proportional; only the total,
  and the labels derived from it, change.
- **Why not the other direction** (report the sampled length everywhere): the
  numbers a walker compares against are the ones their own GPX says, and the
  resampled figure is an artefact of how the profile samples terrain, not a
  better estimate of the trail. Scaling the *profile* towards the route keeps the
  figure a user can check.
- **Pinned by** `test/route.test.ts` ("reports the route's measured length, not
  the shorter sampled polyline"): the fixture's sampled polyline is measurably
  shorter, and the route still reports the measured length with increasing
  distances.
