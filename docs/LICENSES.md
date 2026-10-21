# Licences and attribution

TruHiker ships three kinds of material: our own code, one data file, and the map
renderer. Everything else is fetched live from the service that owns it and is
never stored or re-served.

## What ships

| What | Licence | What we have to do |
| --- | --- | --- |
| Application code, translations, nutrition table | Proprietary, © Sivert Asakskogen, all rights reserved | — |
| **MapLibre GL JS** (`maplibre-*.js`, worker, CSS) | BSD-3-Clause, MapLibre contributors | Ship its copyright notice and licence with the distributed build |
| **Resupply extract** (`data/shops.osm.bin`, generated at build time — D24) | ODbL 1.0, © OpenStreetMap contributors | Credit OpenStreetMap, offer the database under ODbL, include the licence text (`licences/ODbL-1.0.txt`, served at `/data/ODbL-1.0.txt`) |

### Where a user sees it

- the map footer names **©Kartverket** and **© Mapterhorn**;
- **About data** lists every source with its licence and a link, including
  MapLibre;
- the resupply extract is downloadable, with the ODbL text served beside it at
  `/data/ODbL-1.0.txt`.

`licences/` in the repository holds **one** file, the ODbL text. The other three
notices are produced at build time into `dist/licences/` by
`tools/verify/copy-licences.mjs`: MapLibre's BSD-3 notice is copied from
`node_modules`, and the ODbL notice for the data and the app notice are generated
from the shipped provenance, so a notice cannot drift from the file it describes.

The files under `/licences/` are not a user-facing feature. They are the copies of
the notices that BSD-3 and ODbL require to travel with the distributed code and
data: a browser bundle is a distribution, and the notice has to be in it. The
build simply makes sure they are still there.

### Test material (in the repository, never shipped)

| File | Licence | Obligation |
| --- | --- | --- |
| `test/fixtures/memurubu-glitterheim-jot21.gpx` | CC BY 4.0, ©Kartverket Turrutebasen | credit Kartverket; it is imported by the gates, never served (D26) |
| `test/fixtures/huts-wfs.xml` | CC BY 4.0, ©Kartverket Turrutebasen | a captured WFS response used as a test double |
| `test/fixtures/galdhopiggen-128.tif` | CC BY 4.0, ©Kartverket | a captured DTM window used by the elevation acceptance test |
| `test/fixtures/{galdhopiggen,gjendesheim-besseggen}.gpx` | our own test data | — |

### The route fixture

*Memurubu–Glitterheim* (`jot21`) was the bundled demo route; the app ships no
sample any more (D26), so the GPX lives in `test/fixtures/` and is imported by the
e2e and render gates instead. It still comes from Kartverket Turrutebasen under
CC BY 4.0, maintained by DNT Oslo og omegn: we converted the geometry from GML to
GPX and added no elevation — the profile is sampled live from Kartverket DTM. That
is the "indicate changes" part of the licence. It is test material: not served,
not part of `dist/`.

### The resupply extract

`data/shops.osm.bin` **is** a derivative database of OpenStreetMap, and it is
served publicly by the app. That public copy is what satisfies ODbL's
share-alike and access terms. Its provenance — source, extract date, point count,
SHA-256 — is in `data/shops.osm.json`; `tools/build-shops.mjs` regenerates it. It
is never merged with non-ODbL data in one file.

## Fetched live, never redistributed

| Source | Used for | Licence | Attribution |
| --- | --- | --- | --- |
| **Kartverket** — WMTS `topo` / `topograatone` | base map | CC BY 4.0 | `©Kartverket` linking to kartverket.no |
| **Geonorge WMS** `wms.topo` | base map fallback | CC BY 4.0 | `©Kartverket` |
| **Kartverket Turrutebasen** (WFS) | trail geometry, hut points | CC BY 4.0 (metadata says "no conditions"; we take the stricter reading) | `©Kartverket` |
| **hoydedata.no** (Kartverket DTM ImageServer) | elevation profiles | CC BY 4.0 | `©Kartverket`, source shown with the profile |
| **Kartverket** — WMS `wms.sentinel2` (Sentinel-2 cloud-free mosaic, 2025) | aerial basemap (optional layer) | Open data ("no conditions apply"); credit required | `Copernicus Sentinel-2 (2025) / Kartverket` in the map footer and **About data** |
| **Mapterhorn** | 3D terrain tiles | © Mapterhorn — attribution required, linked to `mapterhorn.com/attribution`; tiles are derived from open data including Kartverket (CC BY 4.0) | `© Mapterhorn`, linked to its attribution page, in the map footer |
| **MET Norway** (Locationforecast 2.0) | weather | NLOD / CC BY 4.0 | `MET Norway`, issue time shown |

Live use is permitted by all of these; copying is not, so nothing above is stored
in the bundle or re-served by us.

## Deliberately not used

| Source | Why |
| --- | --- |
| **Nasjonal Turbase** | decommissioned; the terms document returns 410 Gone |
| **FKB, Matrikkel** | not open; commercial access required |
| **Esri World Imagery** | proprietary; its terms require an ArcGIS subscription for use in non-Esri software, so it cannot join this app |
| **Norge i bilder / FKB orthophoto** | Norge digitalt-gated (499/500/auth exception measured); per-municipality files, never a tile service |
| **Kartverket tile cache at z12–20** | copying requires permission from the Geovekst rights holders; live use only |

A user may import a GPX from any other service. TruHiker treats it as **their
file**: it is stored in their browser and never republished, added to a shared
corpus, or re-served.

## What the build checks

`tools/verify/licence-audit.mjs` fails only when something required is actually
missing: the MapLibre, ODbL and app notices, or the Kartverket/OpenStreetMap
attribution in the built app. A file in `dist/` that matches no known licence is
reported as a warning rather than stopping the build — it is a question for a
maintainer, not a broken product.

`npm audit --omit=dev` is the other half: no known vulnerabilities in what ships.
