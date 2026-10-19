# Copy review

Every user-visible string in `src/i18n/no.ts`, `src/i18n/en.ts` and the static
fallbacks in `index.html` was read as a pair, key by key, against
`docs/DECISIONS.md`. The test applied: does this sentence state a fact the app can
support, in the same voice in both languages, without softening it?

## Hedging and passive disclaimers removed

- `weather.horizonNote` — "vi fyller ikke inn anslag" / "we do not fill in
  estimates" → "ingen anslag" / "no estimates". The horizon itself stays, because
  it is a fact about MET's data, not a hedge.
- `supply.warnHutOne` / `supply.warnHutMany` — "not machine-readable" → "not
  known". The first described the implementation, the second describes what the
  user actually has: an unknown.
- `weather.noValues` — "ingen målinger" / "no measurements" → "ingen verdier" /
  "no values". The app shows forecast values, not measurements.
- `weather.warningsBestEffort` — "Varsler hentes på beste evne og kan mangle" /
  "fetched on a best-effort basis" claimed a capability the app does not have:
  `MetAlerts` is deliberately unimplemented and returns no warnings. The sentence
  was deleted, and the panel's standing note says instead that hazard alerts are
  not supported and that silence is not safety (D12).
- `supply.warnBridged` — "er trolig ikke en sti" / "it is probably not a path" →
  "er ikke en registrert sti" / "it is not a mapped trail". A straight line
  between legs that do not meet is a known fact, not a probability.
- `about.disclaimer` — "må alltid verifiseres" / "must always be verified" →
  "Sjekk forholdene" / "Check conditions". The instruction is the same; the
  nominalisation is gone.
- `about.disclaimerTitle` / `about.disclaimer` — "Ikke et navigasjonsverktøy" /
  "Not a navigation device" became a slogan, so it is gone: the dialog is titled
  "Estimater" / "Estimates" and asks the reader to check conditions on the
  ground. The map footer carries data credits only.

## Claims corrected to what the app actually does

- `app.metaDescription` and `empty.body` — "Alt skjer i nettleseren" / "Everything
  runs in your browser" was false: the app sends route positions to Kartverket,
  MET, hoydedata.no and Mapterhorn. Both now say the **route** stays in the
  browser, which is true and is the privacy claim that matters.
- `empty.privacy`, `about.privacy` and their `index.html` no-JS fallbacks — name
  all four destinations in both languages, including 3D terrain (Mapterhorn). The
  fallbacks previously disclosed less than the strings that replace them.
- `editor.reroute*` — "Reroute" was an English verb in the Norwegian UI and
  implied finding a new route, which the feature does not do. Now "Fest til sti" /
  "Snap span to trail", and the hint ends "utenfor sti" / "outside a mapped trail"
  instead of reviving the old "avstikk" terminology.
- `demo.note` — "ekte spor" / "real geometry" aligned to "ekte stigeometri" /
  "real trail geometry", the term used in `about.demo`.
- `banner.hashTooLong` — "Last opp filen" / "Upload the file" → "Åpne filen" /
  "Open the file". The app opens a local file; it never uploads one.
- `storage.fallback` — "ca. 5 MB" described the origin's quota, not the limit that
  refuses a trip. It now states the real per-trip ceiling, 1.5 MB.
- `supply.badgeHoursUnread` — "åpningstid ikke lest" / "hours not read" →
  "åpningstider ikke lagret" / "hours not stored". The extract stores whether OSM
  had hours, not the hours themselves.

## Ambiguity removed

- `editor.offTrail*` — "avstikk" was used both for the planner's detour
  (`supply.detourValue`, distance from the route) and for geometry that leaves a
  mapped trail. The second meaning is now "utenfor sti" / "outside a mapped
  trail" everywhere, and `supply.radiusHint` says "Avstikkeren fra ruten" so the
  remaining use is unambiguous.
- `source.title` — "bart terreng" / "bare earth" → "terrengmodell uten bygg og
  vegetasjon" / "terrain model without buildings and vegetation".
- `profile.loading` — the counter counts DEM tiles; English said "cells" and
  Norwegian said nothing. Both now say tiles (`fliser` / `tiles`).
- `weather.issued` — "sendt {time}" → "varsel sendt {time}" / "forecast issued
  {time}"; the bare word could be read as the parcel or the message.
