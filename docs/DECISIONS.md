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

## D10. Energy model and food weight

**Default:** component-sum model (Minetti for grade, Mifflin–St Jeor or
Cunningham for BMR). A **range** is shown, never a point estimate. Intake ceiling
2.5 × BMR. Food density 4.4 kcal/g, adjustable; cost in NOK from a seed table that
states its date.

When TDEE exceeds the intake ceiling the planner says the deficit is structurally
unavoidable — it does not quietly plan a 15 kg loss.

## D11. Data freshness

**Default:** every fetched fact shows when it was obtained.

- Turrutebasen metadata carries `oppdateringsdato` (often years old). The bundled
  demo export has no such field, so the demo shows its source and maintainer
  rather than a freshness date the file does not contain; snapped trail metadata
  keeps the field, and the current UI does not display it.
- Shops show the extract date and whether their hours are unverified.
- Weather shows the issue time and the horizon.
- Elevation shows "hentet HH:MM".

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

**Sentinel-2 cloudless 2017 by EOX**, `s2cloudless-2017_3857`:

- `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2017_3857/default/g/{z}/{y}/{x}.jpg`
  — note `{z}/{y}/{x}` (row before column), 256 px, JPEG.
- **CC BY 4.0**, per the layer's abstract in the live WMTS capabilities
  (`…released under Creative Commons Attribution 4.0 International License`).
  Attribution shown in the map footer while the layer is active, and listed in
  **About data** and `docs/LICENSES.md`.
- **10 m native**, so `maxzoom: 14`: past that MapLibre overzooms the z14 tile
  instead of requesting an interpolation the service would serve anyway. The
  button is for orientation, not for reading ground detail — Topo is for that.
- 2017 is deliberate. Every later year (2018–2025) is **CC BY-NC-SA 4.0**, which
  forbids commercial use; 2017 is the last version under plain CC BY 4.0.

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
