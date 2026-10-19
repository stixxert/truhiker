# Decisions — the default for every ambiguity

*Nothing here should be discovered by a user in the field. Each entry states the
default, the behaviour it produces, and why. If a decision is changed, change it
here first; `scripts/check-decisions.mjs` requires every section below to exist.*

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
- `navigator.storage.persist()` is requested once; usage is shown in the UI.
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

- Turrutebasen routes show `oppdateringsdato` (often years old).
- Shops show the extract date and whether their hours are unverified.
- Weather shows the issue time and the horizon.
- Elevation shows "hentet HH:MM".

## D12. What the app refuses to claim

**Default: refuse, and say so on screen.**

- It is not a navigation device; the "planning aid — verify on the ground" notice
  is visible at every width.
- No route is "official". Provenance is always shown.
- No season is promised by the app itself; opening data belongs to the sources.
- No mountain safety advice: avalanche and flood warnings are shown if available,
  but absence is not safety.
