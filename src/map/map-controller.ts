/**
 * MapLibre shell: live Kartverket basemap, 3D terrain, route layer and the
 * profile cursor.
 *
 * Everything here degrades visibly. There are exactly three health signals and
 * every one of them is surfaced to the app:
 *
 *  - `basemap`: the WMTS tile cache failed often enough to fall back to the
 *    Geonorge WMS, or both failed and the map is left on its background colour
 *    (never a blank white box).
 *  - `terrain`: the Mapterhorn TileJSON could not be fetched, so 3D is disabled
 *    with a reason instead of failing silently on click.
 *  - `fatal`: WebGL or the style could not initialise at all.
 *
 * The style is inline: no external style JSON, no glyph server, no third-party
 * fonts. Only raster tiles, a raster DEM and GeoJSON line/circle layers.
 */

import {
  Map as MapLibreMap,
  Popup,
  ScaleControl,
  type Map as MapLibreMapType,
  type ExpressionSpecification,
  type RasterSourceSpecification,
  type StyleSpecification,
} from 'maplibre-gl';

import type { LonLat } from '../core/geo';
import { displayCoordinates, routeBounds, type Bounds, type Route } from '../lib/route';

const WMTS_BASE = 'https://cache.kartverket.no/v1/wmts/1.0.0';
const WMS_URL =
  'https://wms.geonorge.no/skwms1/wms.topo?service=WMS&version=1.3.0&request=GetMap' +
  '&layers=topo&styles=&format=image/png&transparent=false&crs=EPSG:3857' +
  '&width=256&height=256&bbox={bbox-epsg-3857}';
const MAPTERHORN_TILEJSON = 'https://tiles.mapterhorn.com/tilejson.json';
/**
 * Sentinel-2 cloud-free mosaic (yearly composite) from Kartverket, via Geonorge.
 * Open data, same 10 m source as any Sentinel-2 mosaic, but Norwegian, current
 * (2025) and served from the origin already allowed for the topo fallback — so
 * the aerial layer costs no third-party host. The service renders tiles per
 * request; at 10 m native the useful zoom stops at z13 and MapLibre overzooms.
 *
 * Credit required by the metadata: "Copernicus Sentinel-2 data (year) / processed
 * by the Norwegian Mapping Authority".
 */
const AERIAL_LAYER_YEAR = '2025';
const AERIAL_URL =
  'https://wms.geonorge.no/skwms1/wms.sentinel2?service=WMS&version=1.3.0&request=GetMap' +
  `&layers=${AERIAL_LAYER_YEAR}&styles=&format=image/jpeg&transparent=false&crs=EPSG:3857` +
  '&width=256&height=256&bbox={bbox-epsg-3857}';
const AERIAL_MAX_ZOOM = 13;

/**
 * What the user can choose. The Geonorge WMS renders the *same* cartography and
 * is a fallback, never a choice of its own (see docs/DECISIONS.md D17).
 */
type BasemapKind = 'topo' | 'grey' | 'aerial';

/** How the chosen basemap is currently being rendered. */
type BasemapRenderer = 'wmts' | 'wms';

/** Every basemap raster layer in the style, fallback included. */
type BasemapSourceKind = BasemapKind | 'wms';

export type BasemapState =
  | { status: 'ok' }
  | { status: 'fallback'; requested: 'topo' | 'grey'; failedSource: string }
  | { status: 'aerial-failed' }
  | { status: 'failed' };

export type TerrainState =
  | { status: 'probing' }
  | { status: 'ready' }
  | { status: 'failed'; message: string };

export interface CameraInfo {
  center: LonLat;
  zoom: number;
}

interface MapCallbacks {
  onBasemapState(state: BasemapState): void;
  onTerrainState(state: TerrainState): void;
  onCamera(info: CameraInfo): void;
  onFatal(message: string): void;
}

/**
 * One resupply point as the map needs it: a position, a kind for the colour and
 * a flag for whether it counts as food. The map never decides *what* the point
 * means — that is `src/resupply`'s job.
 */
interface ResupplyMapPoint {
  readonly id: string;
  readonly kind: string;
  readonly position: LonLat;
  /** False for huts and unmanned fuel: drawn hollow, never a "you can eat" dot. */
  readonly usable: boolean;
}

interface ResupplyMapHandlers {
  /** A marker was clicked. The app moves the profile cursor to its distance. */
  onSelect?: (id: string) => void;
  /** Hover in/out; `null` when the pointer left every marker. */
  onHover?: (id: string | null) => void;
  /** The card to show on hover. Built by the app so the text is translated. */
  cardFor?: (id: string) => Node | null;
}

interface MapControllerOptions {
  reducedMotion?: boolean;
  /** Initial map sky/atmosphere, on by default. */
  sky?: boolean;
}

interface TileJson {
  tiles?: unknown;
  encoding?: unknown;
  tileSize?: unknown;
}

interface MapErrorLike {
  error?: Error;
  sourceId?: string;
}

const EMPTY_LINE: GeoJSON.FeatureCollection<GeoJSON.LineString> = {
  type: 'FeatureCollection',
  features: [],
};

const EMPTY_POINTS: GeoJSON.FeatureCollection<GeoJSON.Point> = {
  type: 'FeatureCollection',
  features: [],
};

function wmtsUrl(layer: 'topo' | 'topograatone'): string {
  return `${WMTS_BASE}/${layer}/default/webmercator/{z}/{y}/{x}.png`;
}

type StyleLayers = NonNullable<StyleSpecification['layers']>;

/**
 * Resupply markers: colour by kind, hollow for anything that is not a food
 * source, and a selection ring. There is no glyph server in this style, so the
 * kind is carried by colour and by the hover card, which has the words.
 */

/** Kind → colour. Chosen to stay distinguishable on the dark basemap. */

/**
 * Resupply glyphs, drawn locally.
 *
 * A symbol layer normally needs a glyph server for text; an *icon* needs only
 * images, so a canvas is enough and no font is ever fetched. 16 px at
 * pixelRatio 2, white on transparent, meant to sit on the coloured disc.
 */
const RESUPPLY_ICON_SCALE = 2;

type IconKind = 'shop' | 'fuel' | 'post' | 'hut';

/**
 * One glyph per kind, drawn twice: a bright version for a food point and a dark
 * one for anything that is not confirmed food. Neither is tinted at draw time —
 * `icon-color` would tint the rim as well as the shape, and the rim is the whole
 * point: it is what keeps a 16 px glyph legible on a photograph.
 */
