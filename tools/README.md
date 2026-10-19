# tools

Build and verification tooling. None of this ships to the browser.

| Path | Purpose |
| --- | --- |
| `build-shops.mjs` | rebuilds that extract from the Geofabrik Norway PBF |
| `inspect-shops.mjs` | decodes the extract: `--stats`, `--verify`, `--near LAT,LON` |
| `verify/verify.mjs` | the gate: types, tests, build, bundle, licences, decisions, hosting |
| `verify/visual-check.mjs` | headless Chromium check of both breakpoints under the real CSP |
| `verify/licence-audit.mjs` | every shipped file maps to a licence; notices present |
| `verify/check-decisions.mjs` | the documented defaults still exist; no TODOs in `src/` |
| `verify/verify-deploy.mjs` | `wrangler deploy --dry-run` against a clean copy of the build |
| `verify/copy-data.mjs`, `verify/copy-licences.mjs` | place assets and notices in `dist/` |
| `verify/bundle-size.mjs` | JS budget report |

`npm run verify` is the only entry point that matters; the rest are called by it or
by hand while developing.

The resupply data (`data/shops.osm.bin`, 175 KB) is a committed build input: it is
a Derivative Database of OpenStreetMap served by the deployed app. `data/shops.osm.json`
records its provenance and SHA-256; `build-shops.mjs` regenerates it.
