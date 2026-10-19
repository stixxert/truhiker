/**
 * MapLibre shell: live Kartverket basemap, hillshade, 3D terrain, route layer
 * and the profile cursor.
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

type BasemapKind = 'topo' | 'grey' | 'wms';

export type BasemapState =
  | { status: 'ok' }
  | { status: 'fallback'; requested: 'topo' | 'grey'; failedSource: string }
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
type CircleLayer = Extract<StyleLayers[number], { type: 'circle' }>;
type ColorSpec = NonNullable<CircleLayer['paint']>['circle-color'];

/** Kind → colour. Chosen to stay distinguishable on the dark basemap. */
function resupplyColor(): NonNullable<ColorSpec> {
  return [
    'match',
    ['get', 'kind'],
    'supermarket', '#7ee787',
    'convenience', '#4fae9c',
    'general', '#8fd0ff',
    'grocery', '#8fd0ff',
    'fuel', '#ffd166',
    'post', '#c9a7ff',
    'parcel', '#c9a7ff',
    'hut', '#ff9e64',
    '#e8efef',
  ];
}

function resupplyLayers(): StyleLayers {
  return [
    {
      id: 'resupply-ring',
      type: 'circle',
      source: 'resupply',
      filter: ['==', ['get', 'id'], '__none__'],
      paint: {
        'circle-radius': 14,
        'circle-color': '#f2fffc',
        'circle-opacity': 0.12,
        'circle-stroke-color': '#f2fffc',
        'circle-stroke-width': 2,
      },
    },
    {
      id: 'resupply-halo',
      type: 'circle',
      source: 'resupply',
      filter: ['==', ['get', 'usable'], true],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 8, 10, 11, 15, 15],
        'circle-color': resupplyColor(),
        'circle-opacity': 0.22,
      },
    },
    {
      id: 'resupply-points',
      type: 'circle',
      source: 'resupply',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3.5, 10, 5, 15, 7],
        'circle-color': resupplyColor(),
        // A point that is not food is hollow: the visual is the honesty rule.
        'circle-opacity': ['case', ['==', ['get', 'usable'], true], 1, 0.4],
        'circle-stroke-color': ['case', ['==', ['get', 'usable'], true], '#06100f', '#f2fffc'],
        'circle-stroke-width': ['case', ['==', ['get', 'usable'], true], 1.6, 1.8],
      },
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
      'basemap-wms': {
        type: 'raster',
        tiles: [WMS_URL],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 16,
        attribution: '©Kartverket',
      },
      route: { type: 'geojson', data: EMPTY_LINE },
      'route-endpoints': { type: 'geojson', data: EMPTY_POINTS },
      resupply: { type: 'geojson', data: EMPTY_POINTS },
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
  private terrainState: TerrainState = { status: 'probing' };
  private terrainEnabled = false;
  private terrainTiles: string[] | null = null;
  private wmtsErrors = 0;
  private wmtsTileLoaded = false;
  private wmsErrors = 0;
  private wmsTileLoaded = false;
  private terrainErrors = 0;
  private terrainTileLoaded = false;
  private fallbackActive = false;
  private cameraFrame = 0;
  private ready = false;
  private disposed = false;
  private resupply: ResupplyMapPoint[] = [];
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

    const before = this.map.getLayer('route-casing') ? 'route-casing' : undefined;
    this.map.addLayer(
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'terrain-dem',
        paint: {
          'hillshade-exaggeration': 0.24,
          'hillshade-shadow-color': '#08111a',
          'hillshade-highlight-color': '#eef8f6',
          'hillshade-accent-color': '#6fa39d',
          'hillshade-illumination-direction': 315,
          'hillshade-illumination-anchor': 'viewport',
        },
      },
      before,
    );
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

  get basemapKind(): BasemapKind {
    return this.basemap;
  }

  get basemapFallbackActive(): boolean {
    return this.fallbackActive;
  }

  setBasemap(kind: BasemapKind): void {
    this.basemap = kind;
    for (const candidate of ['topo', 'grey', 'wms'] as const) {
      if (this.map.getLayer(`basemap-${candidate}`)) {
        this.map.setLayoutProperty(
          `basemap-${candidate}`,
          'visibility',
          candidate === kind ? 'visible' : 'none',
        );
      }
    }
  }

  /** Retry the WMTS cache after a fallback: rebuilds the failing source. */
  retryBasemap(): void {
    this.wmtsErrors = 0;
    this.wmsErrors = 0;
    this.fallbackActive = false;
    this.wmtsTileLoaded = false;
    this.wmsTileLoaded = false;
    this.terrainErrors = 0;
    for (const kind of ['topo', 'grey'] as const) this.rebuildBasemapSource(kind);
    this.rebuildBasemapSource('wms');
    this.setBasemap(this.basemap === 'wms' ? 'topo' : this.basemap);
    this.map.triggerRepaint();
  }

  private rebuildBasemapSource(kind: BasemapKind): void {
    const sourceId = `basemap-${kind}`;
    const layerId = `basemap-${kind}`;
    if (!this.map.getLayer(layerId)) return;
    const visibility = this.map.getLayoutProperty(layerId, 'visibility') as string | undefined;
    this.map.removeLayer(layerId);
    if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);

    const tileSource: RasterSourceSpecification =
      kind === 'wms'
        ? { type: 'raster', tiles: [WMS_URL], tileSize: 256, minzoom: 0, maxzoom: 16, attribution: '©Kartverket' }
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
          kind === 'grey'
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

  /** Keep rebuilt basemap layers under the hillshade / route layers. */
  private findBasemapAnchor(): string | undefined {
    for (const id of ['hillshade', 'route-casing', 'route-line', 'route-endpoints', 'route-cursor-halo', 'route-cursor']) {
      if (this.map.getLayer(id)) return id;
    }
    return undefined;
  }

  private handleSourceData(event: { sourceId?: string; tile?: unknown; isSourceLoaded?: boolean }): void {
    if (!event.sourceId) return;
    if (event.sourceId === 'basemap-topo' || event.sourceId === 'basemap-grey') {
      if (event.tile) this.wmtsTileLoaded = true;
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
      this.wmtsErrors++;
      if (!this.wmtsTileLoaded && this.wmtsErrors >= 3 && !this.fallbackActive) {
        this.fallbackActive = true;
        this.setBasemap('wms');
        this.callbacks.onBasemapState({
          status: 'fallback',
          requested: this.basemap === 'grey' ? 'grey' : 'topo',
          failedSource: sourceId,
        });
      }
      return;
    }

    if (sourceId === 'basemap-wms') {
      this.wmsErrors++;
      if (!this.wmsTileLoaded && this.wmsErrors >= 3) {
        this.callbacks.onBasemapState({ status: 'failed' });
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

  /** Replace the resupply markers. Safe before the style has loaded. */
  setResupplyPoints(points: readonly ResupplyMapPoint[]): void {
    this.resupply = [...points];
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
    const layer = 'resupply-points';
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
