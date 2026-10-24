/**
 * Geodesy without dependencies.
 *
 * Distances use the haversine formula on a spherical Earth (mean radius
 * 6371.0088 km). That is accurate to ~0.5 % versus the WGS84 ellipsoid, which is
 * more than enough for profile distances: the profile itself is reconstructed
 * from a DEM with 10 m pixels.
 *
 * UTM zone 33 (EPSG:25833, ETRS89 / UTM 33N) is implemented with Karney's
 * 6th-order Krüger series (C. F. F. Karney, "Transverse Mercator with an
 * accuracy of a few nanometers", J. Geodesy 85, 2011). It is a direct port of
 * the series used by GeographicLib, with the GRS80 ellipsoid, k0 = 0.9996,
 * false easting 500 000 and central meridian 15°E. Within ±10° of the central
 * meridian the series is accurate to well below a millimetre, far beyond the
 * needs of this project.
 *
 * Scope: Norway only. Kartverket publishes the national DEM in one
 * EPSG:25833 grid, and the elevation service (hoydedata.no) expects
 * EPSG:25833 coordinates. Off-zone points (more than 12° from 15°E) and the
 * antimeridian are out of scope and throw instead of silently returning junk.
 */

/** WGS84/ETRS89 longitude/latitude in decimal degrees. */
export interface LonLat {
  lon: number;
  lat: number;
}

/** Projected coordinate in EPSG:25833 (metres). */
interface Utm33 {
  x: number;
  y: number;
}

/** Mean Earth radius (IUGG), metres. */
export const EARTH_RADIUS_M = 6_371_008.8;

// ---------------------------------------------------------------------------
// UTM zone 33 (EPSG:25833)
// ---------------------------------------------------------------------------

const GRS80_A = 6_378_137.0;
const GRS80_F = 1 / 298.257222101;
const UTM_K0 = 0.9996;
const UTM_FALSE_EASTING = 500_000.0;
const UTM_FALSE_NORTHING = 0.0;
/** Central meridian of UTM zone 33, degrees. */
export const ZONE33_CENTRAL_MERIDIAN_DEG = 15.0;
/**
 * Maximum longitude offset from the central meridian accepted by this module.
 * Norway spans roughly 3°E–31°E; 12° covers the mainland portion served by the
 * EPSG:25833 DEM (the far north-east is zone 35 territory and is out of scope).
 */
export const MAX_LONGITUDE_OFFSET_DEG = 12.0;
/**
 * The longitude window this module projects, and therefore the window the
 * elevation model covers: 3°E–27°E. `src/lib/route.ts` derives its supported
 * area from these two constants so the projection and the "is it covered?"
 * test cannot drift apart — a route inside the check but outside the
 * projection used to throw a central-meridian error from inside the DEM worker.
 */
export const UTM33_MIN_LON = ZONE33_CENTRAL_MERIDIAN_DEG - MAX_LONGITUDE_OFFSET_DEG;
export const UTM33_MAX_LON = ZONE33_CENTRAL_MERIDIAN_DEG + MAX_LONGITUDE_OFFSET_DEG;
/**
 * The mainland's latitude span, the other half of the area this app can plan in.
 * Svalbard (74°N and up) is inside the Norway extract Geofabrik publishes and
 * inside Kartverket's basemap, but outside the elevation model and every other
 * data source the planner uses — so it is not part of the app's area.
 */
export const SUPPORTED_MIN_LAT = 57;
export const SUPPORTED_MAX_LAT = 72.5;

/** Whether a position is inside the area the app can plan in at all. */
export function isInSupportedArea(point: { lon: number; lat: number }): boolean {
  return (
    point.lon >= UTM33_MIN_LON &&
    point.lon <= UTM33_MAX_LON &&
    point.lat >= SUPPORTED_MIN_LAT &&
    point.lat <= SUPPORTED_MAX_LAT
  );
}


/**
 * Whether this module can project the point at all. Latitude is the UTM domain;
 * longitude is the zone-33 window above. Anything else throws by design, so a
 * caller that wants a clean "not covered" answer must ask this first.
 */
export function isInUtm33Window(lonlat: LonLat): boolean {
  const { lon, lat } = lonlat;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  if (lat < -80 || lat > 84) return false;
  return lon >= UTM33_MIN_LON && lon <= UTM33_MAX_LON;
}

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

const E2 = GRS80_F * (2 - GRS80_F); // first eccentricity squared
const E = Math.sqrt(E2);
const E2M = 1 - E2; // 1 - e²
const N_RECT = GRS80_F / (2 - GRS80_F);
const A_RECT =
  (GRS80_A / (1 + N_RECT)) *
  (1 + N_RECT ** 2 / 4 + N_RECT ** 4 / 64 + N_RECT ** 6 / 256);

