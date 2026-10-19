/**
 * Serialisation: GPX 1.1 and GeoJSON out, GPX/GeoJSON in.
 *
 * Two rules shape this file.
 *
 * 1. **Unknown is not zero.** A point without elevation gets no `<ele>` and no
 *    third GeoJSON ordinate. Writing `0` for a missing measurement would put a
 *    sea-level value on a mountain.
 * 2. **The download is the backup.** `fromFile(toGpx(trip))` must return the
 *    same geometry: distance within a metre and the elevation array exactly.
 *    That is why coordinates are written with 7 decimals (~1 cm) and elevation
 *    with 1 decimal (10 cm, the precision of every source we have).
 *
 * The incoming GPX is read with `src/core/gpx.ts`; the tiny metadata reader
 * below only recovers `<metadata><name>` and the `<extensions>` bits this file
 * writes itself.
 */

import { DOMParser, type Document, type Element } from '@xmldom/xmldom';

import { StoreError } from '../contracts';
import type {
  ElevationSource,
  Leg,
  Provenance,
  ProvenanceKind,
  RoutePoint,
  Trip,
} from '../contracts';
import { pathLength } from '../core/geo';
import { parseGpx, type GpxDocument, type GpxPoint, type GpxTrack } from '../core/gpx';
import { CURRENT_SCHEMA_VERSION, defaultProfile, newId } from './trip';

/** Decimal places for coordinates. 7 dp ≈ 1.1 cm; the metre guarantee needs it. */
export const COORD_DECIMALS = 7;
/** Decimal places for elevation. 1 dp = 10 cm. */
export const ELE_DECIMALS = 1;

/** Namespace for our own `<extensions>` elements. */
const NPL_NS = 'urn:npl-map:gpx:1';

export interface GpxOptions {
  legIds?: readonly string[];
  includeElevation?: boolean;
}

/* ------------------------------------------------------------------ */
/* Escaping and formatting                                             */
/* ------------------------------------------------------------------ */

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** Escape text and attribute values. Apostrophes included: we quote with `"`. */
export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => XML_ESCAPES[character] ?? character);
}

/** Fixed-point with no `-0` and no exponent notation. */
function fixed(value: number, decimals: number): string {
  const rounded = Number(value.toFixed(decimals));
  return (rounded === 0 ? 0 : rounded).toFixed(decimals);
}

function hasElevation(point: RoutePoint): point is RoutePoint & { ele: number } {
  return typeof point.ele === 'number' && Number.isFinite(point.ele);
}

/* ------------------------------------------------------------------ */
/* Derived values                                                      */
/* ------------------------------------------------------------------ */

/** Cumulative ascent/descent over consecutive pairs where *both* ends are known. */
function ascentDescent(points: readonly RoutePoint[]): { ascentM: number | null; descentM: number | null } {
  let known = 0;
  let ascent = 0;
  let descent = 0;
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    if (!previous || !current) continue;
    if (!hasElevation(previous) || !hasElevation(current)) continue;
    const delta = current.ele - previous.ele;
    known += 1;
    if (delta > 0) ascent += delta;
    else descent -= delta;
  }
  if (known === 0) return { ascentM: null, descentM: null };
  return { ascentM: ascent, descentM: descent };
}

/** Build a leg from points, computing distance and ascent/descent. */
export function buildLeg(
  points: readonly RoutePoint[],
  options: { name?: string; provenance: readonly Provenance[]; id?: string },
): Leg {
  const distanceM = points.length >= 2 ? pathLength(points) : null;
  const { ascentM, descentM } = ascentDescent(points);
  return {
    id: options.id ?? newId('leg'),
    ...(options.name !== undefined ? { name: options.name } : {}),
    points: points.map((point) => ({ ...point })),
    provenance: options.provenance.map((entry) => ({ ...entry })),
    distanceM,
    ascentM,
    descentM,
  };
}

