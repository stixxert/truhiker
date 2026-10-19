import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseGpx } from '../src/core/gpx';

const twoTracks = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>First track</name>
    <trkseg>
      <trkpt lat="61.0" lon="8.0"><ele>100</ele></trkpt>
      <trkpt lat="61.1" lon="8.1"/>
    </trkseg>
    <trkseg>
      <trkpt lat="61.2" lon="8.2"><ele>120.5</ele></trkpt>
    </trkseg>
  </trk>
  <trk>
    <name>Second track</name>
    <trkseg>
      <trkpt lat="62.0" lon="9.0"><ele>-5</ele></trkpt>
      <trkpt lat="62.1" lon="9.1"><ele>oops</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

describe('parseGpx', () => {
  it('keeps tracks separate, concatenates segments within a track and ignores an invalid <ele>', () => {
    const doc = parseGpx(twoTracks);

    expect(doc.tracks).toHaveLength(2);
    expect(doc.tracks[0].name).toBe('First track');
    expect(doc.tracks[0].points).toHaveLength(3); // both segments, one track
    expect(doc.tracks[1].name).toBe('Second track');
    expect(doc.tracks[1].points).toHaveLength(2);

    expect(doc.tracks[0].points[0]).toEqual({ lon: 8, lat: 61, ele: 100 });
    expect(doc.tracks[0].points[1]).toEqual({ lon: 8.1, lat: 61.1 });
    expect(doc.tracks[1].points[0].ele).toBe(-5);
    // Invalid <ele> is ignored, not turned into NaN.
    expect(doc.tracks[1].points[1].ele).toBeUndefined();
    expect(Number.isFinite(doc.tracks[1].points[1].lat)).toBe(true);
  });

  it('repairs an undeclared namespace prefix and parses routes and waypoints separately', () => {
    // Real-world exports do this. xmldom rejects it as a fatal NamespaceError;
    // the parser repairs undeclared prefixes and retries.
    const broken = `<?xml version="1.0"?>
<gpx:gpx version="1.1" creator="test">
  <gpx:trk>
    <gpx:name>Broken namespaces</gpx:name>
    <gpx:trkseg>
      <gpx:trkpt lat="61.6363" lon="8.3124"><gpx:ele>2469</gpx:ele></gpx:trkpt>
      <gpx:trkpt lat="61.6370" lon="8.3130"/>
    </gpx:trkseg>
  </gpx:trk>
</gpx:gpx>`;
    const doc = parseGpx(broken);
    expect(doc.tracks).toHaveLength(1);
    expect(doc.tracks[0].name).toBe('Broken namespaces');
    expect(doc.tracks[0].points).toEqual([
      { lon: 8.3124, lat: 61.6363, ele: 2469 },
      { lon: 8.313, lat: 61.637 },
    ]);

    const withRoute = parseGpx(`<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="61.5" lon="8.5"><name>Start</name></wpt>
  <rte>
    <name>Route</name>
    <rtept lat="61.5" lon="8.5"/>
    <rtept lat="61.6" lon="8.6"/>
  </rte>
</gpx>`);
    expect(withRoute.tracks).toHaveLength(0);
    expect(withRoute.routes).toHaveLength(1);
    expect(withRoute.routes[0].name).toBe('Route');
    expect(withRoute.routes[0].points).toHaveLength(2);
    expect(withRoute.waypoints).toHaveLength(1);
    expect(withRoute.waypoints[0]).toEqual({ lon: 8.5, lat: 61.5 });
  });

  it('parses the committed live-anchor fixture', () => {
    const path = fileURLToPath(new URL('./fixtures/galdhopiggen.gpx', import.meta.url));
    const doc = parseGpx(readFileSync(path, 'utf8'));
    expect(doc.tracks).toHaveLength(1);
    expect(doc.tracks[0].name).toBe('Galdhøpiggen');
    expect(doc.tracks[0].points).toHaveLength(6);
    expect(doc.tracks[0].points[4].lon).toBeCloseTo(8.3124, 6);
    expect(doc.tracks[0].points[4].lat).toBeCloseTo(61.6363, 6);
  });

  it('fails loudly on unparseable XML, a missing coordinate, a non-GPX root and an empty document', () => {
    expect(() => parseGpx('<gpx><trk><trkpt lat="61" lon="8"></gpx>')).toThrow(/could not parse/);
    expect(() => parseGpx('<gpx><trk><trkseg><trkpt lat="61"/></trkseg></trk></gpx>')).toThrow(
      /missing lat\/lon/,
    );
    expect(() => parseGpx('<kml><Placemark/></kml>')).toThrow(/root element/);
    expect(() => parseGpx('<gpx version="1.1"></gpx>')).toThrow(/no tracks, routes or waypoints/);
  });
});