// Krüger series coefficients (order 6), from Karney (2011) / GeographicLib.
const N = N_RECT;
const ALPHA = [
  N / 2 - (2 * N ** 2) / 3 + (5 * N ** 3) / 16 + (41 * N ** 4) / 180 - (127 * N ** 5) / 288 + (7891 * N ** 6) / 37800,
  (13 * N ** 2) / 48 - (3 * N ** 3) / 5 + (557 * N ** 4) / 1440 + (281 * N ** 5) / 630 - (1983433 * N ** 6) / 1935360,
  (61 * N ** 3) / 240 - (103 * N ** 4) / 140 + (15061 * N ** 5) / 26880 + (167603 * N ** 6) / 181440,
  (49561 * N ** 4) / 161280 - (179 * N ** 5) / 168 + (6601661 * N ** 6) / 7257600,
  (34729 * N ** 5) / 80640 - (3418889 * N ** 6) / 1995840,
  (212378941 * N ** 6) / 319334400,
] as const;

const BETA = [
  N / 2 - (2 * N ** 2) / 3 + (37 * N ** 3) / 96 - N ** 4 / 360 - (81 * N ** 5) / 512 + (96199 * N ** 6) / 604800,
  N ** 2 / 48 + N ** 3 / 15 - (437 * N ** 4) / 1440 + (46 * N ** 5) / 105 - (1118711 * N ** 6) / 3870720,
  (17 * N ** 3) / 480 - (37 * N ** 4) / 840 - (209 * N ** 5) / 4480 + (5569 * N ** 6) / 90720,
  (4397 * N ** 4) / 161280 - (11 * N ** 5) / 504 - (830251 * N ** 6) / 7257600,
  (4583 * N ** 5) / 161280 - (108847 * N ** 6) / 3991680,
  (20648693 * N ** 6) / 638668800,
] as const;

function assertZone33(lon: number, lat: number): void {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new RangeError(`toUtm33/fromUtm33 require finite coordinates, got lon=${lon}, lat=${lat}`);
  }
  if (lat < -80 || lat > 84) {
    throw new RangeError(`Latitude ${lat} is outside the UTM domain (-80°..84°)`);
  }
  const offset = lon - ZONE33_CENTRAL_MERIDIAN_DEG;
  // The same comparison `isInUtm33Window` makes, so "the check said yes" and
  // "the projection accepted it" cannot disagree.
  if (lon < UTM33_MIN_LON || lon > UTM33_MAX_LON) {
    throw new RangeError(
      `Longitude ${lon} is ${offset.toFixed(2)}° from the zone-33 central meridian (15°E); ` +
        `only ±${MAX_LONGITUDE_OFFSET_DEG}° is supported (Norway / EPSG:25833). ` +
        `Off-zone and antimeridian points are out of scope.`,
    );
  }
}

/** Forward: WGS84 lon/lat (degrees) → EPSG:25833 x/y (metres). */
export function toUtm33(lonlat: LonLat): Utm33 {
  const { lon, lat } = lonlat;
  assertZone33(lon, lat);

  const phi = lat * DEG;
  const lam = (lon - ZONE33_CENTRAL_MERIDIAN_DEG) * DEG;
  const tau = Math.tan(phi);
  const sigma = Math.sinh(E * Math.atanh((E * tau) / Math.hypot(1, tau)));
  const tauPrime = Math.hypot(1, sigma) * tau - sigma * Math.hypot(1, tau);

  const xiPrime = Math.atan2(tauPrime, Math.cos(lam));
  const etaPrime = Math.asinh(Math.sin(lam) / Math.hypot(tauPrime, Math.cos(lam)));

  let xi = xiPrime;
  let eta = etaPrime;
  for (let j = 0; j < 6; j++) {
    const k = 2 * (j + 1);
    xi += ALPHA[j] * Math.sin(k * xiPrime) * Math.cosh(k * etaPrime);
    eta += ALPHA[j] * Math.cos(k * xiPrime) * Math.sinh(k * etaPrime);
  }

  return {
    x: UTM_FALSE_EASTING + UTM_K0 * A_RECT * eta,
    y: UTM_FALSE_NORTHING + UTM_K0 * A_RECT * xi,
  };
}

