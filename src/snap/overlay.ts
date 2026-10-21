/**
 * Trail geometry as the map draws it.
 *
 * The whole point of this layer is that it is *the same data the snapper holds*:
 * `SnapIndex.lines` goes in, and what comes out is what the pointer will snap to.
 * "The path you can see is the path that will take you" — no second copy of the
 * network, no inference from the basemap raster, nothing to drift.
 *
 * Two honesty rules are applied here, not in the style:
 *
 *  - a route whose `rutenavn` is Kartverket's placeholder (`"Ukjent"`) has **no**
 *    name; it becomes `null` rather than printing the word "unknown" as if it were
 *    a name (D7: a blank that looks like data is the failure);
 *  - `marked` carries Kartvverket's `merking` flag verbatim (`JA` → true). It is a
 *    property, not a dash pattern, so nothing about the picture asserts a status
 *    the data does not have (D12).
 */
import type { TurruteLine } from './wfs';

/** What the map layer may say about one drawn trail. */
export interface TrailProperties {
  readonly id: string;
  /** The route name, or `null` when Turrutebasen has none (not the literal "Ukjent"). */
  readonly name: string | null;
  /** Kartverket's `merking`: true only for an explicit `JA`. */
  readonly marked: boolean;
}

/** Placeholder names are not names. */
const PLACEHOLDER_NAMES = new Set(['', 'ukjent']);

/**
 * `TurruteLine[]` → a GeoJSON FeatureCollection for the `trails` source.
 *
 * Lines with fewer than two usable vertices are dropped: a one-point "path" cannot
 * be drawn, and it cannot be snapped to either.
 */
export function trailLinesToGeoJson(
  lines: readonly TurruteLine[],
): GeoJSON.FeatureCollection<GeoJSON.LineString, TrailProperties> {
  const features: Array<GeoJSON.Feature<GeoJSON.LineString, TrailProperties>> = [];
  for (const line of lines) {
    const coordinates: Array<[number, number]> = [];
    for (const point of line.coords) {
      if (!Number.isFinite(point.lon) || !Number.isFinite(point.lat)) continue;
      coordinates.push([point.lon, point.lat]);
    }
    if (coordinates.length < 2) continue;

    const name = (line.attributes.rutenavn ?? '').trim();
    features.push({
      type: 'Feature',
      properties: {
        id: line.id,
        name: PLACEHOLDER_NAMES.has(name.toLowerCase()) ? null : name,
        marked: (line.attributes.merking ?? '').trim().toUpperCase() === 'JA',
      },
      geometry: { type: 'LineString', coordinates },
    });
  }
  return { type: 'FeatureCollection', features };
}