const ELE_SOURCE_LABEL: Record<ElevationSource, string> = {
  dem: 'Kartverket DTM, bare earth (hoydedata.no)',
  gpx: 'elevations from the uploaded GPX file, kept as-is',
  none: 'unknown — never rendered as 0',
};

function sourcesOf(points: readonly RoutePoint[]): ElevationSource[] {
  const seen = new Set<ElevationSource>();
  for (const point of points) {
    if (!hasElevation(point)) continue;
    seen.add(point.eleSource ?? 'gpx');
  }
  return [...seen].sort();
}

function describeSources(sources: readonly ElevationSource[]): string {
  if (sources.length === 0) return `none (${ELE_SOURCE_LABEL.none})`;
  return sources.map((source) => `${source} (${ELE_SOURCE_LABEL[source]})`).join('; ');
}

/** The single elevation source of a leg, when they all agree; otherwise null. */
function uniformSource(points: readonly RoutePoint[]): ElevationSource | null {
  const sources = sourcesOf(points);
  return sources.length === 1 ? sources[0]! : null;
}

interface Attribution {
  owners: string[];
  licences: string[];
}

/** Kartverket / Turrutebasen attribution, only when a provenance entry says so. */
function attributionOf(legs: readonly Leg[]): Attribution {
  const owners = new Set<string>();
  const licences = new Set<string>();
  for (const leg of legs) {
    for (const entry of leg.provenance) {
      const text = [entry.kind, entry.label, entry.url, entry.licence]
        .filter((part): part is string => typeof part === 'string')
        .join(' ')
        .toLowerCase();
      if (text.includes('kartverket')) owners.add('Kartverket');
      if (text.includes('turrutebasen')) owners.add('Turrutebasen');
      if (entry.licence) licences.add(entry.licence);
    }
  }
  return { owners: [...owners], licences: [...licences] };
}

function provenanceText(provenance: readonly Provenance[]): string {
  if (provenance.length === 0) return 'none recorded';
  return provenance
    .map((entry) => {
      const parts = [`kind=${entry.kind}`];
      if (entry.label) parts.push(`label="${entry.label}"`);
      if (entry.url) parts.push(`url=${entry.url}`);
      if (entry.licence) parts.push(`licence=${entry.licence}`);
      if (entry.fetchedAt) parts.push(`fetchedAt=${entry.fetchedAt}`);
      if (entry.modified) parts.push('modified=true');
      return parts.join(' ');
    })
    .join(' | ');
}

/* ------------------------------------------------------------------ */
/* GPX export                                                          */
/* ------------------------------------------------------------------ */

/**
 * Serialise a trip as GPX 1.1, one `<trk>` per leg.
 *
 * `<metadata>` carries the trip name, a description with provenance per leg, the
 * elevation source, the schema version and — when the provenance mentions them —
 * the ©Kartverket / Turrutebasen attribution.
 *
 * The output is always well-formed: every element is closed explicitly, nothing
 * is self-closing, and all text and attribute values are escaped.
 */
