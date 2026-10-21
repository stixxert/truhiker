/**
 * Map interaction for drawing and editing.
 *
 * Three modes, one canvas:
 *
 *  - **Vis** — no interaction beyond the normal map drag.
 *  - **Tegn** — a click adds a point; with snapping on, the point is moved to
 *    the nearest trail within the radius and the leg records `snapped`.
 *  - **Rediger** — click a vertex handle to select it, drag it to move it
 *    (re-snapping on drop), click a segment to insert a vertex there.
 *
 * Off-trail stretches are drawn dashed in the map and listed in the toolbar
 * (`offtrail-chip`), because the style has no glyph server and a symbol layer
 * would need one. The label is text in the DOM, which is also more accessible
 * than text painted into WebGL.
 *
 * Hit-testing uses screen-space distance, not degrees: at 390 px a 75 m radius
 * is a fraction of a pixel, so a degree-based hit test would select a different
 * vertex depending only on latitude.
 */

import type {
  GeoJSONSource,
  Map as MapLibreMapType,
  MapLayerMouseEvent,
  MapMouseEvent,
} from 'maplibre-gl';

import type { RoutePoint, Trip } from '../contracts';
import type { LonLat } from '../core/geo';
import type { SnapResult } from '../snap';
import type { InteractionMode, VertexSelection } from '../app/editor-state';
import { insertionIndexForClick } from '../app/editor-state';
import { findLeg, flattenTrip } from '../lib/trip-route';

export interface OffTrailSegment {
  readonly from: LonLat;
  readonly to: LonLat;
}

interface EditOverlayDeps {
  map: MapLibreMapType;
  getTrip: () => Trip | null;
  isSnapping: () => boolean;
  snap: (point: LonLat) => SnapResult | null;
  onDrawPoint: (point: LonLat, snap: SnapResult | null) => void;
  onSelect: (legId: string, index: number, extend: boolean) => void;
  onMoveVertex: (legId: string, index: number, point: LonLat, snap: SnapResult | null) => void;
  onInsertPoint: (
    legId: string,
    index: number,
    point: LonLat,
    snap: SnapResult | null,
  ) => void;
  onSnapIndicator: (snap: SnapResult | null, hovering: boolean) => void;
  /** A click while the editor is picking route endpoints. */
  onRoutePoint: (point: LonLat) => void;
  /**
   * The point a new click would extend from — the active leg's last vertex.
   * `null` when there is nothing to extend (no leg yet, or only the placeholder).
   */
  getDrawAnchor?: () => LonLat | null;
  /** A double-click in draw mode: the leg is finished, leave drawing. */
  onFinishDraw?: () => void;
}

const SOURCE_HANDLES = 'edit-handles';
const SOURCE_OFFTRAIL = 'edit-offtrail';
const SOURCE_SNAP = 'edit-snap';
const SOURCE_HIT = 'edit-hittest';
const SOURCE_DRAFT = 'edit-draft';

const LAYER_OFFTRAIL = 'edit-offtrail-line';
const LAYER_HIT = 'edit-hittest-line';
const LAYER_HANDLES = 'edit-handles-circle';
const LAYER_SNAP = 'edit-snap-circle';
const LAYER_DRAFT = 'edit-draft-line';
const SOURCE_PICK = 'route-pick';
const LAYER_PICK = 'route-pick-circle';

const EMPTY: GeoJSON.FeatureCollection<GeoJSON.Geometry> = {
  type: 'FeatureCollection',
  features: [],
};

/** Minimum screen distance between two drawn handles, pixels. */
const HANDLE_SPACING_PX = 16;

export class EditOverlay {
  private readonly deps: EditOverlayDeps;
  private readonly map: MapLibreMapType;
  private mode: InteractionMode = 'view';
  private enabled = false;
  private installed = false;
  private drag: { legId: string; index: number } | null = null;
  private previewPoint: LonLat | null = null;
  private routeMode = false;
  private suppressedClick = false;
  private selection: VertexSelection | null = null;