type IconVariant = 'bright' | 'dark';

function resupplySilhouette(kind: IconKind, ctx: CanvasRenderingContext2D): Path2D {
  const path = new Path2D();
  if (kind === 'shop') {
    // Basket: a tapered body with a carry handle above it.
    path.moveTo(3, 6.4);
    path.lineTo(13, 6.4);
    path.lineTo(11.5, 13.4);
    path.lineTo(4.5, 13.4);
    path.closePath();
    path.moveTo(5.5, 6.3);
    path.arc(8, 6.3, 2.5, Math.PI, 0);
    ctx.stroke(path);
  } else if (kind === 'fuel') {
    // Pump body with a window, and a hose with a nozzle.
    path.rect(3.2, 4.1, 6.2, 9.4);
    path.rect(9.5, 6.2, 3.2, 6.2);
  } else if (kind === 'post') {
    path.moveTo(2.2, 4.9);
    path.lineTo(13.8, 4.9);
    path.lineTo(13.8, 12.4);
    path.lineTo(2.2, 12.4);
    path.closePath();
  } else {
    // Hut: roof with an overhang, walls, a door and a chimney.
    path.moveTo(8, 2.6);
    path.lineTo(14.4, 8.3);
    path.lineTo(12.8, 8.3);
    path.lineTo(12.8, 13.4);
    path.lineTo(3.2, 13.4);
    path.lineTo(3.2, 8.3);
    path.lineTo(1.6, 8.3);
    path.closePath();
  }
  return path;
}

/** Paint the glyph for a family, centred in a 16-unit box, in the given variant. */
function paintGlyph(kind: IconKind, ctx: CanvasRenderingContext2D, variant: IconVariant): void {
  const fill = variant === 'bright' ? '#f7fffd' : '#0e1a19';
  const rim = variant === 'bright' ? 'rgba(8,18,18,0.75)' : 'rgba(247,255,253,0.85)';
  const cut = variant === 'bright' ? 'rgba(8,18,18,0.75)' : 'rgba(247,255,253,0.85)';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.fillStyle = fill;
  ctx.strokeStyle = rim;

  const path = resupplySilhouette(kind, ctx);

  if (kind === 'shop') {
    ctx.beginPath();
    ctx.arc(8, 6.3, 2.5, Math.PI, 0);
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = rim;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(8, 6.3, 2.5, Math.PI, 0);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = fill;
    ctx.stroke();
    ctx.fill(path);
    ctx.strokeStyle = rim;
    ctx.lineWidth = 1.1;
    ctx.stroke(path);
  } else if (kind === 'fuel') {
    ctx.fill(path);
    ctx.strokeStyle = rim;
    ctx.lineWidth = 1.1;
    ctx.stroke(path);
    ctx.fillStyle = cut;
    ctx.fillRect(4.6, 5.9, 3.4, 2.6);
    ctx.strokeStyle = cut;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(9.4, 5.4);
    ctx.bezierCurveTo(12.4, 5.4, 12.6, 8.4, 11.4, 10.4);
    ctx.stroke();
  } else if (kind === 'post') {
    ctx.fill(path);
    ctx.strokeStyle = rim;
    ctx.lineWidth = 1.1;
    ctx.stroke(path);
    ctx.strokeStyle = cut;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(2.8, 5.4);
    ctx.lineTo(8, 9.2);
    ctx.lineTo(13.2, 5.4);
    ctx.stroke();
  } else {
    ctx.fill(path);
    ctx.strokeStyle = rim;
    ctx.lineWidth = 1.1;
    ctx.stroke(path);
    ctx.fillStyle = cut;
    ctx.fillRect(6.8, 9.6, 2.4, 3.6);
    ctx.fillRect(9.8, 3.2, 1.5, 2.6);
  }
}

/** A whole marker: coloured disc, contrast rim and glyph, as one 26 px image. */
function drawMarker(family: MarkerFamily, variant: IconVariant): ImageData | null {
  const logical = 26;
  const size = logical * RESUPPLY_ICON_SCALE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(RESUPPLY_ICON_SCALE, RESUPPLY_ICON_SCALE);

  const centre = logical / 2;
  const radius = 10.5;
  const food = variant === 'bright';

  ctx.beginPath();
  ctx.arc(centre, centre, radius, 0, Math.PI * 2);
  ctx.fillStyle = FAMILY_COLOR[family];
  // A point that is not food is drawn hollow: the visual is the honesty rule.
  ctx.globalAlpha = food ? 1 : 0.36;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = food ? 'rgba(6,16,15,0.65)' : 'rgba(247,255,253,0.92)';
  ctx.stroke();

  ctx.save();
  // The glyph box is 16 units; 0.72 of it sits well inside a 21 px disc.
  const scale = 0.72;
  ctx.translate(centre - (8 * scale), centre - (8 * scale));
  ctx.scale(scale, scale);
  paintGlyph(FAMILY_GLYPH[family], ctx, variant);
  ctx.restore();

  return ctx.getImageData(0, 0, size, size);
}

const CLUSTER_STEPS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 50, 100, 250] as const;

/** Two tones: a group with food in it, and a group without. */
type ClusterTone = 'food' | 'other';

const CLUSTER_TONE_RING: Record<ClusterTone, string> = {
  food: '#8fe3d4',
  other: '#c9a27a',
};

/**
 * A count badge, drawn once per (tone, bucket) at load time.
 *
 * Pre-rendered images are the performance answer here: no glyph server, no text
 * shaping, no per-frame work — MapLibre just blits a texture. The badge is 30 px
 * on screen rather than 26, with a heavier ring and a bigger number, because at
 * z5–z8 it is the only thing on the map that matters.
 */
