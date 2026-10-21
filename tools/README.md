# tools

Build and verification tooling. None of this ships to the browser.

| Path | Purpose |
| --- | --- |
| `build-shops.mjs` | rebuilds that extract from the Geofabrik Norway PBF |
| `inspect-shops.mjs` | decodes the extract: `--stats`, `--verify`, `--near LAT,LON` |
| `verify/verify.mjs` | the gate: types, tests, build, bundle, runtime render, e2e, a11y, failure paths, i18n, licences, hosting |
| `verify/visual-check.mjs [--runtime]` | headless Chromium check of both breakpoints under the real CSP; `--runtime` serves through `wrangler dev` (the default via `npm run visual-check`), the bare form uses the static server (`npm run visual-check:static`) |
| `verify/e2e.mjs` | the scripted journey: load → resupply → energy → weather → save → reload, in workerd (huts from a fixture, not the live WFS; elevation from a synthetic DEM) |
| `verify/a11y.mjs` | axe at 1440 and 390, plus a keyboard-only journey, in workerd |
| `verify/dem-stub.mjs` | a synthetic float32 GeoTIFF for the browser gates, so hoydedata.no being down cannot fail them |
| `verify/failure-paths.mjs` | every live source blocked: DEM, basemap, terrain and weather must degrade visibly |
| `verify/perf.mjs` | FCP, map-interactive and transfer budget under throttled Slow 4G |
| `verify/check-i18n.mjs` | NO/EN key and placeholder parity, no Nynorsk, no hardcoded UI text |
| `verify/runtime.mjs` | shared `wrangler dev` startup used by the browser gates |
| `verify/licence-audit.mjs` | required notices and visible attribution present; an unclassified asset is a warning |
| `verify/verify-deploy.mjs` | `wrangler deploy --dry-run` against a clean copy of the build |
| `verify/copy-data.mjs`, `verify/copy-licences.mjs` | place assets and notices in `dist/` |
| `verify/bundle-size.mjs` | JS budget report |

`npm run verify` is the only entry point that matters; the rest are called by it or
by hand while developing.

**No agent-specific gates.** Everything in this directory checks the product or
the build. Agent process rules live in `AGENTS.md` as prose, not as executable
checks: a gate that fails because a document is formatted a certain way is
ceremony, and it belongs to the agent's workflow, not to the repository.

The resupply data (`data/shops.osm.bin`, 175 KB) is a **build output**, not a
committed file (D24): `tools/ensure-data.mjs` produces it during `npm run build`,
from the Geofabrik PBF when one is available and otherwise from a verified local or
published copy. `data/shops.osm.json` is committed — it records the provenance and
the SHA-256 the artefact has to reproduce — and `build-shops.mjs` regenerates both.
