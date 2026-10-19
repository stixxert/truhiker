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
npm run visual-check   # headless Chromium at 1440 and 390 under the real CSP
npx wrangler deploy    # static deploy (no Worker script)
```

`npm run verify` runs: typecheck, hermetic tests (budget: 250 cases, 12 s — currently ~2.5 s), build,
bundle budget, licence audit, decisions check and the hosting contract. A change
that breaks it is not done.

## Hard rules

1. **Honesty over completeness.** `null` never renders as `0`. Weather outside the
   forecast horizon has no numeric fields at all. An unknown hut or unmanned fuel
   station is not food. A partial ascent is `null`. These are pinned by tests that
   assert key-level absence — keep them that way.
2. **Licences.** Every shipped file needs a rule in
   `tools/verify/licence-audit.mjs` and an entry in `docs/LICENSES.md`. Never merge
   ODbL data with non-ODbL data in one file. UT.no, Wikiloc, AllTrails and
   Outdooractive content is never used or redistributed.
3. **One data artefact, deliberately.** The OSM resupply extract
   (`data/shops.osm.bin`, 175 KB, ODbL) is a committed build input served by the
   app — the repo is the build input for a static deploy. Regenerate it with
   `tools/build-shops.mjs`; do not add other generated data to the repo.
4. **Live-first.** Basemap, terrain, elevation, trails and weather are fetched from
   their sources. Only data with no usable live source is bundled.
5. **No new dependencies without a reason.** The app has one runtime dependency
   (MapLibre) plus `@xmldom/xmldom`. Prefer a few lines of code.
6. **Test budget.** 250 cases. Consolidate related assertions into one test (a
   loop inside `it`); `it.each` rows count separately. Prefer an acceptance test
   over three unit tests.
7. **Conventional commits**, and never commit a tree that fails `npm run verify`,
   or another agent's unfinished work. Author identity:
   `Sivert <50026231+stixxert@users.noreply.github.com>`.
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

Every ambiguous behaviour has a documented default in `docs/DECISIONS.md`, enforced
by `tools/verify/check-decisions.mjs`. If you add a behaviour that a user could
reasonably expect to differ, add a decision rather than leaving it implicit.

The reasoning behind the architecture — including the mistakes that shaped it — is
in `docs/notes/`, starting with `08-corrections.md`.