/** Inverse: EPSG:25833 x/y (metres) → WGS84 lon/lat (degrees). */
export function fromUtm33(utm: Utm33): LonLat {
  const { x, y } = utm;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new RangeError(`fromUtm33 requires finite coordinates, got x=${x}, y=${y}`);
  }

  const xi = (y - UTM_FALSE_NORTHING) / (UTM_K0 * A_RECT);
  const eta = (x - UTM_FALSE_EASTING) / (UTM_K0 * A_RECT);

  let xiPrime = xi;
  let etaPrime = eta;
  for (let j = 0; j < 6; j++) {
    const k = 2 * (j + 1);
    xiPrime -= BETA[j] * Math.sin(k * xi) * Math.cosh(k * eta);
    etaPrime -= BETA[j] * Math.cos(k * xi) * Math.sinh(k * eta);
  }

  const lon = ZONE33_CENTRAL_MERIDIAN_DEG + Math.atan2(Math.sinh(etaPrime), Math.cos(xiPrime)) * RAD;

  // Solve tau = tan(phi) from tau' by Newton iteration (Karney 2011, §5).
  const tauPrime = Math.sin(xiPrime) / Math.hypot(Math.sinh(etaPrime), Math.cos(xiPrime));
  let tau = tauPrime / E2M;
  for (let i = 0; i < 10; i++) {
    const tau1 = Math.hypot(1, tau);
    const sigma = Math.sinh(E * Math.atanh((E * tau) / tau1));
    const tauPrimeComputed = Math.hypot(1, sigma) * tau - sigma * tau1;
    const dtau =
      ((tauPrime - tauPrimeComputed) * (1 + E2M * tau * tau)) /
      (E2M * tau1 * Math.hypot(1, tauPrimeComputed));
    tau += dtau;
    if (!(Math.abs(dtau) >= 1e-14)) break;
  }
  const lat = Math.atan(tau) * RAD;

  assertZone33(lon, lat);
  return { lon, lat };
}

// ---------------------------------------------------------------------------
// Spherical distance helpers
// ---------------------------------------------------------------------------

/** Great-circle distance between two lon/lat points, metres. */
export function haversine(a: LonLat, b: LonLat): number {
  const phi1 = a.lat * DEG;
  const phi2 = b.lat * DEG;
  const dPhi = phi2 - phi1;
  const dLam = (b.lon - a.lon) * DEG;
  const s =
    Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) * Math.sin(dLam / 2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Cumulative distance along a polyline (metres). The returned array has one
 * value per input point and starts at 0.
 */
export function cumulativeDistances(coords: readonly LonLat[]): number[] {
  const out = new Array<number>(coords.length);
  if (coords.length === 0) return out;
  out[0] = 0;
  for (let i = 1; i < coords.length; i++) {
    out[i] = out[i - 1] + haversine(coords[i - 1], coords[i]);
  }
  return out;
}

/** Total polyline length in metres (0 for fewer than two points). */
export function pathLength(coords: readonly LonLat[]): number {
  if (coords.length < 2) return 0;
  return cumulativeDistances(coords)[coords.length - 1];
}

/**
 * Resample a polyline at (approximately) fixed spacing along the path.
 *
 * Sample 0 is the original start point and the final sample is the original end
 * point, so the returned polyline covers exactly the same arc length (subject
 * only to corner-cutting where the spacing is large compared with a bend).
 * Interpolation is linear in lon/lat, which is harmless at the spacings used
 * here (tens of metres).
 *
 * @param coords  input polyline, at least two points
 * @param spacingMetres desired sample spacing, > 0
 */
export function resample(coords: readonly LonLat[], spacingMetres: number): LonLat[] {
  if (!(spacingMetres > 0) || !Number.isFinite(spacingMetres)) {
    throw new RangeError(`resample spacing must be a positive finite number, got ${spacingMetres}`);
  }
  if (coords.length === 0) return [];
  if (coords.length === 1) return [{ ...coords[0] }];

  const cum = cumulativeDistances(coords);
  const total = cum[cum.length - 1];
  if (total === 0) return [{ ...coords[0] }];

  const out: LonLat[] = [{ ...coords[0] }];
  const count = Math.max(1, Math.ceil(total / spacingMetres));

  let seg = 1; // index of the segment end point
  for (let k = 1; k <= count; k++) {
    const target = Math.min(k * spacingMetres, total);
    while (seg < coords.length - 1 && cum[seg] < target) seg++;
    const segStart = cum[seg - 1];
    const segLen = cum[seg] - segStart;
    const t = segLen === 0 ? 0 : Math.min(1, Math.max(0, (target - segStart) / segLen));
    out.push({
      lon: coords[seg - 1].lon + (coords[seg].lon - coords[seg - 1].lon) * t,
      lat: coords[seg - 1].lat + (coords[seg].lat - coords[seg - 1].lat) * t,
    });
    // Do not emit a duplicate of the end point when `total` is an exact multiple.
    if (target >= total) break;
  }

  return out;
}