- `demo.maintainer` — "Vedlikehold" → "Vedlikeholdes av", so the label reads as a
  sentence with the name below it.
- `supply.mailDrop` — "Drop for {name}" → "Pakke til {name}" / "Parcel to {name}",
  the term used by Posten and by the settings hint.

## Voice and terminology parity

- English used "mass" and "weight" for the same quantity (`settings.mass`,
  `energy.packMass`, `energy.massTitle`); all three now say "weight". Norwegian
  already used "vekt" throughout.
- `stats.elevationSource` — Norwegian "Høydedata" ("elevation data") → 
  "Høydedatakilde" ("elevation source"), matching the English and the badge it
  labels.
- `settings.paceTitle` — "Dagslengde" (length of the day) → "Dagsdistanse", with
  the English "Daily distance".
- `banner.basemapRetry` — Norwegian now names what is retried: "Prøv
  hurtigbufferen for kartfliser igjen".
- `lang.no` / `lang.en` — "Norsk – NO" / "Norwegian – NO", so the visible button
  text is part of the accessible name (WCAG 2.5.3).
- `action.more` added: the two mobile disclosure toggles had a hardcoded
  `aria-label="Mer"`, so screen readers announced Norwegian in English mode.

## Grammar that depended on a count

- `supply.indexLine` — "… {count} punkt …" → "… {count} punkter …" (the extract
  always holds thousands).
- `supply.warnDetour` — "Punkter mer enn 2 km fra ruten: {count} ({names})."
- `supply.warnHoursSome` — "Åpningstider mangler i OSM for {missing} av {total}."
  Both avoid "1 punkt"/"1 points" without conditional keys.

## Decisions made visible in copy (D12–D14)

- `weather.alertsUnsupported` is shown on every render of the weather panel:
  avalanche, flood and severe-weather warnings are not implemented, and an empty
  warning list is not a clearance (D12).
- `supply.warnDailyKmFallback` states the assumed 25 km/day whenever the trip has
  no daily distance, and says every day count follows from it (D14).
- `supply.warnStaffedFuel` names the fuel stations assumed staffed and asks the
  reader to confirm none is a card-only automat (D13).
- `supply.warnBridged` states how much of the trip is a straight line between legs
  that do not meet (D5).
- Quota failures name the size that failed (D6): `StoreError` now carries the
  payload size, `SaveStatus` passes it through, and `save.quotaSize` /
  `store.quotaSize` say "turen er 8,4 MB" / "the trip is 8.4 MB" when it is known.
  The unsized strings remain as the fallback for errors that carry no size.
- `README.md` "Limits" now says a hut never counts as resupply **unless you opt
  in** (D1), which is what `supply.warnHutsCounted` describes.

## Stated limitations, not hidden

- `docs/DECISIONS.md` D11 claimed Turrutebasen routes show `oppdateringsdato`. The
  bundled demo export contains no such field and the current UI does not display
  the parsed snap metadata, so the decision now states that limitation instead of
  claiming a date the app cannot show.
- D9's `gpx` elevation label exists in the stored route points and the exported
  GPX (`npl:eleSource`), not as a badge in the stats bar; no copy claims
  otherwise.
- The brand is **TruHiker** in the title, the header, the 404 page and both
  dictionaries. "Ruteanalyse" / "Route analysis" was a description used as a
  name.

## Deliberately kept

- Every statement of a real uncertainty: the forecast horizon, "ikke bekreftet"
  hut food, unverified opening hours, the model's TDEE band. Removing these would
  make the app claim more than its data supports.
- "antas/assumed" in `supply.warnStaffedFuel` and `energy.fatAssumed`: both name a
  concrete assumption the user can override (D13), not a hedge.
- Units, licence identifiers, place names and URLs are not translated.

## Routing copy (added in the routing phase)

The Rute action added 14 strings, all in both languages: the action label and
hint, the two picking prompts, the loading line, the success line, the five
failure explanations (no trail near start/end with the 250 m radius, no path,
area too large, too many trails, service unavailable) and the "open a leg first"
guard. The failure strings say what to do next ("move the points closer
together") rather than dumping an error, and "no path" states that the network
does not connect the points — there is no "as the crow flies" wording anywhere.

## Evidence

- `npm run i18n` — 451 keys in both languages, identical placeholder sets, no
  Nynorsk forms, no hardcoded UI text.
- `npm run verify` — PASS, including the i18n, accessibility and failure-path
  gates.
