# tools

Build and verification tooling. None of this ships to the browser.

| Path | Purpose |
| --- | --- |
| `fetch-data.mjs` | downloads the resupply extract (release asset) and verifies its SHA-256 |
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

The resupply data is **not** in the repository. It is a Derivative Database of
OpenStreetMap, published as a release asset and served by the deployed app; see
`data/MANIFEST.json` and `docs/LICENSES.md`.