export function toGpx(trip: Trip, options: GpxOptions = {}): string {
  const includeElevation = options.includeElevation ?? true;
  const wanted = options.legIds ? new Set(options.legIds) : null;
  const legs = wanted ? trip.legs.filter((leg) => wanted.has(leg.id)) : trip.legs;

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<gpx version="1.1" creator="npl-map" xmlns="http://www.topografix.com/GPX/1/1" ` +
      `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
      `xmlns:npl="${NPL_NS}" ` +
      `xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">`,
  );

  // ---- metadata ----
  const allSources = legs.flatMap((leg) => sourcesOf(leg.points));
  const attribution = attributionOf(legs);
  const desc: string[] = [];
  desc.push(`Saved by npl-map. schemaVersion ${trip.schemaVersion ?? CURRENT_SCHEMA_VERSION}. Trip id ${trip.id}.`);
  desc.push(`Elevation: ${describeSources([...new Set(allSources)].sort())}.`);
  if (attribution.owners.length > 0) {
    desc.push(
      `Attribution: ©${attribution.owners.join(' / ')}` +
        (attribution.licences.length > 0 ? ` — ${attribution.licences.join('; ')}` : '') +
        '. Modified: geometry and elevation were processed by npl-map.',
    );
  }
  legs.forEach((leg, index) => {
    const distance =
      leg.distanceM === null || leg.distanceM === undefined ? 'unknown' : `${Math.round(leg.distanceM)} m`;
    desc.push(
      `Leg ${index + 1}${leg.name ? ` "${leg.name}"` : ''} (${leg.id}): provenance ${provenanceText(
        leg.provenance,
      )}; elevation ${describeSources(sourcesOf(leg.points))}; distance ${distance}.`,
    );
  });

  lines.push('  <metadata>');
  lines.push(`    <name>${escapeXml(trip.name)}</name>`);
  lines.push(`    <desc>${escapeXml(desc.join('\n'))}</desc>`);
  if (attribution.owners.length > 0) {
    lines.push(`    <copyright author="${escapeXml(attribution.owners.join(' / '))}">`);
    lines.push(
      `      <license>${escapeXml(
        attribution.licences.length > 0 ? attribution.licences.join('; ') : `©${attribution.owners.join(' / ')}`,
      )}</license>`,
    );
    lines.push('    </copyright>');
  }
  lines.push(`    <time>${escapeXml(trip.updatedAt)}</time>`);
  lines.push('  </metadata>');

  // ---- tracks ----
  for (const [index, leg] of legs.entries()) {
    lines.push('  <trk>');
    lines.push(`    <name>${escapeXml(leg.name ?? `Leg ${index + 1}`)}</name>`);
    lines.push(`    <desc>${escapeXml(provenanceText(leg.provenance))}</desc>`);
    // <extensions> keeps the leg id — and the elevation source when the whole leg
    // agrees — so a re-import does not relabel DTM heights as "from the upload".
    const source = uniformSource(leg.points);
    lines.push('    <extensions>');
    if (source !== null) lines.push(`      <npl:eleSource>${escapeXml(source)}</npl:eleSource>`);
    lines.push(`      <npl:legId>${escapeXml(leg.id)}</npl:legId>`);
    lines.push('    </extensions>');

    lines.push('    <trkseg>');
    for (const point of leg.points) {
      const position = `lat="${fixed(point.lat, COORD_DECIMALS)}" lon="${fixed(point.lon, COORD_DECIMALS)}"`;
      lines.push(`      <trkpt ${position}>`);
      // Only a known elevation is written. An unknown one is omitted, never 0.
      if (includeElevation && hasElevation(point)) {
        lines.push(`        <ele>${fixed(point.ele, ELE_DECIMALS)}</ele>`);
      }
      lines.push('      </trkpt>');
    }
    lines.push('    </trkseg>');
    lines.push('  </trk>');
  }

  lines.push('</gpx>');
  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* GeoJSON export                                                      */
/* ------------------------------------------------------------------ */

/**
 * FeatureCollection with one LineString per leg.
 *
 * Coordinates are `[lon, lat]`, or `[lon, lat, ele]` for the points where an
 * elevation is actually known — never a 0-filled third ordinate.
 */
