import { describe, expect, it } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';

import { StoreError } from '../../src/contracts';
import type { Trip } from '../../src/contracts';
import { parseGpx } from '../../src/core/gpx';
import { haversine, pathLength } from '../../src/core/geo';
import { parseGpxMetadata } from '../../src/lib/gpx-meta';
import { createTripStore, defaultProfile, emptyTrip } from '../../src/store';
import { otherTrip, syntheticPoints, syntheticTrip } from './helpers';

const store = createTripStore();

const twoTracks = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Two days in Jotunheimen</name></metadata>
  <trk>
    <name>Memurubu–Bessheim</name>
    <trkseg>
      <trkpt lat="61.1072" lon="8.2513"><ele>812.4</ele></trkpt>
      <trkpt lat="61.1989" lon="8.3758"><ele>1130.7</ele></trkpt>
    </trkseg>
  </trk>
  <trk>
    <name>Gjendesheim–Bessheim</name>
    <trkseg>
      <trkpt lat="61.5001" lon="8.8001"><ele>984.2</ele></trkpt>
      <trkpt lat="61.5102" lon="8.8103"/>
      <trkpt lat="61.5203" lon="8.8204"><ele>1052.1</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

/** A trip whose single leg has the given provenance and points. */
function tripWith(
  points: Trip['legs'][number]['points'],
  provenance: Trip['legs'][number]['provenance'],
  extra: Partial<Trip['legs'][number]> = {},
): Trip {
  return {
    ...emptyTrip('Fixture', defaultProfile()),
    legs: [
      { id: 'leg-1', points, provenance, distanceM: 100, ascentM: null, descentM: null, ...extra },
    ],
  };
}

function gpxErrors(xml: string): string[] {
  const errors: string[] = [];
  const parser = new DOMParser({
    onError: (level: string, message: string) => {
      if (level === 'error' || level === 'fatalError') errors.push(`${level}: ${message}`);
    },
  });
  const doc = parser.parseFromString(xml, 'application/xml');
  if (!doc.documentElement) errors.push('no document element');
  return errors;
}

function countTag(xml: string, tag: string): number {
  return xml.match(new RegExp(`<${tag}[\\s>]`, 'g'))?.length ?? 0;
}

function storeErrorCode(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a StoreError');
}

