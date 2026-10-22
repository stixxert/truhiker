# AGENTS.md

Instructions for AI agents working on TruHiker. Read this before changing
anything.

## The product

A browser-only planner for long-distance walking in Norway: route import and
editing, elevation from Kartverket's 1 m terrain model, resupply gaps and food
mass, an energy range, and weather inside MET's forecast horizon.

Everything runs client-side. There is no backend, no account and no server-side
storage of routes. Deployment is static-only Cloudflare Workers.

## Commands

```bash
npm install
npm run dev            # Vite dev server
npm test               # hermetic suite (no network)
npm run test:live      # real Kartverket/MET requests, opt-in
npm run verify         # THE GATE — run this before claiming anything works
npm run build          # typecheck, bundle, copy data and licences into dist/
npm run deploy:rehearsal  # build a bare clone the way the deploy container does
npm run visual-check   # headless Chromium at 1440 and 390 under the real CSP
npx wrangler deploy    # static deploy (no Worker script)
```

`npm run verify` runs: typecheck, hermetic tests (budget: 320 cases, 12 s — currently ~3 s), build,
bundle budget, a headless render and the e2e journey under workerd, the axe and
keyboard accessibility gate, the blocked-network failure paths, i18n parity,
licence audit, the hosting contract and a **deploy rehearsal** — a fresh clone built
with the container's commands, so a build that would fail on Cloudflare fails here
first. A change that breaks it is not done.

## Hard rules

1. **Honesty over completeness.** `null` never renders as `0`. Weather outside the
   forecast horizon has no numeric fields at all. An unknown hut or unmanned fuel
   station is not food. A partial ascent is `null`. These are pinned by tests that
   assert key-level absence — keep them that way.
2. **Licences.** Every shipped file needs a rule in
   `tools/verify/licence-audit.mjs` and an entry in `docs/LICENSES.md`. Never merge
   ODbL data with non-ODbL data in one file.
3. **One data artefact, deliberately.** The OSM resupply extract (ODbL, ~175 KB)
   is generated at build time by `tools/ensure-data.mjs` — from the Geofabrik PBF
   when one is available, otherwise reused/fetched and verified (a deploy build may
   also accept an artefact newer than the pin when it is self-consistent, plausibly
   complete and no older; `npm run verify` is still what enforces the pin, D23) — and
   **nothing
   under `data/` is ever committed** (D24): not the binary, not the provenance the
   site serves, not build notes, **not the ODbL licence text**. The pin is
   `tools/data-manifest.json` (sha256, bytes, counts, source date), and it pins the
   licence text too: `ensure-data` fetches it into `data/` and verifies it, exactly
   as it does the data it covers. The repository holds no copy of either. Do not
   add other generated data to the repo.
4. **Live-first.** Basemap, terrain, elevation, trails and weather are fetched from
   their sources. Only data with no usable live source is bundled.
5. **No new dependencies without a reason.** The app has one runtime dependency
   (MapLibre) plus `@xmldom/xmldom`. Prefer a few lines of code.
6. **Test budget.** 320 cases. Consolidate related assertions into one test (a
   loop inside `it`); `it.each` rows count separately. Prefer an acceptance test
   over three unit tests.
7. **Conventional commits**, and never commit a tree that fails `npm run verify`,
   or another agent's unfinished work. Commit as the repository's configured git
   identity; do not set or change an author.
8. **No secrets**, no analytics, no third-party scripts. The only network origins
   are the ones in the CSP in `public/_headers`.

## Layout

```
src/core      geodesy, TIFF, DEM sampling, profile
src/snap      Turrutebasen client, GML, spatial index, snapping
src/route     immutable trip, commands, undo/redo
src/store     IndexedDB, migration, GPX/GeoJSON IO
src/resupply  shop binary, corridor, live huts, plan
src/plan      energy, nutrition, resupply arithmetic
src/weather   MET client, cache, horizon
src/ui        panels and dialogs (DOM, no framework)
src/app       orchestration and state
src/map       MapLibre integration
tools/        build + verification tooling (never shipped)
docs/         DECISIONS.md, LICENSES.md, ARCHITECTURE.md, notes/
```

## Ambiguity

Every ambiguous behaviour has a documented default in `docs/DECISIONS.md`. If you
add a behaviour that a user could reasonably expect to differ, add a decision
rather than leaving it implicit.

The reasoning behind the architecture lives in the commit history, not in shipped
documentation. What a maintainer needs is in `docs/ARCHITECTURE.md`,
`docs/DECISIONS.md` and `docs/LICENSES.md`; `docs/notes/` holds review records kept
on purpose (currently the copy review), and everything else was a working note and
was removed.