export function toGeoJson(trip: Trip): string {
  const features = trip.legs.map((leg, index) => ({
    type: 'Feature' as const,
    geometry: {
      type: 'LineString' as const,
      coordinates: leg.points.map((point) => {
        const lon = Number(fixed(point.lon, COORD_DECIMALS));
        const lat = Number(fixed(point.lat, COORD_DECIMALS));
        // A third ordinate only where an elevation exists — never 0-filled.
        return hasElevation(point) ? [lon, lat, Number(fixed(point.ele, ELE_DECIMALS))] : [lon, lat];
      }),
    },
    properties: {
      legId: leg.id,
      name: leg.name ?? `Leg ${index + 1}`,
      index,
      distanceM: leg.distanceM,
      ascentM: leg.ascentM,
      descentM: leg.descentM,
      elevationSources: sourcesOf(leg.points),
      provenance: leg.provenance,
    },
  }));

  return `${JSON.stringify(
    {
      type: 'FeatureCollection',
      generator: 'npl-map',
      schemaVersion: trip.schemaVersion ?? CURRENT_SCHEMA_VERSION,
      name: trip.name,
      features,
    },
    null,
    2,
  )}\n`;
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

const PROVENANCE_KINDS: readonly ProvenanceKind[] = [
  'gpx-upload',
  'turrutebasen',
  'drawn',
  'snapped',
  'demo',
  'edited',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function baseName(filename: string): string {
  const name = filename.replace(/^.*[\\/]/, '');
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function extensionOf(filename: string): string {
  const name = filename.replace(/^.*[\\/]/, '');
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Convert a raw coordinate pair into a validated point, or throw `corrupt`. */
function pointFromCoordinates(raw: unknown, where: string): RoutePoint {
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new StoreError('corrupt', `${where}: coordinate is not a [lon, lat] pair`);
  }
  const lon = raw[0];
  const lat = raw[1];
  if (typeof lon !== 'number' || !Number.isFinite(lon) || Math.abs(lon) > 180) {
    throw new StoreError('corrupt', `${where}: invalid longitude ${String(lon)}`);
  }
  if (typeof lat !== 'number' || !Number.isFinite(lat) || Math.abs(lat) > 90) {
    throw new StoreError('corrupt', `${where}: invalid latitude ${String(lat)}`);
  }
  const ele = raw.length > 2 ? raw[2] : undefined;
  if (typeof ele === 'number' && Number.isFinite(ele)) {
    return { lon, lat, ele, eleSource: 'gpx' };
  }
  return { lon, lat, eleSource: 'none' };
}

function parseProvenance(raw: unknown): Provenance[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Provenance[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.kind !== 'string') return null;
    if (!PROVENANCE_KINDS.includes(entry.kind as ProvenanceKind)) continue;
    const provenance: Record<string, unknown> = { kind: entry.kind };
    if (typeof entry.label === 'string') provenance.label = entry.label;
    if (typeof entry.url === 'string') provenance.url = entry.url;
    if (typeof entry.fetchedAt === 'string') provenance.fetchedAt = entry.fetchedAt;
    if (typeof entry.licence === 'string') provenance.licence = entry.licence;
    if (typeof entry.modified === 'boolean') provenance.modified = entry.modified;
    out.push(provenance as unknown as Provenance);
  }
  return out.length > 0 ? out : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function finishTrip(name: string, legs: readonly Leg[]): Trip {
  const now = nowIso();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: newId(),
    name,
    createdAt: now,
    updatedAt: now,
    legs: [...legs],
    profile: defaultProfile(),
  };
}

/* ---- GPX in ------------------------------------------------------- */

function localNameOf(node: Element): string {
  return (node.localName || node.nodeName.replace(/^.*:/, '')).toLowerCase();
}

function descendant(element: Element | null, name: string): Element | null {
  if (!element) return null;
  const wanted = name.toLowerCase();
  for (const child of element.children) {
    if (localNameOf(child) === wanted) return child;
    const found = descendant(child, name);
    if (found) return found;
  }
  return null;
}

function directChild(element: Element | null, name: string): Element | null {
  if (!element) return null;
  const wanted = name.toLowerCase();
  for (const child of element.children) {
    if (localNameOf(child) === wanted) return child;
  }
  return null;
}

function textOf(element: Element | null): string | undefined {
  const text = element?.textContent?.trim();
  return text ? text : undefined;
}

interface GpxMeta {
  name?: string;
  desc?: string;
  eleSource?: ElevationSource;
  legId?: string;
}

function readElementAttributes(xml: string): Document | null {
  try {
    const documentNode = new DOMParser().parseFromString(xml, 'application/xml');
    return documentNode?.documentElement ? documentNode : null;
  } catch {
    return null;
  }
}

function parseEleSource(raw: string | undefined): ElevationSource | undefined {
  return raw === 'dem' || raw === 'gpx' || raw === 'none' ? raw : undefined;
}

function trackMeta(track: Element): GpxMeta {
  const extensions = directChild(track, 'extensions');
  return {
    name: textOf(directChild(track, 'name')),
    desc: textOf(directChild(track, 'desc')),
    eleSource: parseEleSource(textOf(descendant(extensions, 'eleSource'))),
    legId: textOf(descendant(extensions, 'legId')),
  };
}

/**
 * Best-effort `<metadata>` + per-track extension reader. This is not a general
 * GPX parser — `src/core/gpx.ts` is — it only recovers what `toGpx` writes, and
 * it never throws: missing metadata simply means an unnamed trip.
 */
function gpxMeta(xml: string): {
  trip: Omit<GpxMeta, 'legId'>;
  tracks: GpxMeta[];
  routes: GpxMeta[];
} {
  const documentNode = readElementAttributes(xml);
  const root = documentNode?.documentElement ?? null;
  const metadata = descendant(root, 'metadata');
  const tracks: GpxMeta[] = [];
  const routes: GpxMeta[] = [];
  if (root) {
    for (const child of root.children) {
      const name = localNameOf(child);
      if (name === 'trk') tracks.push(trackMeta(child));
      if (name === 'rte') routes.push(trackMeta(child));
    }
  }
  return {
    trip: {
      name: textOf(directChild(metadata, 'name')),
      desc: textOf(directChild(metadata, 'desc')),
      eleSource: parseEleSource(textOf(descendant(directChild(metadata, 'extensions'), 'eleSource'))),
    },
    tracks,
    routes,
  };
}

function pointsFromGpxTrack(track: GpxTrack, eleSource: ElevationSource | undefined): RoutePoint[] {
  return track.points.map((point: GpxPoint): RoutePoint => {
    if (typeof point.ele === 'number' && Number.isFinite(point.ele)) {
      return { lon: point.lon, lat: point.lat, ele: point.ele, eleSource: eleSource ?? 'gpx' };
    }
    return { lon: point.lon, lat: point.lat, eleSource: 'none' };
  });
}

function tripFromGpx(text: string, filename: string): Trip {
  let document: GpxDocument;
  try {
    document = parseGpx(text);
  } catch (error) {
    throw new StoreError(
      'corrupt',
      `Could not read GPX "${filename}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const meta = gpxMeta(text);
  const usable = (track: GpxTrack): boolean => track.points.length >= 2;
  // Tracks win; a file that only has routes (a planned, not recorded, line) uses
  // those. Both are read by src/core/gpx.ts, which never merges tracks.
  const usingRoutes = !document.tracks.some(usable);
  const lines = usingRoutes ? document.routes : document.tracks;
  if (!lines.some(usable)) {
    throw new StoreError('corrupt', `GPX "${filename}" contains no line with at least two points`);
  }
  const metaFor = usingRoutes ? meta.routes : meta.tracks;

  const legs: Leg[] = [];
  for (const [index, track] of lines.entries()) {
    if (!usable(track)) continue;
    const info = metaFor[index] ?? {};
    const label = info.name ?? track.name ?? meta.trip.name ?? baseName(filename);
    legs.push(
      buildLeg(pointsFromGpxTrack(track, info.eleSource ?? meta.trip.eleSource), {
        name: info.name ?? track.name,
        provenance: [{ kind: 'gpx-upload', label }],
        id: info.legId,
      }),
    );
  }

  const name = meta.trip.name ?? (baseName(filename) || 'Imported trip');
  return finishTrip(name, legs);
}

/* ---- GeoJSON in ---------------------------------------------------- */

function legsFromGeometry(
  geometry: Record<string, unknown> | null,
  properties: Record<string, unknown> | null,
  where: string,
): { points: RoutePoint[]; name?: string; provenance: Provenance[] | null; id?: string }[] {
  const name = typeof properties?.name === 'string' ? properties.name : undefined;
  const id = typeof properties?.legId === 'string' ? properties.legId : undefined;
  const provenance = parseProvenance(properties?.provenance);
  if (!geometry) throw new StoreError('corrupt', `${where}: feature has no geometry`);

  const type = geometry.type;
  if (type === 'LineString') {
    const coordinates = geometry.coordinates;
    if (!Array.isArray(coordinates)) throw new StoreError('corrupt', `${where}: LineString has no coordinates`);
    return [
      {
        points: coordinates.map((coordinate) => pointFromCoordinates(coordinate, where)),
        name,
        provenance,
        id,
      },
    ];
  }
  if (type === 'MultiLineString') {
    const coordinates = geometry.coordinates;
    if (!Array.isArray(coordinates)) {
      throw new StoreError('corrupt', `${where}: MultiLineString has no coordinates`);
    }
    return coordinates.map((line, lineIndex) => {
      if (!Array.isArray(line)) throw new StoreError('corrupt', `${where}: MultiLineString part #${lineIndex} is not a line`);
      return {
        points: line.map((coordinate) => pointFromCoordinates(coordinate, where)),
        name: name ? `${name} (${lineIndex + 1})` : undefined,
        provenance,
        id: coordinates.length > 1 ? undefined : id,
      };
    });
  }
  throw new StoreError('unsupported', `${where}: GeoJSON geometry "${String(type)}" is not a line`);
}

function tripFromGeoJson(text: string, filename: string): Trip {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new StoreError(
      'corrupt',
      `Could not read JSON "${filename}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const collect = (value: unknown, where: string): ReturnType<typeof legsFromGeometry> => {
    if (!isRecord(value)) throw new StoreError('corrupt', `${where}: not a GeoJSON object`);
    const type = value.type;
    if (type === 'FeatureCollection') {
      if (!Array.isArray(value.features)) {
        throw new StoreError('corrupt', `${where}: FeatureCollection has no features array`);
      }
      return value.features.flatMap((feature, index) => collect(feature, `${where} feature #${index}`));
    }
    if (type === 'Feature') {
      if (!isRecord(value.geometry)) throw new StoreError('corrupt', `${where}: feature has no geometry`);
      const properties = isRecord(value.properties) ? value.properties : null;
      return legsFromGeometry(value.geometry, properties, where);
    }
    if (type === 'LineString' || type === 'MultiLineString') {
      return legsFromGeometry(value, null, where);
    }
    throw new StoreError('unsupported', `${where}: GeoJSON type "${String(type)}" is not a line`);
  };

  const name = (isRecord(parsed) && typeof parsed.name === 'string' ? parsed.name : undefined) ?? baseName(filename);
  const parts = collect(parsed, `"${filename}"`);
  const legs: Leg[] = [];
  for (const part of parts) {
    if (part.points.length < 2) continue;
    legs.push(
      buildLeg(part.points, {
        name: part.name,
        provenance: part.provenance ?? [{ kind: 'gpx-upload', label: name }],
        id: part.id,
      }),
    );
  }
  if (legs.length === 0) {
    throw new StoreError('corrupt', `GeoJSON "${filename}" contains no line with at least two points`);
  }
  return finishTrip(name, legs);
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

/**
 * Parse an uploaded file into a trip.
 *
 * - `.gpx` — GPX 1.0 or 1.1, read with `src/core/gpx.ts`. Every usable track
 *   becomes a leg (routes are used when the file has no tracks).
 * - `.geojson`, `.json` — LineString / MultiLineString / Feature /
 *   FeatureCollection.
 * - anything else — `StoreError('unsupported')`.
 *
 * Malformed content of a supported type is `StoreError('corrupt')`, never a
 * plain `Error`. The imported trip gets `defaultProfile()`; the caller replaces
 * it with the user's own.
 */
export function fromFile(text: string, filename: string): Trip {
  const extension = extensionOf(filename);
  if (extension === 'gpx') return tripFromGpx(text, filename);
  if (extension === 'geojson' || extension === 'json') return tripFromGeoJson(text, filename);
  throw new StoreError(
    'unsupported',
    `Cannot import "${filename}": only .gpx, .geojson and .json are supported.`,
  );
}