  /**
   * `mapReady` is the caller's guarantee that `load` has already fired (the app
   * awaits `whenReady()` first). Waiting for `load` again never resolves:
   * `isStyleLoaded()` can briefly report false after it, and the event does not
   * fire twice. That made every map edit silently inert.
   */
  constructor(deps: EditOverlayDeps, options: { readonly mapReady?: boolean } = {}) {
    this.deps = deps;
    this.map = deps.map;
    if (options.mapReady || this.map.isStyleLoaded()) this.install();
    else this.map.once('load', () => this.install());
  }

  private install(): void {
    if (this.installed) return;
    const map = this.map;
    if (!map.getSource(SOURCE_HANDLES)) map.addSource(SOURCE_HANDLES, { type: 'geojson', data: EMPTY });
    if (!map.getSource(SOURCE_OFFTRAIL)) map.addSource(SOURCE_OFFTRAIL, { type: 'geojson', data: EMPTY });
    if (!map.getSource(SOURCE_SNAP)) map.addSource(SOURCE_SNAP, { type: 'geojson', data: EMPTY });
    if (!map.getSource(SOURCE_HIT)) map.addSource(SOURCE_HIT, { type: 'geojson', data: EMPTY });
    if (!map.getSource(SOURCE_PICK)) map.addSource(SOURCE_PICK, { type: 'geojson', data: EMPTY });
    if (!map.getSource(SOURCE_DRAFT)) map.addSource(SOURCE_DRAFT, { type: 'geojson', data: EMPTY });

    if (!map.getLayer(LAYER_OFFTRAIL)) {
      map.addLayer({
        id: LAYER_OFFTRAIL,
        type: 'line',
        source: SOURCE_OFFTRAIL,
        layout: { 'line-join': 'round', 'line-cap': 'butt' },
        paint: {
          'line-color': '#e3b269',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2, 14, 4.5],
          'line-dasharray': [1.4, 1.6],
          'line-opacity': 0.95,
        },
      });
    }

    if (!map.getLayer(LAYER_HIT)) {
      map.addLayer({
        id: LAYER_HIT,
        type: 'line',
        source: SOURCE_HIT,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#000000', 'line-width': 22, 'line-opacity': 0 },
      });
    }

    if (!map.getLayer(LAYER_PICK)) {
      map.addLayer({
        id: LAYER_PICK,
        type: 'circle',
        source: SOURCE_PICK,
        paint: {
          'circle-radius': 7,
          'circle-color': '#f2fffc',
          'circle-stroke-color': '#e3b269',
          'circle-stroke-width': 3,
        },
      });
    }

    if (!map.getLayer(LAYER_SNAP)) {
      map.addLayer({
        id: LAYER_SNAP,
        type: 'circle',
        source: SOURCE_SNAP,
        paint: {
          'circle-radius': 7,
          'circle-color': '#4fae9c',
          'circle-opacity': 0.35,
          'circle-stroke-color': '#f2fffc',
          'circle-stroke-width': 1.6,
        },
      });
    }