function drawClusterBadge(count: number, tone: ClusterTone): ImageData | null {
  const logical = 30;
  const size = logical * RESUPPLY_ICON_SCALE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(RESUPPLY_ICON_SCALE, RESUPPLY_ICON_SCALE);

  const centre = logical / 2;
  ctx.beginPath();
  ctx.arc(centre, centre, centre - 2.2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(10, 22, 21, 0.94)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = CLUSTER_TONE_RING[tone];
  ctx.stroke();

  ctx.fillStyle = '#f4fffd';
  const label = count >= 250 ? '250+' : count >= 100 ? '99+' : String(count);
  ctx.font = `700 ${label.length >= 4 ? 9 : label.length === 3 ? 10.5 : 12}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, centre, centre + 0.5);

  return ctx.getImageData(0, 0, size, size);
}

/** `icon-image` for one tone: the bucket ladder, shared by both tones. */
function clusterImageExpression(tone: ClusterTone): ExpressionSpecification {
  const suffix = tone === 'food' ? '' : '-other';
  const expression: unknown[] = ['step', ['get', 'point_count'], `cluster-2${suffix}`];
  for (const step of CLUSTER_STEPS.slice(1)) {
    expression.push(step, `cluster-${step}${suffix}`);
  }
  return expression as unknown as ExpressionSpecification;
}

/** Paint the glyph for a family, centred in a 16-unit box, in the given variant. */
function registerResupplyIcons(map: MapLibreMapType): void {
  for (const family of ['green', 'teal', 'blue', 'amber', 'violet', 'orange'] as const) {
    for (const variant of ['bright', 'dark'] as const) {
      const image = drawMarker(family, variant);
      if (!image) continue;
      const name = variant === 'bright' ? `marker-${family}` : `marker-${family}-dark`;
      map.addImage(name, image, { pixelRatio: RESUPPLY_ICON_SCALE });
    }
  }
  for (const tone of ['food', 'other'] as const) {
    for (const count of CLUSTER_STEPS) {
      const badge = drawClusterBadge(count, tone);
      if (!badge) continue;
      const name = tone === 'food' ? `cluster-${count}` : `cluster-${count}-other`;
      map.addImage(name, badge, { pixelRatio: RESUPPLY_ICON_SCALE });
    }
  }
}

/** Colour families: one disc colour and one glyph per family. */
const MARKER_FAMILIES = {
  supermarket: 'green',
  convenience: 'teal',
  general: 'blue',
  grocery: 'blue',
  fuel: 'amber',
  post: 'violet',
  parcel: 'violet',
  hut: 'orange',
} as const;
type MarkerFamily = (typeof MARKER_FAMILIES)[keyof typeof MARKER_FAMILIES];

const FAMILY_COLOR: Record<MarkerFamily, string> = {
  green: '#7ee787',
  teal: '#4fae9c',
  blue: '#8fd0ff',
  amber: '#ffd166',
  violet: '#c9a7ff',
  orange: '#ff9e64',
};

const FAMILY_GLYPH: Record<MarkerFamily, IconKind> = {
  green: 'shop',
  teal: 'shop',
  blue: 'shop',
  amber: 'fuel',
  violet: 'post',
  orange: 'hut',
};

/** Marker image name for a kind, in the variant the point's food status needs. */
function markerImageExpression(variant: 'bright' | 'dark'): ExpressionSpecification {
  const suffix = variant === 'bright' ? '' : '-dark';
  return [
    'match',
    ['get', 'kind'],
    'supermarket',
    `marker-green${suffix}`,
    'convenience',
    `marker-teal${suffix}`,
    'general',
    `marker-blue${suffix}`,
    'grocery',
    `marker-blue${suffix}`,
    'fuel',
    `marker-amber${suffix}`,
    'post',
    `marker-violet${suffix}`,
    'parcel',
    `marker-violet${suffix}`,
    'hut',
    `marker-orange${suffix}`,
    `marker-teal${suffix}`,
  ];
}

/**
 * Cheap rolling hash (FNV-1a) of a point set.
 *
 * `setData` on a clustered source rebuilds the cluster index and the map
 * re-places every symbol, so it is only worth doing when something a user could
 * see has changed: id, kind, the food flag and the position to 1e-6° (≈0.1 m).
 * A collision could skip one redraw of a set that looks identical — the inputs are
 * ids and coordinates, not free text, so this is a hash of identity, not of prose.
 */
function resupplySignature(points: readonly ResupplyMapPoint[]): number {
  let hash = 0x811c9dc5;
  const mix = (value: number): void => {
    hash = Math.imul(hash ^ (value & 0xffff), 0x01000193);
    hash = Math.imul(hash ^ ((value >>> 16) & 0xffff), 0x01000193);
  };
  for (const point of points) {
    mix(1);
    for (let i = 0; i < point.id.length; i += 1) mix(point.id.charCodeAt(i));
    mix(0);
    for (let i = 0; i < point.kind.length; i += 1) mix(point.kind.charCodeAt(i));
    mix(point.usable ? 1 : 0);
    mix(Math.round(point.position.lon * 1e6));
    mix(Math.round(point.position.lat * 1e6));
  }
  return hash >>> 0;
}

function resupplyLayers(): StyleLayers {
  return [
    {
      // Selection only: one marker at a time, so a circle layer is enough and it
      // does not need to take part in collision.
      id: 'resupply-ring',
      type: 'circle',
      source: 'resupply',
      filter: ['all', ['!', ['has', 'point_count']], ['==', ['get', 'id'], '__none__']],
      paint: {
        'circle-radius': 15,
        'circle-color': '#f2fffc',
        'circle-opacity': 0.12,
        'circle-stroke-color': '#f2fffc',
        'circle-stroke-width': 2,
      },
    },
    {
      id: 'resupply-cluster-count',
      type: 'symbol',
      source: 'resupply',
      filter: ['has', 'point_count'],
      layout: {
        'icon-image': [
          'case',
          ['>', ['get', 'food'], 0],
          clusterImageExpression('food'),
          clusterImageExpression('other'),
        ],
        // Bigger when far out: at z5 a badge is the only readable thing on screen.
        'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 1.2, 7, 1.1, 9, 0.95, 12, 0.85],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    },
    {
      // The marker is one image: coloured disc, dark rim, white glyph. Drawing it
      // as circles plus an icon meant the discs collided while the icons did not,
      // so a dense block stacked into an unreadable pile. Now the whole marker
      // takes part in collision placement and declutters as a unit.
      id: 'resupply-markers',
      type: 'symbol',
      source: 'resupply',
      filter: ['!', ['has', 'point_count']],
      layout: {
        'icon-image': [
          'case',
          ['==', ['get', 'usable'], true],
          markerImageExpression('bright'),
          markerImageExpression('dark'),
        ],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 4, 0.55, 9, 0.7, 13, 0.9, 16, 1],
        'icon-padding': 3,
        'icon-allow-overlap': false,
        // Food wins the slot over a hut when only one marker fits.
        'symbol-sort-key': ['case', ['==', ['get', 'usable'], true], 0, 1],
      },
      paint: { 'icon-opacity': 1 },
    },
  ];
}

function buildStyle(): StyleSpecification {
  return {
    version: 8,
    // No glyphs: the style has no symbol layers, so no font is ever fetched.
    sources: {
      'basemap-topo': {
        type: 'raster',
        tiles: [wmtsUrl('topo')],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 18,
        attribution: '©Kartverket',
      },
      'basemap-grey': {
        type: 'raster',
        tiles: [wmtsUrl('topograatone')],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 18,
        attribution: '©Kartverket',
      },
      'basemap-aerial': {
        type: 'raster',
        tiles: [AERIAL_URL],
        tileSize: 256,
        minzoom: 0,
        maxzoom: AERIAL_MAX_ZOOM,
        attribution: 'Copernicus Sentinel-2 (2025) / Kartverket',
      },
      'basemap-wms': {
        type: 'raster',
        tiles: [WMS_URL],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 16,
        attribution: '©Kartverket',
      },
      route: { type: 'geojson', data: EMPTY_LINE },
      'leg-highlight': { type: 'geojson', data: EMPTY_LINE },
      'route-endpoints': { type: 'geojson', data: EMPTY_POINTS },
      resupply: {
        type: 'geojson',
        data: EMPTY_POINTS,
        // "Compacted when zoomed out": one badge instead of forty glyphs.
        cluster: true,
        clusterRadius: 48,
        clusterMaxZoom: 12,
        // A clustered view should still say whether the group is worth walking to:
        // one property, summed in the worker, no per-frame work on the main thread.
        clusterProperties: {
          food: ['+', ['case', ['==', ['get', 'usable'], true], 1, 0]],
        },
      },
      'route-cursor': { type: 'geojson', data: EMPTY_POINTS },
    },
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': '#0e1a1d' },
      },
      {
        id: 'basemap-grey',
        type: 'raster',
        source: 'basemap-grey',
        layout: { visibility: 'none' },
        paint: { 'raster-opacity': 0.92, 'raster-saturation': -0.35, 'raster-contrast': 0.05 },
      },
      {
        id: 'basemap-topo',
        type: 'raster',
        source: 'basemap-topo',
        paint: {
          'raster-opacity': 0.94,
          'raster-saturation': -0.28,
          'raster-contrast': 0.06,
          'raster-brightness-max': 0.94,
        },
      },
      {
        id: 'basemap-aerial',
        type: 'raster',
        source: 'basemap-aerial',
        layout: { visibility: 'none' },
        // No desaturation: this is a photograph, and the darkest thing on it is
        // the route casing.
        paint: { 'raster-opacity': 1, 'raster-contrast': 0.04 },
      },
      {
        id: 'basemap-wms',
        type: 'raster',
        source: 'basemap-wms',
        layout: { visibility: 'none' },
        paint: { 'raster-opacity': 0.94, 'raster-saturation': -0.18 },
      },
      {
        id: 'route-casing',
        type: 'line',
        source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#061012',
          'line-opacity': 0.55,
          'line-width': ['interpolate', ['linear'], ['zoom'], 3, 2.4, 8, 3.6, 13, 5.6, 16, 7],
        },
      },
      {
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#4fae9c',
          'line-opacity': 0.95,
          'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1.4, 8, 2.2, 13, 3.4, 16, 4.4],
        },
      },
      {
        id: 'leg-highlight',
        type: 'line',
        source: 'leg-highlight',
        layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'none' },
        paint: {
          'line-color': '#e0a45a',
          'line-opacity': 0.9,
          'line-width': ['interpolate', ['linear'], ['zoom'], 3, 4, 8, 6, 13, 9, 16, 12],
        },
      },
      {
        id: 'route-endpoints',
        type: 'circle',
        source: 'route-endpoints',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 3, 10, 5, 15, 7],
          'circle-color': [
            'match',
            ['get', 'kind'],
            'start',
            '#4fae9c',
            'end',
            '#e8efef',
            '#4fae9c',
          ],
          'circle-stroke-color': '#0b1416',
          'circle-stroke-width': 2,
        },
      },
      ...resupplyLayers(),
      {
        id: 'route-cursor-halo',
        type: 'circle',
        source: 'route-cursor',
        paint: {
          'circle-radius': 13,
          'circle-color': '#4fae9c',
          'circle-opacity': 0.16,
          'circle-stroke-color': '#4fae9c',
          'circle-stroke-width': 1.2,
          'circle-stroke-opacity': 0.55,
        },
      },
      {
        id: 'route-cursor',
        type: 'circle',
        source: 'route-cursor',
        paint: {
          'circle-radius': 4.5,
          'circle-color': '#f2fffc',
          'circle-stroke-color': '#4fae9c',
          'circle-stroke-width': 2,
        },
      },
    ],
  };
}

/**
 * Small, i18n-neutral map shell around MapLibre.
 *
 * Ownership of user-facing text stays in the app: the controller reports state
 * and the app renders it. That keeps MapLibre's own English control strings out
 * of the UI (we only use the scale bar, which has no words).
 */
export class MapController {
  readonly map: MapLibreMapType;
  private callbacks: MapCallbacks;
  private reducedMotion: boolean;
  private basemap: BasemapKind = 'topo';
  private renderer: BasemapRenderer = 'wmts';
  private basemapHealth: BasemapState = { status: 'ok' };
  private terrainState: TerrainState = { status: 'probing' };
  private terrainEnabled = false;
  private terrainTiles: string[] | null = null;
  private wmtsErrors = 0;
  private wmtsTileLoaded = false;
  private wmsErrors = 0;
  private wmsTileLoaded = false;
  private aerialErrors = 0;
  private aerialTileLoaded = false;
  private terrainErrors = 0;
  private terrainTileLoaded = false;
  private cameraFrame = 0;
  private ready = false;
  private disposed = false;
  private resupply: ResupplyMapPoint[] = [];
  /** Rolling hash of the drawn points; `null` until the first set is applied. */
  private resupplySignature: number | null = null;
  private resupplyHandlers: ResupplyMapHandlers = {};
  private resupplyPopup: Popup | null = null;
  private resupplyHovered: string | null = null;
  private resupplySelected: string | null = null;

  constructor(container: HTMLElement, callbacks: MapCallbacks, options: MapControllerOptions = {}) {
    this.callbacks = callbacks;
    this.reducedMotion = options.reducedMotion ?? false;

    let map: MapLibreMapType;
    try {
      map = new MapLibreMap({
        container,
        style: buildStyle(),
        center: [10.4, 63.4],
        zoom: 4,
        minZoom: 2,
        maxZoom: 17,
        maxPitch: 60,
        pitch: 0,
        bearing: 0,
        attributionControl: false,
        fadeDuration: this.reducedMotion ? 0 : 200,
        dragRotate: true,
        pitchWithRotate: true,
        touchPitch: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.callbacks.onFatal(message);
      throw error;
    }

    this.map = map;

    map.addControl(new ScaleControl({ maxWidth: 96, unit: 'metric' }), 'bottom-left');

    map.on('error', (event) => this.handleError(event as unknown as MapErrorLike));
    map.on('sourcedata', (event) => this.handleSourceData(event));

    map.on('load', () => {
      this.ready = true;
      registerResupplyIcons(map);
      if (options.sky !== false) this.applySky();
      void this.probeTerrain();
      this.wireResupplyInteraction();
      // Markers can be set before the style finished loading; paint them now.
      this.applyResupply();
      this.applyResupplySelection();
    });

    const scheduleCamera = (): void => {
      if (this.cameraFrame !== 0) return;
      this.cameraFrame = requestAnimationFrame(() => {
        this.cameraFrame = 0;
        if (this.disposed) return;
        const center = map.getCenter();
        this.callbacks.onCamera({ center: { lon: center.lng, lat: center.lat }, zoom: map.getZoom() });
      });
    };
    map.on('move', scheduleCamera);
    map.on('moveend', scheduleCamera);
  }

  // -------------------------------------------------------------------------
  // Sky / terrain
  // -------------------------------------------------------------------------

  private applySky(): void {
    this.map.setSky({
      'sky-color': '#0c1a1d',
      'horizon-color': '#1d3a3d',
      'fog-color': '#0e1a1d',
      'sky-horizon-blend': 0.45,
      'horizon-fog-blend': 0.55,
      'fog-ground-blend': 0.5,
      'atmosphere-blend': 0.65,
    });
  }

  /** Re-probe the DEM TileJSON after a failure (used by the banner action). */
  retryTerrain(): void {
    if (this.terrainState.status === 'probing') return;
    this.terrainErrors = 0;
    this.terrainTileLoaded = false;
    this.terrainState = { status: 'probing' };
    this.callbacks.onTerrainState(this.terrainState);
    if (this.ready) void this.probeTerrain();
  }

  private async probeTerrain(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(MAPTERHORN_TILEJSON, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const tilejson = (await response.json()) as TileJson;
      const tiles = Array.isArray(tilejson.tiles)
        ? tilejson.tiles.filter((tile): tile is string => typeof tile === 'string')
        : [];
      if (tiles.length === 0) throw new Error('TileJSON contains no tiles');
      if (tilejson.encoding !== undefined && tilejson.encoding !== 'terrarium') {
        throw new Error(`unexpected DEM encoding "${String(tilejson.encoding)}"`);
      }
      if (this.disposed) return;
      this.terrainTiles = tiles;
      this.addTerrainSource();
      this.terrainState = { status: 'ready' };
      this.callbacks.onTerrainState(this.terrainState);
    } catch (error) {
      if (this.disposed) return;
      const message =
        error instanceof Error
          ? error.name === 'AbortError'
            ? 'timeout'
            : error.message
          : String(error);
      this.terrainState = { status: 'failed', message };
      this.callbacks.onTerrainState(this.terrainState);
    } finally {
      clearTimeout(timer);
    }
  }

  private addTerrainSource(): void {
    if (this.terrainTiles === null || this.map.getSource('terrain-dem')) return;
    this.map.addSource('terrain-dem', {
      type: 'raster-dem',
      tiles: this.terrainTiles,
      encoding: 'terrarium',
      tileSize: 512,
      // Explicit cap: MapLibre overzooms the last tile instead of requesting
      // tiles that do not exist beyond level 13.
      maxzoom: 13,
      minzoom: 0,
      attribution: 'Mapterhorn',
    });

    // The DEM feeds 3D only — there is deliberately no `hillshade` layer on top
    // of it. Kartverket's topo and topograatone rasters already carry their own
    // relief shading, and the place labels are *baked into those same tiles*
    // (there is no glyph server in this style, so no label layer could be drawn
    // above an overlay). An extra hillshade therefore paints over the labels:
    // on the steep shaded faces of Surtningssue and Besshøe "2368"/"2258" and
    // the summits' names wash out, and the wash moves as you pitch. Measured
    // A/B: hide this layer and the labels are crisp in the same view. The relief
    // that was wanted is already in the tiles; 3D terrain supplies the depth.
  }

  get terrain(): TerrainState {
    return this.terrainState;
  }

  get terrainOn(): boolean {
    return this.terrainEnabled;
  }

  /** Enable or disable 3D. Returns false (and stays flat) when DEM is unusable. */
  setTerrainEnabled(enabled: boolean): boolean {
    if (enabled && this.terrainState.status !== 'ready') return false;
    this.terrainEnabled = enabled;
    const duration = this.reducedMotion ? 0 : 900;
    if (enabled) {
      this.map.setTerrain({ source: 'terrain-dem', exaggeration: 1.35 });
      this.map.easeTo({ pitch: 55, duration });
    } else {
      this.map.setTerrain(null);
      this.map.easeTo({ pitch: 0, duration });
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Basemap
  // -------------------------------------------------------------------------

  /** The current viewport, for asking "what is around here". */
  getViewBounds(): { west: number; south: number; east: number; north: number; zoom: number } {
    const bounds = this.map.getBounds();
    return {
      west: bounds.getWest(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      north: bounds.getNorth(),
      zoom: this.map.getZoom(),
    };
  }

  get basemapKind(): BasemapKind {
    return this.basemap;
  }

  get basemapFallbackActive(): boolean {
    return this.renderer === 'wms';
  }

  /**
   * The basemap health the app renders, kept here so a layer click cannot
   * disagree with what is actually drawn: the button handler reads this instead
   * of assuming a click fixed the cache.
   */
  get basemapState(): BasemapState {
    return this.basemapHealth;
  }

  setBasemap(kind: BasemapKind): void {
    this.basemap = kind;
    if (kind === 'aerial') {
      this.aerialErrors = 0;
      this.aerialTileLoaded = false;
    }
    // Choosing a layer is also a request to use it: while the WMS stands in for
    // the cache, try the cache again rather than silently keep the fallback.
    if (this.renderer === 'wms') this.rebuildBasemapSources();
    this.setBasemapState({ status: 'ok' });
    this.applyBasemapVisibility();
  }

  private setBasemapState(state: BasemapState): void {
    this.basemapHealth = state;
    this.callbacks.onBasemapState(state);
  }

  /** One raster visible at a time: the chosen WMTS layer, or the WMS fallback. */
  private applyBasemapVisibility(): void {
    const visible: BasemapSourceKind = this.renderer === 'wms' ? 'wms' : this.basemap;
    for (const candidate of ['topo', 'grey', 'aerial', 'wms'] as const) {
      if (this.map.getLayer(`basemap-${candidate}`)) {
        this.map.setLayoutProperty(
          `basemap-${candidate}`,
          'visibility',
          candidate === visible ? 'visible' : 'none',
        );
      }
    }
  }

  /** Retry the WMTS cache after a fallback: rebuilds the failing source. */
  retryBasemap(): void {
    this.rebuildBasemapSources();
    this.setBasemapState({ status: 'ok' });
    this.applyBasemapVisibility();
    this.map.triggerRepaint();
  }

  /** Rebuild every basemap raster and go back to the WMTS renderer. */
  private rebuildBasemapSources(): void {
    this.wmtsErrors = 0;
    this.wmsErrors = 0;
    this.renderer = 'wmts';
    this.wmtsTileLoaded = false;
    this.wmsTileLoaded = false;
    this.terrainErrors = 0;
    for (const kind of ['topo', 'grey'] as const) this.rebuildBasemapSource(kind);
    this.rebuildBasemapSource('wms');
  }

  private rebuildBasemapSource(kind: BasemapSourceKind): void {
    const sourceId = `basemap-${kind}`;
    const layerId = `basemap-${kind}`;
    if (!this.map.getLayer(layerId)) return;
    const visibility = this.map.getLayoutProperty(layerId, 'visibility') as string | undefined;
    this.map.removeLayer(layerId);
    if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);

    const tileSource: RasterSourceSpecification =
      kind === 'wms'
        ? { type: 'raster', tiles: [WMS_URL], tileSize: 256, minzoom: 0, maxzoom: 16, attribution: '©Kartverket' }
        : kind === 'aerial'
        ? {
            type: 'raster',
            tiles: [AERIAL_URL],
            tileSize: 256,
            minzoom: 0,
            maxzoom: AERIAL_MAX_ZOOM,
            attribution: 'Copernicus Sentinel-2 (2025) / Kartverket',
          }
        : {
            type: 'raster',
            tiles: [wmtsUrl(kind === 'grey' ? 'topograatone' : 'topo')],
            tileSize: 256,
            minzoom: 0,
            maxzoom: 18,
            attribution: '©Kartverket',
          };
    this.map.addSource(sourceId, tileSource);
    const anchor = this.findBasemapAnchor();
    this.map.addLayer(
      {
        id: layerId,
        type: 'raster',
        source: sourceId,
        layout: { visibility: visibility === 'none' ? 'none' : 'visible' },
        paint:
          kind === 'aerial'
            ? { 'raster-opacity': 1, 'raster-contrast': 0.04 }
            : kind === 'grey'
            ? { 'raster-opacity': 0.92, 'raster-saturation': -0.45, 'raster-contrast': 0.07 }
            : {
              'raster-opacity': 0.94,
              'raster-saturation': -0.28,
              'raster-contrast': 0.06,
              'raster-brightness-max': 0.94,
            },
      },
      anchor,
    );
  }

  /** Keep rebuilt basemap layers under the route layers. */
  private findBasemapAnchor(): string | undefined {
    for (const id of ['route-casing', 'route-line', 'route-endpoints', 'route-cursor-halo', 'route-cursor']) {
      if (this.map.getLayer(id)) return id;
    }
    return undefined;
  }

  private handleSourceData(event: { sourceId?: string; tile?: unknown; isSourceLoaded?: boolean }): void {
    if (!event.sourceId) return;
    // Only the layer in use is evidence about the cache: a hidden raster that
    // happens to have loaded says nothing about the one on screen.
    const chosen = `basemap-${this.basemap}`;
    if (event.sourceId === 'basemap-topo' || event.sourceId === 'basemap-grey') {
      if (event.tile && event.sourceId === chosen) this.wmtsTileLoaded = true;
    } else if (event.sourceId === 'basemap-aerial') {
      if (event.tile && this.basemap === 'aerial') this.aerialTileLoaded = true;
    } else if (event.sourceId === 'basemap-wms') {
      if (event.tile) this.wmsTileLoaded = true;
    } else if (event.sourceId === 'terrain-dem') {
      if (event.tile) this.terrainTileLoaded = true;
    }
  }

  private handleError(event: MapErrorLike): void {
    const sourceId = event.sourceId ?? '';
    const message = event.error?.message ?? 'unknown map error';

    if (sourceId === 'basemap-topo' || sourceId === 'basemap-grey') {
      // Only the layer the user actually chose counts: a hidden raster that
      // failed once is not evidence about the chosen one.
      const chosen = `basemap-${this.basemap}`;
      if (sourceId !== chosen) return;
      this.wmtsErrors++;
      if (!this.wmtsTileLoaded && this.wmtsErrors >= 3 && this.renderer !== 'wms') {
        this.renderer = 'wms';
        this.applyBasemapVisibility();
        this.setBasemapState({
          status: 'fallback',
          // Only the two WMTS cartographies can be served by the WMS.
          requested: this.basemap === 'grey' ? 'grey' : 'topo',
          failedSource: sourceId,
        });
      }
      return;
    }

    if (sourceId === 'basemap-aerial') {
      // The WMS is the same topo cartography, so it cannot stand in for a
      // photograph: fall back to Topo and say so instead of showing a photo
      // that will never arrive.
      this.aerialErrors++;
      if (this.basemap === 'aerial' && !this.aerialTileLoaded && this.aerialErrors >= 3) {
        this.setBasemap('topo');
        this.setBasemapState({ status: 'aerial-failed' });
      }
      return;
    }

    if (sourceId === 'basemap-wms') {
      this.wmsErrors++;
      if (!this.wmsTileLoaded && this.wmsErrors >= 3) {
        this.setBasemapState({ status: 'failed' });
      }
      return;
    }

    if (sourceId === 'terrain-dem') {
      // Individual DEM tiles can 404 at the edge of coverage. Only give up on
      // 3D when nothing has ever loaded, so a single missing tile next to a
      // valid one does not turn the feature off.
      this.terrainErrors++;
      if (
        this.terrainState.status === 'ready' &&
        !this.terrainTileLoaded &&
        this.terrainErrors >= 3
      ) {
        this.terrainState = { status: 'failed', message };
        this.terrainEnabled = false;
        this.map.setTerrain(null);
        this.callbacks.onTerrainState(this.terrainState);
      }
      return;
    }

    if (event.error && !sourceId && !this.ready) {
      // Style or WebGL failure before the first idle frame: the map cannot
      // render at all. Errors after load are tile-level and handled above.
      this.callbacks.onFatal(message);
    }
  }

  // -------------------------------------------------------------------------
  // Route, cursor, camera
  // -------------------------------------------------------------------------

  /**
   * Draw one leg on top of the route, so the leg selected in the trip list is
   * also the leg you can see. `null` clears it.
   */
  setLegHighlight(points: readonly LonLat[] | null): void {
    const source = this.map.getSource('leg-highlight');
    if (source && 'setData' in source) {
      (source as { setData(data: GeoJSON.GeoJSON): void }).setData({
        type: 'FeatureCollection',
        features:
          points && points.length >= 2
            ? [
                {
                  type: 'Feature',
                  properties: {},
                  geometry: { type: 'LineString', coordinates: points.map((p) => [p.lon, p.lat]) },
                },
              ]
            : [],
      });
    }
    if (this.map.getLayer('leg-highlight')) {
      this.map.setLayoutProperty('leg-highlight', 'visibility', points ? 'visible' : 'none');
    }
  }

  /** Frame a set of points, or do nothing when there is nothing to frame. */
  fitToPoints(points: readonly LonLat[]): void {
    if (points.length === 0) return;
    let west = points[0].lon;
    let east = points[0].lon;
    let south = points[0].lat;
    let north = points[0].lat;
    for (const point of points) {
      if (point.lon < west) west = point.lon;
      if (point.lon > east) east = point.lon;
      if (point.lat < south) south = point.lat;
      if (point.lat > north) north = point.lat;
    }
    this.map.fitBounds([west, south, east, north], {
      padding: 80,
      duration: this.reducedMotion ? 0 : 400,
      maxZoom: 15,
    });
  }

  setRoute(route: Route | null, options: { fit: boolean } = { fit: true }): void {
    const coordinates = route ? displayCoordinates(route.points) : [];
    const lineSource = this.map.getSource('route');
    if (lineSource && 'setData' in lineSource) {
      (lineSource as { setData(data: GeoJSON.GeoJSON): void }).setData({
        type: 'FeatureCollection',
        features:
          coordinates.length >= 2
            ? [
                {
                  type: 'Feature',
                  properties: {},
                  geometry: { type: 'LineString', coordinates },
                },
              ]
            : [],
      });
    }

    const endpointSource = this.map.getSource('route-endpoints');
    if (endpointSource && 'setData' in endpointSource) {
      const points: Array<GeoJSON.Feature<GeoJSON.Point>> = [];
      if (route && route.points.length >= 2) {
        const first = route.points[0];
        const last = route.points[route.points.length - 1];
        points.push({
          type: 'Feature',
          properties: { kind: 'start' },
          geometry: { type: 'Point', coordinates: [first.lon, first.lat] },
        });
        points.push({
          type: 'Feature',
          properties: { kind: 'end' },
          geometry: { type: 'Point', coordinates: [last.lon, last.lat] },
        });
      }
      (endpointSource as { setData(data: GeoJSON.GeoJSON): void }).setData(
        points.length === 0 ? { type: 'FeatureCollection', features: [] } : { type: 'FeatureCollection', features: points },
      );
    }

    if (route && options.fit) {
      const bounds = routeBounds(route.points);
      if (bounds) this.fitBounds(bounds);
    }
  }

  /** Move the camera to the whole route, leaving the layers untouched. */
  fitRoute(route: Route): void {
    const bounds = routeBounds(route.points);
    if (bounds) this.fitBounds(bounds);
  }

  fitBounds(bounds: Bounds): void {
    // Keep the route clear of the map controls (top-right), the attribution
    // (bottom-right) and the scale bar (bottom-left).
    const narrow = (this.map.getCanvas()?.clientWidth ?? 900) < 620;
    const padding = narrow
      ? { top: 56, right: 64, bottom: 74, left: 64 }
      : { top: 64, right: 104, bottom: 96, left: 64 };
    this.map.fitBounds(
      [
        [bounds.minLon, bounds.minLat],
        [bounds.maxLon, bounds.maxLat],
      ],
      {
        padding,
        maxZoom: 14.5,
        duration: this.reducedMotion ? 0 : 900,
        essential: false,
      },
    );
  }

  // -------------------------------------------------------------------------
  // Resupply markers
  // -------------------------------------------------------------------------

  /**
   * Replace the resupply markers. Safe before the style has loaded.
   *
   * A clustered source rebuilds its whole index on every `setData`, and the map
   * re-places every symbol: calling it with the same points (which a camera
   * settle does, since the layer is merged, not replaced) made the glyphs blink
   * for no reason. The signature is a cheap rolling hash over id, kind, food flag
   * and position; identical means nothing to draw differently.
   */
  setResupplyPoints(points: readonly ResupplyMapPoint[]): void {
    this.resupply = [...points];
    const signature = resupplySignature(this.resupply);
    if (signature === this.resupplySignature) return;
    this.resupplySignature = signature;
    this.applyResupply();
  }

  setResupplyHandlers(handlers: ResupplyMapHandlers): void {
    this.resupplyHandlers = handlers;
  }

  /**
   * Ring the marker for `id` and show its card, or clear both with `null`.
   *
   * Selecting from the list and hovering on the map are the same affordance:
   * "what is this point?" — so a selection keeps the card open.
   */
  setResupplySelection(id: string | null): void {
    this.resupplySelected = id;
    this.applyResupplySelection();
    if (id === null) {
      this.resupplyPopup?.remove();
      this.resupplyPopup = null;
      return;
    }
    // On a phone the panel is a bottom sheet that would cover the card; the
    // ring plus the list row already say which point this is.
    if (!this.isNarrow()) this.showResupplyCard(id, true);
  }

  /** The same 620 px breakpoint the camera padding uses. */
  private isNarrow(): boolean {
    return (this.map.getCanvas()?.clientWidth ?? 900) < 620;
  }

  private applyResupply(): void {
    const source = this.map.getSource('resupply');
    if (!source || !('setData' in source)) return;
    const features: Array<GeoJSON.Feature<GeoJSON.Point>> = this.resupply.map((point) => ({
      type: 'Feature',
      properties: { id: point.id, kind: point.kind, usable: point.usable },
      geometry: { type: 'Point', coordinates: [point.position.lon, point.position.lat] },
    }));
    (source as { setData(data: GeoJSON.GeoJSON): void }).setData({
      type: 'FeatureCollection',
      features,
    });
  }

  private applyResupplySelection(): void {
    if (!this.map.getLayer('resupply-ring')) return;
    this.map.setFilter('resupply-ring', ['==', ['get', 'id'], this.resupplySelected ?? '__none__']);
  }

  private pointById(id: string): ResupplyMapPoint | undefined {
    return this.resupply.find((point) => point.id === id);
  }

  private wireResupplyInteraction(): void {
    // A cluster is a group, not a place: clicking it zooms to where it breaks up.
    if (this.map.getLayer('resupply-cluster-count')) {
      this.map.on('click', 'resupply-cluster-count', (event) => {
        const feature = event.features?.[0];
        const clusterId = feature?.properties?.cluster_id;
        if (typeof clusterId !== 'number') return;
        const source = this.map.getSource('resupply') as
          | { getClusterExpansionZoom(id: number): Promise<number> }
          | undefined;
        void source?.getClusterExpansionZoom(clusterId).then((zoom) => {
          const [lon, lat] = (feature?.geometry as GeoJSON.Point).coordinates;
          this.map.easeTo({ center: [lon, lat], zoom, duration: this.reducedMotion ? 0 : 400 });
        });
      });
      this.map.on('mousemove', 'resupply-cluster-count', () => {
        this.map.getCanvas().style.cursor = 'zoom-in';
      });
      this.map.on('mouseleave', 'resupply-cluster-count', () => {
        this.map.getCanvas().style.cursor = '';
      });
    }
    // The symbol layer is on top of the disc, so the pointer meets whichever is
    // drawn last: listen on both.
    const layers = ['resupply-markers'].filter((id) => this.map.getLayer(id));
    if (layers.length === 0) return;
    for (const layer of layers) this.wireResupplyLayer(layer);
  }

  private wireResupplyLayer(layer: string): void {
    if (!this.map.getLayer(layer)) return;
    this.map.on('click', layer, (event) => {
      const id = event.features?.[0]?.properties?.id;
      if (typeof id === 'string') this.resupplyHandlers.onSelect?.(id);
    });
    this.map.on('mousemove', layer, (event) => {
      const id = event.features?.[0]?.properties?.id;
      if (typeof id !== 'string') return;
      this.map.getCanvas().style.cursor = 'pointer';
      if (id !== this.resupplyHovered) {
        this.resupplyHovered = id;
        this.resupplyHandlers.onHover?.(id);
      }
      this.showResupplyCard(id);
    });
    this.map.on('mouseleave', layer, () => {
      this.map.getCanvas().style.cursor = '';
      if (this.resupplyHovered !== null) {
        this.resupplyHovered = null;
        this.resupplyHandlers.onHover?.(null);
      }
      this.resupplyPopup?.remove();
      this.resupplyPopup = null;
    });
  }

  private showResupplyCard(id: string, replace = false): void {
    if (this.resupplyPopup?.isOpen() && !replace) return;
    const card = this.resupplyHandlers.cardFor?.(id) ?? null;
    const point = this.pointById(id);
    if (!card || !point) return;
    this.resupplyPopup?.remove();
    this.resupplyPopup = new Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 14,
      maxWidth: '260px',
      className: 'resupply-popup',
    })
      .setLngLat([point.position.lon, point.position.lat])
      .setDOMContent(card)
      .addTo(this.map);
  }

  /**
   * Centre the map on a point (used when a panel row is activated).
   *
   * On a narrow viewport the supply panel is a bottom sheet, so the camera
   * padding lifts the point into the strip of map that is still visible —
   * otherwise the selection would be hidden by the thing that selected it.
   */
  focusOn(position: LonLat): void {
    const height = this.map.getContainer().clientHeight;
    const padding = this.isNarrow()
      ? { top: 0, right: 0, bottom: Math.round(height * 0.55), left: 0 }
      : undefined;
    this.map.easeTo({
      center: [position.lon, position.lat],
      duration: this.reducedMotion ? 0 : 600,
      zoom: Math.max(this.map.getZoom(), 9),
      ...(padding ? { padding } : {}),
    });
  }

  setCursor(position: LonLat | null): void {
    const source = this.map.getSource('route-cursor');
    if (!source || !('setData' in source)) return;
    (source as { setData(data: GeoJSON.GeoJSON): void }).setData(
      position === null
        ? { type: 'FeatureCollection', features: [] }
        : {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {},
                geometry: { type: 'Point', coordinates: [position.lon, position.lat] },
              },
            ],
          },
    );
  }

  zoomBy(delta: number): void {
    this.map.easeTo({ zoom: this.map.getZoom() + delta, duration: this.reducedMotion ? 0 : 350 });
  }

  resetNorth(): void {
    this.map.easeTo({ bearing: 0, duration: this.reducedMotion ? 0 : 500 });
  }

  getCamera(): CameraInfo {
    const center = this.map.getCenter();
    return { center: { lon: center.lng, lat: center.lat }, zoom: this.map.getZoom() };
  }

  get isReady(): boolean {
    return this.ready;
  }

  whenReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve) => this.map.once('load', () => resolve()));
  }

  resize(): void {
    this.map.resize();
  }

  dispose(): void {
    this.disposed = true;
    if (this.cameraFrame !== 0) cancelAnimationFrame(this.cameraFrame);
    this.map.remove();
  }
}
