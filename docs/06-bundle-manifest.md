# Bundle manifest — the irreducible minimum, and its licences

*Rule: every bundled byte must be (a) impossible to fetch live at acceptable
quality/speed, and (b) licensed for redistribution. Everything else is fetched
from the source by the user's browser.*

---

## 1. What is bundled

| Asset | Bytes (target) | Licence | Compliance action |
| --- | --- | --- | --- |
| App code (HTML/JS/CSS) | ~400–450 KB gzip | ours (MIT) | none |
| **Resupply index** (OSM-derived) | **~60–100 KB brotli** | **ODbL 1.0** | see §4 — attribution, share-alike, offer the file |
| **DNT hut classification** | ~15–30 KB | ours (curated facts) + cite DNT | see §5 — conservative option available |
| Nutrition table | ~5 KB | facts | none |
| Translations NO/EN | ~10 KB | ours | none |

Nothing else. No basemap, no terrain, no elevations, no trail geometry.

## 2. What is *not* bundled, and why

| Data | Live source | Why not bundled |
| --- | --- | --- |
| Basemap | Kartverket WMTS | terms permit live use; copying z12–20 needs permission |
| 3D terrain | Mapterhorn | live, free, CORS |
| Elevation | hoydedata ImageServer | live, 240 ms/window |
| **Trail geometry** | **Turrutebasen WFS** | live, 176–669 ms; CC BY — no share-alike, but no need |
| **DNT hut positions** | **Turrutebasen `RuteInfoPunkt`** | live, verified: name (`opphav`), maintainer, facility code |
| Weather / avalanche / flood | MET Norway / NVE | live (later phase) |

The discovery that removed the biggest bundle: **hut positions are not a bundle
item at all.** Turrutebasen already carries them live.

## 3. The resupply index — why it must be bundled, and how small it can be

Measured POI counts in Norway (taginfo, 2026-10-18):

| Tag | Count | Keep? |
| --- | ---: | --- |
| `shop=supermarket` | 4,042 | yes |
| `shop=convenience` | 577 | yes |
| `shop=general` | 289 | yes |
| `shop=grocery` | 24 | yes |
| `amenity=fuel` | 2,379 | yes (Sunday-open, ≥1,500 kcal of junk) |
| `amenity=post_office` | 1,257 | yes (mail-drop model) |
| `amenity=parcel_locker` | 250 | yes |
| `tourism=alpine_hut` / `wilderness_hut` / `amenity=shelter` | 217 / 774 / 5,555 | **no** — huts come live; shelters are not resupply |
| **Total kept** | **8,818** | |

Encoding budget: delta-int32 lon/lat (8 B) + type byte + flag byte = **10 B/point**,
plus a name string table (chain names collapsed to a code; only independents carry
text). Estimate **~60–100 KB brotli**. *This is an estimate until the extractor
runs; it will be measured and recorded here.*

### The live alternative, and why it loses

There **is** a live path — and it is worth stating precisely, because "no live
source" is not quite true:

1. **Enhetsregisteret** (`data.brreg.no`) — CORS **is** enabled
   (`access-control-allow-origin: *`, verified), NACE `47.110`, ~4–6 k units.
   But: **no coordinates, no opening hours, no brand field**, and the register
   includes head offices, closed units and wholesale-adjacent entities.
2. Then geocode every address against **Kartverket Adresse API** (CORS `*`,
   verified) — one request per shop.

So a live shop layer costs **one extra geocoding request per shop** (hundreds per
corridor), while returning *worse* data than a 60–100 KB file. Bundling wins on
every axis. The genuinely-unavailable bits (hours, brand, exact position) are what
make the OSM file worth its bytes.

## 4. ODbL obligations for the resupply index

ODbL **does permit redistribution** — that is its purpose. The obligations are
specific:

| ODbL clause | What it requires of us |
| --- | --- |
| **§4.3** (notice) | Where the data is publicly used, state that the content is from OpenStreetMap and available under ODbL, with a link to both. |
| **§4.4** (share alike) | Any **derivative database** we publicly use must itself be offered under ODbL. Our `shops.bin` **is** that derivative database, so it is published under ODbL. |
| **§4.6** (access) | We must make the derivative database available — we do: the file is served publicly. |
| Notices | Keep `© OpenStreetMap contributors` and the licence link. |

**What does *not* become ODbL:** our application code, our UI, and our own curated
data — provided they are not part of the derivative database.

> **Hard engineering rule: never merge ODbL data and non-ODbL data into one file.**

```
/data/shops/osm-pois.bin     ODbL 1.0   ← derived from OSM
/data/shops/osm-pois.LICENSE ODbL text + attribution
/data/huts/dnt-class.json    ours       ← never contains OSM-derived rows
/data/nutrition.json         ours
```

Consequence to accept knowingly: anyone may reuse `osm-pois.bin` under ODbL. That
is the price of the licence, and it costs us nothing.

Displayed map output is a **Produced Work** — the §4.3 notice suffices; share-alike
does not reach the app.

## 5. DNT hut classification — the one item with real legal ambiguity

DNT's `betjent / selvbetjent / ubetjent` status is **not in OSM**
(`dnt=*` counts: 0 / 0 / 0) and is not machine-readable anywhere. It exists only
as prose on cabin pages.

Two options:

| | A. Curate a table | B. Don't bundle; link out |
| --- | --- | --- |
| Bundle | ~500 rows, ~15–30 KB | 0 |
| Legal risk | Low but non-zero: bulk copying a list from one site can attract the **sui generis database right** (åndsverkloven §24) even where individual facts are not protected | None |
| Product cost | Resupply knows that a hut sells food | Unknown huts default to **"assume no food"** — conservative and safe |

**Recommendation: a hybrid, and it is strictly better than either.**
- Curate only the huts that matter (those within ~5 km of a route corridor), from
  DNT's public pages, storing **facts only** — no prose, no photos, no descriptions.
- Show a per-hut **"verified <date> — check DNT before you go"** badge, and link to
  the cabin page. Attribution is a link, not a copy.
- Treat every unknown hut as **no food**. The planner must never assume supplies
  exist because a lookup was missing.
- If even that feels like too much extraction: ship option B, and the planner
  simply tells you to carry food for any hut without a confirmed larder.

## 6. Attribution strings (exact)

- **ODbL / OSM:** `© OpenStreetMap contributors` + link to
  `openstreetmap.org/copyright` and the ODbL text.
- **Kartverket (basemap, elevation, Turrutebasen):** `©Kartverket` + link to
  kartverket.no (CC BY 4.0). If we modify (we simplify/filter), state that changes
  were made — CC BY 4.0 requires indicating changes.
- **Mapterhorn:** attribution per `download.mapterhorn.com/attribution.json`
  (Kartverket-derived).
- **MET Norway / NVE** (later phase): NLOD strings, verbatim.

## 7. Open decisions for you

1. **Accept the ODbL file?** It is 60–100 KB and makes the resupply feature real.
   Alternative is no shop data at all.
2. **Hut classification:** curated subset (recommended) or link-out only?
3. **App licence:** MIT, or all rights reserved? The *code* is unaffected either
   way; only the ODbL data file carries an obligation.

*This is engineering diligence, not legal advice. If the app ever becomes more
than a personal/hobby project, have the ODbL and database-right questions reviewed
by someone qualified.*