describe('GPX export', () => {
  it('produces well-formed XML — for an empty trip too — and escapes every name and provenance value', () => {
    const xml = store.toGpx(syntheticTrip());
    expect(gpxErrors(xml)).toEqual([]);
    expect(xml).not.toMatch(/<trkseg\s*\/>|<trk\s*\/>|<gpx[^>]*\/>/);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<gpx version="1.1"');
    expect(xml.trimEnd().endsWith('</gpx>')).toBe(true);

    const empty = store.toGpx(emptyTrip('Nothing yet', defaultProfile()));
    expect(gpxErrors(empty)).toEqual([]);
    expect(empty).toContain('<metadata>');
    expect(empty).not.toContain('<trk>');

    const named: Trip = { ...syntheticTrip(), name: 'A & B <test>' };
    const escaped = store.toGpx(named);
    expect(escaped).toContain('<name>A &amp; B &lt;test&gt;</name>');
    expect(escaped).not.toContain('<test>');
    expect(gpxErrors(escaped)).toEqual([]);
    expect(store.fromFile(escaped, 'escaped.gpx').name).toBe('A & B <test>');

    const legName = `Quote " and ' and & <tag> 🏔`;
    const quoted = store.toGpx({
      ...syntheticTrip(),
      legs: [
        {
          ...syntheticTrip().legs[0]!,
          name: legName,
          provenance: [
            { kind: 'turrutebasen', label: `jot21 "north"`, licence: 'CC BY 4.0 ©Kartverket' },
          ],
        },
      ],
    });
    expect(gpxErrors(quoted)).toEqual([]);
    expect(store.fromFile(quoted, 'quotes.gpx').legs[0]!.name).toBe(legName);
  });

  it('writes one <trk> per leg and honours the legIds and includeElevation options', () => {
    const trip = otherTrip();
    const xml = store.toGpx(trip);
    expect(countTag(xml, 'trk')).toBe(2);
    expect(countTag(xml, 'trkseg')).toBe(2);
    expect(gpxErrors(xml)).toEqual([]);
    expect(parseGpx(xml).tracks).toHaveLength(2);

    const onlySecond = store.toGpx(trip, { legIds: ['leg-b'] });
    expect(countTag(onlySecond, 'trk')).toBe(1);
    expect(parseGpx(onlySecond).tracks[0]!.name).toBe('Rondvassbu–Bjørnholia');

    const flat = store.toGpx(trip, { includeElevation: false });
    expect(flat).not.toContain('<ele>');
    expect(countTag(flat, 'trk')).toBe(2);
  });

  it('writes <ele> only where an elevation is known, and a real 0 m is not "unknown"', () => {
    // Mixed trip: the elevation-free leg carries no <ele> at all.
    const mixed = otherTrip();
    const withEle = mixed.legs.flatMap((leg) => leg.points).filter((p) => typeof p.ele === 'number').length;
    const withoutEle = mixed.legs.flatMap((leg) => leg.points).length - withEle;
    expect(withEle).toBeGreaterThan(0);
    expect(withoutEle).toBeGreaterThan(0);
    const mixedXml = store.toGpx(mixed);
    expect(countTag(mixedXml, 'ele')).toBe(withEle);
    const parsed = parseGpx(mixedXml);
    expect(parsed.tracks[1]!.points).toHaveLength(6);
    for (const point of parsed.tracks[1]!.points) expect(point.ele).toBeUndefined();

    const flat = store.toGpx(syntheticTrip(syntheticPoints(5, { elevation: false })));
    expect(flat).not.toContain('<ele>');
    expect(parseGpx(flat).tracks[0]!.points.every((point) => point.ele === undefined)).toBe(true);

    const seaLevel = store.toGpx(
      tripWith([
        { lon: 8, lat: 61, ele: 0, eleSource: 'gpx' },
        { lon: 8.1, lat: 61.1, eleSource: 'none' },
      ], []),
    );
    expect(countTag(seaLevel, 'ele')).toBe(1);
    expect(seaLevel).toContain('<ele>0.0</ele>');
    expect(store.fromFile(seaLevel, 'sea.gpx').legs[0]!.points.map((point) => point.ele)).toEqual([
      0,
      undefined,
    ]);
  });

  it('carries the metadata contract and omits Kartverket attribution when it does not apply', () => {
    const xml = store.toGpx(syntheticTrip());
    const meta = parseGpxMetadata(xml);
    expect(meta.name).toBe('Besseggen over');
    expect(meta.copyright).toBe('Kartverket / Turrutebasen');
    expect(meta.licence).toBe('CC BY 4.0 ©Kartverket');

    // The <desc> is the documented provenance carrier (docs/09 §2).
    const description = meta.description!;
    expect(description).toContain('Leg 1');
    expect(description).toContain('Memurubu–Bessheim');
    expect(description).toContain('kind=turrutebasen');
    expect(description).toContain('jot21');
    expect(description).toContain('Kartverket DTM');
    expect(description).toContain('schemaVersion 1');

    const own = store.toGpx(
      tripWith(syntheticPoints(4, { elevation: false }), [{ kind: 'drawn', label: 'drawn on the map' }]),
    );
    expect(own).not.toContain('©Kartverket');
    expect(own).not.toContain('<copyright');
    expect(own).toContain('none (unknown');
    expect(parseGpxMetadata(own).copyright).toBeUndefined();

    const uploaded = store.toGpx(
      tripWith(
        [
          { lon: 8, lat: 61, ele: 100, eleSource: 'gpx' },
          { lon: 8.1, lat: 61.1, ele: 120.5, eleSource: 'gpx' },
        ],
        [{ kind: 'gpx-upload', label: 'from-file.gpx' }],
        { ascentM: 20.5, descentM: 0 },
      ),
    );
    expect(uploaded).toMatch(/Elevation: gpx \(elevations from the uploaded GPX file/);
    expect(uploaded).toContain('<npl:eleSource>gpx</npl:eleSource>');
  });
});

describe('GPX export/import round-trip (the lossless guarantee)', () => {
  it('preserves distance, the elevation array, per-point provenance and the point sequence', () => {
    const trip = syntheticTrip(syntheticPoints(50));
    const original = trip.legs[0]!;
    const roundTripped = store.fromFile(store.toGpx(trip), 'route.gpx');
    expect(roundTripped.legs).toHaveLength(1);
    const imported = roundTripped.legs[0]!;

    expect(Math.abs(pathLength(imported.points) - original.distanceM!)).toBeLessThan(1);
    expect(imported.points.map((point) => point.ele)).toEqual(original.points.map((point) => point.ele));
    imported.points.forEach((point, index) => {
      expect(haversine(point, original.points[index]!)).toBeLessThan(0.02);
    });
    // The leg id, name and the DEM elevation source survive our own export.
    expect(imported.id).toBe(original.id);
    expect(imported.name).toBe(original.name);
    expect(imported.points.every((point) => point.eleSource === 'dem')).toBe(true);

    // Mixed presence and source, per point, for a two-leg trip.
    const mixed = otherTrip();
    const mixedRoundTrip = store.fromFile(store.toGpx(mixed), 'mixed.gpx');
    expect(mixedRoundTrip.legs).toHaveLength(2);
    mixed.legs.forEach((leg, legIndex) => {
      leg.points.forEach((point, pointIndex) => {
        const got = mixedRoundTrip.legs[legIndex]!.points[pointIndex]!;
        if (typeof point.ele === 'number') {
          expect(got.ele).toBe(point.ele);
          expect(got.eleSource).toBe(point.eleSource);
        } else {
          expect(got.ele).toBeUndefined();
          expect(got.eleSource).toBe('none');
        }
      });
    });

    // A second export of the re-imported trip does not drift.
    const twice = store.fromFile(store.toGpx(roundTripped), 'twice.gpx');
    expect(twice.legs[0]!.points.map((point) => point.ele)).toEqual(
      imported.points.map((point) => point.ele),
    );
    expect(Math.abs(pathLength(twice.legs[0]!.points) - pathLength(imported.points))).toBeLessThan(0.01);
  });

});

describe('GPX import', () => {
  it('turns each track into a leg, computes its metrics and handles legacy, prefixed and route-only files', () => {
    const trip = store.fromFile(twoTracks, 'two-tracks.gpx');
    expect(trip.legs).toHaveLength(2);
    expect(trip.legs[0]!.name).toBe('Memurubu–Bessheim');
    expect(trip.legs[1]!.name).toBe('Gjendesheim–Bessheim');
    expect(trip.legs[0]!.points).toHaveLength(2);
    expect(trip.legs[1]!.points).toHaveLength(3);
    expect(trip.name).toBe('Two days in Jotunheimen');
    expect(trip.schemaVersion).toBe(1);
    expect(trip.profile).toEqual(defaultProfile());
    expect(trip.legs[0]!.provenance[0]!.kind).toBe('gpx-upload');

    const leg = trip.legs[0]!;
    expect(leg.distanceM).toBeGreaterThan(10_000);
    expect(leg.distanceM).toBeLessThan(14_000);
    expect(leg.ascentM).toBeCloseTo(318.3, 1);
    expect(leg.descentM).toBe(0);

    const legacy = `<gpx version="1.0"><trk><name>Legacy</name><trkseg>
      <trkpt lat="61.0" lon="8.0"><ele>100</ele></trkpt>
      <trkpt lat="61.1" lon="8.1"><ele>110</ele></trkpt>
    </trkseg></trk></gpx>`;
    const legacyTrip = store.fromFile(legacy, 'legacy.gpx');
    expect(legacyTrip.legs[0]!.name).toBe('Legacy');
    expect(legacyTrip.legs[0]!.points.map((point) => point.ele)).toEqual([100, 110]);

    const prefixed = legacy
      .replace('<gpx ', '<gpx:gpx xmlns:gpx="http://www.topografix.com/GPX/1/1" ')
      .replace('</gpx>', '</gpx:gpx>');
    expect(store.fromFile(prefixed, 'prefixed.gpx').legs).toHaveLength(1);

    const planned = store.fromFile(
      `<gpx version="1.1"><rte><name>Planned</name>
        <rtept lat="61.0" lon="8.0"/><rtept lat="61.1" lon="8.1"/>
      </rte></gpx>`,
      'planned.gpx',
    );
    expect(planned.legs).toHaveLength(1);
    expect(planned.legs[0]!.name).toBe('Planned');

    const flat = store.fromFile(
      `<gpx version="1.0"><trk><trkseg>
        <trkpt lat="61.0" lon="8.0"/><trkpt lat="61.1" lon="8.1"/>
      </trkseg></trk></gpx>`,
      'flat.gpx',
    );
    expect(flat.legs[0]!.points.map((point) => point.ele)).toEqual([undefined, undefined]);
    expect(flat.legs[0]!.points.every((point) => point.eleSource === 'none')).toBe(true);
    expect(flat.legs[0]!.ascentM).toBeNull();
    expect(flat.legs[0]!.descentM).toBeNull();
  });

  it('rejects malformed XML, a line-less file and unsupported extensions as StoreError', () => {
    const corrupt = [
      '<gpx><trk><trkseg>',
      '<gpx version="1.1"><metadata><name>x</name></metadata></gpx>',
    ];
    for (const text of corrupt) {
      const thrown = storeErrorCode(() => store.fromFile(text, 'broken.gpx'));
      expect(thrown).toBeInstanceOf(StoreError);
      expect((thrown as StoreError).code).toBe('corrupt');
    }

    for (const filename of ['route.kml', 'route.fit', 'route.txt', 'route']) {
      const thrown = storeErrorCode(() => store.fromFile('<whatever/>', filename));
      expect(thrown).toBeInstanceOf(StoreError);
      expect((thrown as StoreError).code).toBe('unsupported');
    }
  });
});

describe('leg metrics honesty', () => {
  it('reports no ascent when only part of the leg has elevation', () => {
    // Regression from the engine review: a partial sum used to be presented as
    // the leg's ascent, which reads as a complete measurement of a smaller climb.
    const points = [
      { lon: 8.3, lat: 61.5, ele: 1000, eleSource: 'dem' as const },
      { lon: 8.31, lat: 61.5, ele: 1100, eleSource: 'dem' as const },
      { lon: 8.32, lat: 61.5 },
      { lon: 8.33, lat: 61.5, ele: 1400, eleSource: 'dem' as const },
    ];
    const trip = store.fromFile(
      `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="t" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>${points
        .map((p) => `<trkpt lat="${p.lat}" lon="${p.lon}">${p.ele !== undefined ? `<ele>${p.ele}</ele>` : ''}</trkpt>`)
        .join('')}</trkseg></trk></gpx>`,
      'partial.gpx',
    );
    expect(trip.legs[0]!.ascentM).toBeNull();
    expect(trip.legs[0]!.descentM).toBeNull();
  });
});
