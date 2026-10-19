# Licences and attribution

Everything TruHiker ships, and everything it fetches, with the right to use it
and the attribution it requires. `scripts/licence-audit.mjs` fails the build if a
shipped file is not listed here or a required notice is missing.

Run `npm run verify` to enforce it.

---

## Shipped in the bundle

| Asset | Licence | Rights holder | Obligation |
| --- | --- | --- | --- |
| Application code, translations, nutrition table | Proprietary, all rights reserved | Sivert Asakskogen | — |
| `maplibre-*.js`, `maplibre-gl-worker-*.mjs`, `maplibre-*.css` | **BSD-3-Clause** | MapLibre contributors | reproduce the copyright notice and licence → `dist/licences/maplibre-gl-BSD-3-Clause.txt` |
| `demo/*.gpx` (Memurubu–Glitterheim, `jot21`) | **CC BY 4.0** | ©Kartverket (Turrutebasen) | credit, link the licence, **indicate changes** (we converted GML→GPX and added no elevation) |
| `data/shops.osm.bin`, `.meta.json` | **ODbL 1.0** | © OpenStreetMap contributors | attribution notice, share-alike on the derivative database (we publish the file itself), and a route to the licence text |
| `data/shops.osm.LICENSE` | ODbL notice | — | must travel with the data |
| `licences/*` | the notices themselves | — | must be present in `dist/` |

The ODbL file **is** the derivative database, and it is served publicly at
`/data/shops.osm.bin` — which satisfies the share-alike and access obligations.
It is never merged with non-ODbL data in one file.

## Fetched live (never redistributed)

| Source | Used for | Licence | Attribution |
| --- | --- | --- | --- |
| **Kartverket** — WMTS `topo` / `topograatone` | base map | CC BY 4.0 | `©Kartverket` linking to kartverket.no |
| **Geonorge WMS** `wms.topo` | base map fallback | CC BY 4.0 | `©Kartverket` |
| **Kartverket Turrutebasen** (WFS) | trail geometry, hut points | CC BY 4.0 (metadata says "no conditions"; the stricter reading is used) | `©Kartverket`, plus `oppdateringsdato` shown |
| **hoydedata.no** (Kartverket DTM ImageServer) | elevation profiles | CC BY 4.0 | `©Kartverket`, source shown with the profile |
| **Mapterhorn** | 3D terrain tiles | derived from Kartverket and others; see `download.mapterhorn.com/attribution.json` | `Mapterhorn` in the map footer |
| **MET Norway** (Locationforecast 2.0) | weather | NLOD / CC BY 4.0 | `MET Norway`, issue time shown |

Live use is permitted by all of these; **copying is not**, so nothing above is
stored in the bundle or re-served by us.

## Deliberately not used

| Source | Why |
| --- | --- |
| **UT.no / DNT turforslag** | `robots.txt` disallows `/*/gpx/`; terms restrict content to personal use; only licence is CC BY-NC granted to users of their service. UT.no is a *consumer* of Turrutebasen, which we use directly instead. |
| **Nasjonal Turbase** | decommissioned; the terms document returns 410 Gone |
| **Wikiloc, AllTrails, Outdooractive** | no licence to extract; database rights asserted |
| **FKB, Matrikkel** | not open; commercial access required |
| **Kartverket tile cache at z12–20** | copying requires permission from the Geovekst rights holders; live use only |

A user may import a GPX they obtained from any of those sources. TruHiker treats
it as **their file**: it is stored in their browser and never republished, added
to a shared corpus, or re-served.

## What the audit checks

`scripts/licence-audit.mjs`:

1. every file in `dist/` matches a licence rule (an unknown asset fails the build);
2. `licences/maplibre-gl-BSD-3-Clause.txt`, `licences/ODbL-1.0.txt`,
   `licences/shops.osm.ODbL-notice.txt` and `licences/TRUHIKER.txt` are present;
3. the built app still contains the Kartverket attribution;
4. if the ODbL data ships, the app also carries the OpenStreetMap attribution.

All four pass. `npm run verify` runs the audit as a gate, so a future asset added
without a licence entry — or ODbL data shipped without its attribution — fails the
build rather than reaching a user.

Current status of the shipped build: **19 files accounted for** — proprietary 8,
ODbL 1.0 3, CC BY 4.0 1, licence texts 4, BSD-3-Clause 3; 4 notices present;
attribution visible in the app.