    if (!map.getLayer(LAYER_DRAFT)) {
      map.addLayer({
        id: LAYER_DRAFT,
        type: 'line',
        source: SOURCE_DRAFT,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        // A preview, not a route: quiet enough that it cannot be mistaken for
        // committed geometry, solid so it is not confused with the dashed
        // off-trail styling.
        paint: {
          'line-color': '#f2fffc',
          'line-opacity': 0.55,
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.2, 14, 2.2],
        },
      });
    }

    if (!map.getLayer(LAYER_HANDLES)) {
      map.addLayer({
        id: LAYER_HANDLES,
        type: 'circle',
        source: SOURCE_HANDLES,
        paint: {
          'circle-radius': ['case', ['==', ['get', 'selected'], true], 6.5, 3.2],
          'circle-color': ['case', ['==', ['get', 'selected'], true], '#f2fffc', '#0b1416'],
          'circle-stroke-color': ['case', ['==', ['get', 'selected'], true], '#4fae9c', 'rgba(242,255,252,0.9)'],
          'circle-stroke-width': ['case', ['==', ['get', 'selected'], true], 2, 1.3],
        },
      });
    }

    map.on('click', this.onClick);
    map.on('mousemove', this.onMouseMove);
    map.on('mouseup', this.onMouseUp);
    map.on('mouseout', this.onMouseLeave);
    map.on('mousedown', LAYER_HANDLES, this.onHandleDown);
    map.on('dblclick', this.onDoubleClick);
    map.on('moveend', this.onCameraChange);
    map.on('zoomend', this.onCameraChange);
    this.installed = true;
  }

  // -------------------------------------------------------------------------
  // Public state
  // -------------------------------------------------------------------------

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.updateCursor();
    if (!enabled) {
      this.hideSnapPreview();
      this.deps.onSnapIndicator(null, false);
    }
  }

  setMode(mode: InteractionMode): void {
    this.mode = mode;
    this.drag = null;
    this.hideSnapPreview();
    this.updateDraft(null);
    this.deps.onSnapIndicator(null, false);
    // Double-click is the finish gesture while drawing, so it must not also zoom
    // the map out from under the point that was just placed.
    if (mode === 'draw') this.map.doubleClickZoom.disable();
    else this.map.doubleClickZoom.enable();
    this.updateCursor();
    this.rebuildHandles();
  }

  setTrip(trip: Trip | null): void {
    this.updateHitData(trip);
    this.rebuildHandles();
    // The anchor may have moved (undo, delete, another leg): a stale preview
    // would point at a vertex that is no longer there.
    this.updateDraft(null);
  }

  /** Pick two endpoints for a route; clicks stop editing the trip. */
  setRouteMode(active: boolean): void {
    this.routeMode = active;
    this.drag = null;
    this.hideSnapPreview();
    this.deps.onSnapIndicator(null, false);
    if (!active) this.setRoutePick(null, null);
    this.updateCursor();
  }

  /** Show the chosen endpoints (start while picking the end). */
  setRoutePick(start: LonLat | null, end: LonLat | null): void {
    const source = this.map.getSource(SOURCE_PICK);
    if (!source || !('setData' in source)) return;
    const features = [start, end]
      .filter((point): point is LonLat => point !== null)
      .map((point) => ({
        type: 'Feature' as const,
        properties: { role: point === start ? 'start' : 'end' },
        geometry: { type: 'Point' as const, coordinates: [point.lon, point.lat] },
      }));
    (source as GeoJSONSource).setData({ type: 'FeatureCollection', features });
  }

  setSelection(selection: VertexSelection | null): void {
    this.selection = selection;
    this.rebuildHandles();
  }

  setOffTrail(segments: readonly OffTrailSegment[]): void {
    const source = this.map.getSource(SOURCE_OFFTRAIL);
    if (!source || !('setData' in source)) return;
    (source as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: segments.map((segment) => ({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [
            [segment.from.lon, segment.from.lat],
            [segment.to.lon, segment.to.lat],
          ],
        },
      })),
    });
  }

  dispose(): void {
    if (!this.installed) return;
    this.map.off('click', this.onClick);
    this.map.off('mousemove', this.onMouseMove);
    this.map.off('mouseup', this.onMouseUp);
    this.map.off('mouseout', this.onMouseLeave);
    this.map.off('mousedown', LAYER_HANDLES, this.onHandleDown);
    this.map.off('moveend', this.onCameraChange);
    this.map.off('zoomend', this.onCameraChange);
    this.installed = false;
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  private updateHitData(trip: Trip | null): void {
    const source = this.map.getSource(SOURCE_HIT);
    if (!source || !('setData' in source)) return;
    const features: Array<GeoJSON.Feature<GeoJSON.LineString>> = [];
    for (const leg of trip?.legs ?? []) {
      if (leg.points.length < 2) continue;
      features.push({
        type: 'Feature',
        properties: { legId: leg.id },
        geometry: {
          type: 'LineString',
          coordinates: leg.points.map((point) => [point.lon, point.lat]),
        },
      });
    }
    (source as GeoJSONSource).setData({ type: 'FeatureCollection', features });
  }

  /**
   * Rebuild the vertex handles, thinning them so a 1,164-point GPX does not
   * become 1,164 circles on screen (and 1,164 hit targets under the pointer).
   */
  private rebuildHandles(): void {
    const source = this.map.getSource(SOURCE_HANDLES);
    if (!source || !('setData' in source)) return;
    const trip = this.deps.getTrip();
    const features: Array<GeoJSON.Feature<GeoJSON.Point>> = [];
    if (trip && this.mode === 'edit') {
      const flat = flattenTrip(trip);
      let lastX = Number.NEGATIVE_INFINITY;
      let lastY = Number.NEGATIVE_INFINITY;
      for (const span of flat.spans) {
        const leg = findLeg(trip, span.legId);
        if (!leg) continue;
        for (let index = 0; index < leg.points.length; index++) {
          const point = leg.points[index];
          const projected = this.map.project([point.lon, point.lat]);
          const selected =
            this.selection !== null &&
            this.selection.legId === span.legId &&
            (this.selection.from === index || this.selection.to === index);
          const farEnough =
            Math.abs(projected.x - lastX) >= HANDLE_SPACING_PX ||
            Math.abs(projected.y - lastY) >= HANDLE_SPACING_PX;
          if (selected || farEnough) {
            features.push({
              type: 'Feature',
              properties: { legId: span.legId, index, selected },
              geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
            });
            lastX = projected.x;
            lastY = projected.y;
          }
        }
      }
    }
    (source as GeoJSONSource).setData({ type: 'FeatureCollection', features });
  }

  // -------------------------------------------------------------------------
  // Interaction
  // -------------------------------------------------------------------------

  private onClick = (event: MapMouseEvent): void => {
    if (!this.enabled || !this.installed) return;
    if (this.routeMode) {
      this.deps.onRoutePoint({ lon: event.lngLat.lng, lat: event.lngLat.lat });
      return;
    }
    if (this.mode === 'view') return;
    if (this.suppressedClick) {
      this.suppressedClick = false;
      return;
    }
    const point: LonLat = { lon: event.lngLat.lng, lat: event.lngLat.lat };
    if (this.mode === 'draw') {
      const snap = this.deps.snap(point);
      this.deps.onDrawPoint(snap ? snap.snappedPoint : point, snap);
      this.updateDraft(null);
      return;
    }

    // Edit mode. A handle click already selected on mousedown.
    if (this.map.getLayer(LAYER_HANDLES)) {
      const handles = this.map.queryRenderedFeatures(event.point, { layers: [LAYER_HANDLES] });
      if (handles.length > 0) return;
    }
    if (!this.map.getLayer(LAYER_HIT)) return;
    const hit = this.map.queryRenderedFeatures(event.point, { layers: [LAYER_HIT] });
    const legId = hit.length > 0 ? String(hit[0].properties?.legId ?? '') : '';
    const leg = findLeg(this.deps.getTrip(), legId);
    if (!leg) return;
    const index = insertionIndexForClick(leg.points, point, (candidate: RoutePoint) => {
      const projected = this.map.project([candidate.lon, candidate.lat]);
      return { x: projected.x, y: projected.y };
    });
    const snap = this.deps.snap(point);
    this.deps.onInsertPoint(legId, index, snap ? snap.snappedPoint : point, snap);
  };

  private onHandleDown = (event: MapLayerMouseEvent): void => {
    if (!this.enabled || this.routeMode || this.mode !== 'edit') return;
    const feature = event.features?.[0];
    if (!feature) return;
    const legId = String(feature.properties?.legId ?? '');
    const index = Number(feature.properties?.index ?? -1);
    if (legId.length === 0 || !Number.isInteger(index) || index < 0) return;
    event.preventDefault();
    this.drag = { legId, index };
    this.previewPoint = { lon: event.lngLat.lng, lat: event.lngLat.lat };
    this.suppressedClick = true;
    // The click event that follows this mouseup belongs to the drag, not to a
    // new point. Clear the flag shortly after so the *next* click is normal.
    window.setTimeout(() => {
      this.suppressedClick = false;
    }, 60);
    this.map.dragPan.disable();
    const original = event.originalEvent as MouseEvent | undefined;
    this.deps.onSelect(legId, index, Boolean(original?.shiftKey));
  };

  private onMouseMove = (event: MapMouseEvent): void => {
    if (!this.enabled || !this.installed) return;
    const point: LonLat = { lon: event.lngLat.lng, lat: event.lngLat.lat };
    if (this.drag) {
      this.previewPoint = point;
      this.showSnapPreview(point);
      return;
    }
    if (this.mode !== 'draw' && this.mode !== 'edit') return;
    if (!this.deps.isSnapping()) {
      this.hideSnapPreview();
      this.updateDraft(point);
      this.deps.onSnapIndicator(null, true);
      return;
    }
    const snap = this.deps.snap(point);
    this.showSnapPreview(snap ? snap.snappedPoint : null);
    this.updateDraft(snap ? snap.snappedPoint : point);
    this.deps.onSnapIndicator(snap, true);
  };

  private onMouseUp = (): void => {
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;
    this.map.dragPan.enable();
    const point = this.previewPoint;
    this.previewPoint = null;
    this.hideSnapPreview();
    if (!point) return;
    const snap = this.deps.snap(point);
    this.deps.onMoveVertex(drag.legId, drag.index, snap ? snap.snappedPoint : point, snap);
  };

  private onMouseLeave = (): void => {
    this.hideSnapPreview();
    this.updateDraft(null);
    if (!this.drag) this.deps.onSnapIndicator(null, false);
  };

  private onDoubleClick = (): void => {
    if (!this.enabled || this.mode !== 'draw') return;
    this.updateDraft(null);
    // Defer the mode change by a tick: MapLibre's own double-click zoom is a
    // listener on the same event, and leaving draw mode re-enables it. Finishing
    // synchronously let that handler fire *after* it was re-enabled, so every
    // finished leg also zoomed the map in (measured: 11.56 -> 14.28).
    setTimeout(() => this.deps.onFinishDraw?.(), 0);
  };

  /**
   * The segment the next click would commit: anchor → cursor.
   *
   * `cursor` is the *snapped* point, so the line shows where the point will land
   * rather than where the pointer is — which is the whole question the gesture is
   * asking. Nothing is drawn when there is no anchor (a new trip) or when the
   * cursor is the anchor itself.
   */
  private updateDraft(cursor: LonLat | null): void {
    const source = this.map.getSource(SOURCE_DRAFT);
    if (!source || !('setData' in source)) return;
    const anchor = this.mode === 'draw' ? this.deps.getDrawAnchor?.() ?? null : null;
    const drawable =
      anchor !== null &&
      cursor !== null &&
      Number.isFinite(cursor.lon) &&
      Number.isFinite(cursor.lat) &&
      (anchor.lon !== cursor.lon || anchor.lat !== cursor.lat);
    (source as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: drawable
        ? [
            {
              type: 'Feature',
              properties: {},
              geometry: {
                type: 'LineString',
                coordinates: [
                  [anchor.lon, anchor.lat],
                  [cursor.lon, cursor.lat],
                ],
              },
            },
          ]
        : [],
    });
  }

  private onCameraChange = (): void => {
    if (this.drag) return;
    this.rebuildHandles();
  };

  // -------------------------------------------------------------------------
  // Preview helpers
  // -------------------------------------------------------------------------

  private showSnapPreview(point: LonLat | null): void {
    const source = this.map.getSource(SOURCE_SNAP);
    if (!source || !('setData' in source)) return;
    (source as GeoJSONSource).setData(
      point === null
        ? { type: 'FeatureCollection', features: [] }
        : {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {},
                geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
              },
            ],
          },
    );
  }

  private hideSnapPreview(): void {
    this.showSnapPreview(null);
  }

  private updateCursor(): void {
    const canvas = this.map.getCanvas();
    if (!canvas) return;
    canvas.style.cursor =
      this.enabled && (this.routeMode || this.mode === 'draw' || this.mode === 'edit')
        ? 'crosshair'
        : '';
  }
}
