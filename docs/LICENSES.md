# Licences and attribution

TruHiker ships three kinds of material: our own code, one data file, and the map
renderer. Everything else is fetched live from the service that owns it and is
never stored or re-served.

## What ships

| What | Licence | What we have to do |
| --- | --- | --- |
| Application code, translations, nutrition table | Proprietary, all rights reserved | — |
| **MapLibre GL JS** (`maplibre-*.js`, worker, CSS) | BSD-3-Clause, MapLibre contributors | Ship its copyright notice and licence with the distributed build |
| **Demo route** (`demo/memurubu-glitterheim-jot21.gpx`) | CC BY 4.0, ©Kartverket Turrutebasen | Credit Kartverket, link the licence, say what we changed |
| **Resupply extract** (`data/shops.osm.bin`) | ODbL 1.0, © OpenStreetMap contributors | Credit OpenStreetMap, offer the database under ODbL, include the licence text |

### Where a user sees it

- the map footer names **Kartverket** and **Mapterhorn**;
- **About data** lists every source with its licence and a link, including
  MapLibre;
- the resupply extract is downloadable, with the ODbL text served beside it at
  `/data/ODbL-1.0.txt`.

The files under `/licences/` are not a user-facing feature. They are the copies of
the notices that BSD-3 and ODbL require to travel with the distributed code and
data: a browser bundle is a distribution, and the notice has to be in it. The
build simply makes sure they are still there.

### The demo route

*Memurubu–Glitterheim* (`jot21`) comes from Kartverket Turrutebasen under CC BY
4.0, maintained by DNT Oslo og omegn. We converted the geometry from GML to GPX
and added no elevation — the profile is sampled live from Kartverket DTM. That is
the "indicate changes" part of the licence, stated here and in **About data**.

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
| **EOX Cloudless** — WMTS `s2cloudless-2017_3857` | aerial basemap (optional layer) | CC BY 4.0 | `Sentinel-2 cloudless 2017 © EOX IT Services GmbH (CC BY 4.0)`, linked in **About data** |
| **Mapterhorn** | 3D terrain tiles | derived from Kartverket and others; see its attribution file | `Mapterhorn` in the map footer |
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
