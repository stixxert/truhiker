import { describe, expect, it } from 'vitest';

import { StoreError } from '../../src/contracts';
import { pathLength } from '../../src/core/geo';
import { createTripStore, defaultProfile, emptyTrip } from '../../src/store';
import { otherTrip, syntheticPoints, syntheticTrip } from './helpers';

const store = createTripStore();

interface Feature {
  type: string;
  geometry: { type: string; coordinates: unknown[] };
  properties: Record<string, unknown>;
}

function parse(text: string): { type: string; features: Feature[]; name?: string } {
  return JSON.parse(text) as { type: string; features: Feature[]; name?: string };
}

function errorOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('GeoJSON export', () => {
  it('is a FeatureCollection with one LineString per leg, carrying leg id, name and provenance', () => {
    const geo = parse(store.toGeoJson(otherTrip()));
    expect(geo.type).toBe('FeatureCollection');
    expect(geo.name).toBe('Rondane weekend');
    expect(geo.features).toHaveLength(2);
    for (const feature of geo.features) {
      expect(feature.type).toBe('Feature');
      expect(feature.geometry.type).toBe('LineString');
    }

    const trip = syntheticTrip();
    const [feature] = parse(store.toGeoJson(trip)).features;
    expect(feature!.properties.legId).toBe('leg-1');
    expect(feature!.properties.name).toBe('Memurubu–Bessheim');
    expect(feature!.properties.provenance).toEqual(trip.legs[0]!.provenance);
    expect(feature!.properties.distanceM).toBeCloseTo(trip.legs[0]!.distanceM!, 3);
    expect(feature!.properties.elevationSources).toEqual(['dem']);
  });

  it('writes a 3D ordinate only where an elevation exists, with the real value', () => {
    const trip = otherTrip();
    const [withElevation, without] = parse(store.toGeoJson(trip)).features;
    for (const coordinate of withElevation!.geometry.coordinates) expect(coordinate).toHaveLength(3);
    for (const coordinate of without!.geometry.coordinates) expect(coordinate).toHaveLength(2);

    const source = trip.legs[0]!.points;
    (withElevation!.geometry.coordinates as number[][]).forEach((coordinate, index) => {
      expect(coordinate[0]).toBeCloseTo(source[index]!.lon, 6);
      expect(coordinate[1]).toBeCloseTo(source[index]!.lat, 6);
      expect(coordinate[2]).toBe(source[index]!.ele);
    });

    // A per-point mix of 2D and 3D coordinates in one leg.
    const mixed = {
      ...emptyTrip('Partial elevation', defaultProfile()),
      legs: [
        {
          id: 'leg-mixed',
          name: 'Half measured',
          points: [
            { lon: 8, lat: 61, ele: 500, eleSource: 'dem' as const },
            { lon: 8.1, lat: 61.1, eleSource: 'none' as const },
            { lon: 8.2, lat: 61.2, ele: 640.5, eleSource: 'dem' as const },
          ],
          provenance: [],
          distanceM: 100,
          ascentM: null,
          descentM: null,
        },
      ],
    };
    expect(
      parse(store.toGeoJson(mixed)).features[0]!.geometry.coordinates.map(
        (coordinate) => (coordinate as number[]).length,
      ),
    ).toEqual([3, 2, 3]);
  });
});

describe('GeoJSON import', () => {
  it('reads our own export back', () => {
    const trip = syntheticTrip();
    const imported = store.fromFile(store.toGeoJson(trip), 'trip.geojson');

    expect(imported.name).toBe('Besseggen over');
    expect(imported.legs).toHaveLength(1);
    expect(imported.legs[0]!.id).toBe('leg-1');
    expect(imported.legs[0]!.name).toBe('Memurubu–Bessheim');
    expect(imported.legs[0]!.provenance[0]!.kind).toBe('turrutebasen');
    expect(imported.legs[0]!.points.map((point) => point.ele)).toEqual(
      trip.legs[0]!.points.map((point) => point.ele),
    );
    expect(Math.abs(pathLength(imported.legs[0]!.points) - trip.legs[0]!.distanceM!)).toBeLessThan(1);
  });

  it('accepts a bare Feature, a bare geometry, a MultiLineString and the .json extension', () => {
    const bare = {
      type: 'Feature',
      properties: { name: 'Bare feature' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [8.1, 61.1],
          [8.2, 61.2, 1100],
        ],
      },
    };
    const fromFeature = store.fromFile(JSON.stringify(bare), 'one.geojson');
    expect(fromFeature.legs).toHaveLength(1);
    expect(fromFeature.legs[0]!.name).toBe('Bare feature');
    expect(fromFeature.legs[0]!.points.map((point) => point.ele)).toEqual([undefined, 1100]);
    expect(fromFeature.legs[0]!.points[0]!.eleSource).toBe('none');
    expect(fromFeature.legs[0]!.points[1]!.eleSource).toBe('gpx');

    const fromGeometry = store.fromFile(JSON.stringify(bare.geometry), 'bare.json');
    expect(fromGeometry.legs).toHaveLength(1);
    expect(fromGeometry.name).toBe('bare');

    const multi = {
      type: 'FeatureCollection',
      name: 'Two lines',
      features: [
        {
          type: 'Feature',
          properties: { name: 'Pair' },
          geometry: {
            type: 'MultiLineString',
            coordinates: [
              [
                [8.1, 61.1],
                [8.2, 61.2],
              ],
              [
                [9.1, 62.1],
                [9.2, 62.2],
              ],
            ],
          },
        },
      ],
    };
    const split = store.fromFile(JSON.stringify(multi), 'multi.geojson');
    expect(split.legs).toHaveLength(2);
    expect(split.legs.map((leg) => leg.name)).toEqual(['Pair (1)', 'Pair (2)']);

    expect(store.fromFile(store.toGeoJson(syntheticTrip(syntheticPoints(4))), 'route.json').legs[0]!.points).toHaveLength(4);
  });

  it('rejects malformed JSON, non-numeric coordinates, a Point and a single-point line', () => {
    const malformed = errorOf(() => store.fromFile('{ not json', 'bad.geojson'));
    expect((malformed as StoreError).code).toBe('corrupt');

    const nonNumeric = errorOf(() =>
      store.fromFile(
        JSON.stringify({
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: [
              ['8.1', '61.1'],
              [8.2, 61.2],
            ],
          },
        }),
        'bad.geojson',
      ),
    );
    expect((nonNumeric as StoreError).code).toBe('corrupt');

    const point = errorOf(() =>
      store.fromFile(
        JSON.stringify({
          type: 'FeatureCollection',
          features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [8, 61] } }],
        }),
        'points.geojson',
      ),
    );
    expect((point as StoreError).code).toBe('unsupported');

    const single = errorOf(() =>
      store.fromFile(
        JSON.stringify({
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: [[8.1, 61.1]] },
        }),
        'single.json',
      ),
    );
    expect((single as StoreError).code).toBe('corrupt');
  });
});
