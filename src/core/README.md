# `src/core` — the elevation number engine

Pure functions that turn a route into an authoritative elevation profile. Every
other feature (Naismith time, calorie burn, terrain class, the map) derives from
these numbers, so correctness wins over speed everywhere.

## Pipeline

```
GPX file
  │  gpx.ts         parse <trk>/<rte>, keep tracks separate
  ▼
coordinate list
  │  geo.ts         haversine distances, resample at fixed spacing
  ▼
lon/lat samples ──► toUtm33() ──► EPSG:25833 x/y
                                      │  dem.ts   group into 5 km cells,
                                      │           one request per cell (≤6 concurrent),
                                      │           cache, bilinear sample
                                      ▼
                              elevation per sample (NaN = NoData)
                                      │  profile.ts  fill gaps → 3-point median
                                      │              → hysteresis gain/loss
                                      │              → 100 m-window grade
                                      ▼
                    { samples[{d, ele}], ascentM, descentM,
                      maxGradePct, minGradePct }
```

| Module | Responsibility |
| --- | --- |
| `tiff.ts` | Minimal tiled float32 GeoTIFF reader (no GDAL, no `geotiff` dependency) |
| `dem.ts` | hoydedata.no ImageServer client, window grouping/caching/concurrency, bilinear sampling, `ElevationSource` interface |
| `geo.ts` | Haversine, cumulative distance, resampling, EPSG:25833 ↔ WGS84 (Karney/Krüger series, no proj4) |
| `profile.ts` | Median filter, hysteresis gain/loss, windowed grade |
| `gpx.ts` | Namespace-tolerant GPX coordinate extraction, tracks kept separate |

The `ElevationSource` interface (`dem.ts`) is the seam the browser will use to
swap in a different provider, and the seam tests use to inject synthetic DEMs.

## The two traps

### 1. Responses are tiled at 128×128

A 500×500 request is **16 tiles**. If you read only `TileOffsets[0]`, or you
assume `TileOffsets` is always a list stored at an offset, three quarters of the
raster is uninitialised memory and the profile is nonsense. This is not
hypothetical: the original spike read min 0 m, max 2185 m and 10,551 m of ascent
on a 7.8 km leg.

`tiff.ts` assembles the full tile grid in row-major tile order. Note also that
TIFF stores a scalar (count = 1) **inline** in the IFD entry, while an array
(count > 1) is stored at the offset in the entry. Both cases must work, and the
real service sends a single-tile 128×128 raster inline and a 500×500 raster as
an array — so a fixture of each shape is covered by tests.

### 2. Ascent/descent needs hysteresis, not summation

Summing every positive elevation difference turns DEM noise and micro-relief
into thousands of false metres. The profile uses a **hysteresis state machine**
(default threshold 5 m): only a swing of at least 5 m away from the last
confirmed turning point confirms a change of direction. Small oscillations
contribute nothing; when a real swing happens, the whole swing from the last
turning point is counted, so genuine climbing is not eroded. It is a state
machine over the series, not a filter applied afterwards.

A 3-point median filter runs before it (kills single-pixel spikes) and grade is
computed over a ~100 m window (kills ±100 % single-sample spikes).

## Failure behaviour

- Network calls have a timeout (30 s default), retry 429/5xx/timeouts with
  exponential backoff, and **throw** on failure. A failed fetch never becomes
  0 m, which would silently produce a flat profile.
- NoData (`GDAL_NODATA`, typically `-32767`, and empty tiles) is returned as
  `NaN`; gaps are linearly interpolated and reported as `filledSamples`. If
  every point is NoData, `buildProfile` throws.
- The DEM reader rejects mismatched raster sizes, unsupported compression and
  truncated tiles instead of guessing.

## Scope

- Norway / EPSG:25833 only. Off-zone points (>12° from 15°E), the antimeridian
  and southern-hemisphere UTM throw instead of returning junk.
- The reader expects classic TIFF, single band, 32-bit IEEE float, uncompressed
  (tiled or stripped). The hoydedata.no service serves exactly this.
- Elevation is Kartverket **DTM** (bare earth), never DOM or a global 30 m DEM.
  Attribution: ©Kartverket (CC BY 4.0).

## Tests

`npm test` runs everything, including live hoydedata.no requests. To run offline
(the fixture and synthetic-TIFF tests still run):

```sh
SKIP_NETWORK=1 npm test
```

The live anchor is the Galdhøpiggen summit: a 5 km / 500 px window (16 tiles)
must have a local maximum of 2467.8 m, within 2469 ± 5 m. Note that bilinear
sampling at the nominal WGS84 summit coordinate reads ~2460 m because the DEM's
local maximum sits ~20 m north of that coordinate; the anchor therefore uses the
window maximum, which is what exercises tile assembly.
