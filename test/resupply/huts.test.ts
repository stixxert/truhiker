/**
 * `fetchHutsAlong` — the `app:RuteInfoPunkt` client.
 *
 * Offline: `fetchImpl` is injected and returns a hand-written GML document
 * shaped like the real response (namespace prefixes, `gml:pos` in lat,lon).
 */

import { describe, expect, it } from 'vitest';

import type { LonLat } from '../../src/core/geo';
import { WFS_ENDPOINT } from '../../src/snap/wfs';
import {
  HUT_TYPE_NAME,
  fetchHutsAlong,
  fetchHutsInBounds,
  hutGetFeatureUrl,
  parseHutGml,
} from '../../src/resupply';

/** A route heading east at 61.4 N, 8.2 E → 8.3 E (≈5.3 km). */
const ROUTE: LonLat[] = [
  { lon: 8.2, lat: 61.4 },
  { lon: 8.3, lat: 61.4 },
];

/** Fondsbu-shaped waypoint: 30 m north of the route, roughly half way along. */
const GML = `<?xml version="1.0" encoding="UTF-8"?>
<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0"
    xmlns:app="http://skjema.geonorge.no/SOSI/produktspesifikasjon/TurOgFriluftsruter/20171210"
    xmlns:gml="http://www.opengis.net/gml/3.2" numberMatched="unknown" numberReturned="0">
  <wfs:member>
    <app:RuteInfoPunkt gml:id="ruteinfopunkt.1">
      <app:identifikasjon>
        <app:Identifikasjon>
          <app:lokalId>9f1b0a8e-0000-4000-8000-000000000001</app:lokalId>
        </app:Identifikasjon>
      </app:identifikasjon>
      <app:oppdateringsdato>2026-09-02T11:00:35</app:oppdateringsdato>
      <app:opphav>Fondsbu</app:opphav>
      <app:vedlikeholdsansvarlig>DNT | DNT Oslo og omegn</app:vedlikeholdsansvarlig>
      <app:tilrettelegging>42</app:tilrettelegging>
      <app:geometri>
        <gml:Point gml:id="ruteinfopunkt.1_POSISJON" srsName="urn:ogc:def:crs:EPSG::4258">
          <gml:pos>61.4003 8.25</gml:pos>
        </gml:Point>
      </app:geometri>
    </app:RuteInfoPunkt>
  </wfs:member>
  <wfs:member>
    <app:RuteInfoPunkt gml:id="ruteinfopunkt.2">
      <app:opphav>Ukjent</app:opphav>
      <app:vedlikeholdsansvarlig>DNT</app:vedlikeholdsansvarlig>
      <app:tilrettelegging></app:tilrettelegging>
      <app:geometri>
        <gml:Point gml:id="ruteinfopunkt.2_POSISJON" srsName="urn:ogc:def:crs:EPSG::4258">
          <gml:pos>61.6 8.25</gml:pos>
        </gml:Point>
      </app:geometri>
    </app:RuteInfoPunkt>
  </wfs:member>
  <wfs:member>
    <app:Fotrute gml:id="fotrute.1">
      <app:opphav>Not a waypoint</app:opphav>
    </app:Fotrute>
  </wfs:member>
</wfs:FeatureCollection>`;

function mockFetch(body: string): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(body, { status: 200, headers: { 'content-type': 'application/gml+xml' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

describe('fetchHutsAlong — app:RuteInfoPunkt', () => {
  it('sends a lon,lat bbox, keeps only waypoints inside the radius, and assumes no food', async () => {
    const { fetchImpl, urls } = mockFetch(GML);
    const huts = await fetchHutsAlong(ROUTE, { radiusM: 2000, fetchImpl, attempts: 1 });

    // --- the axis-order trap ------------------------------------------------
    expect(urls).toHaveLength(1);
    expect(urls[0].startsWith(WFS_ENDPOINT)).toBe(true);
    const url = new URL(urls[0]);
    expect(url.searchParams.get('typeNames')).toBe(HUT_TYPE_NAME);
    // `outputFormat` is mandatory on this endpoint; without it: an OWS exception.
    expect(url.searchParams.get('outputFormat')).toContain('gml+xml');
    const bbox = (url.searchParams.get('bbox') ?? '').split(',');
    expect(bbox).toHaveLength(5);
    expect(bbox[4]).toBe('EPSG:4326');
    // EPSG:4326 with this endpoint means lon,lat. A lat,lon bbox returns zero
    // features with HTTP 200 and no error, so the order is asserted, not assumed.
    expect(Number(bbox[0])).toBeCloseTo(8.1625, 2); // minLon = 8.2 − 2 km
    expect(Number(bbox[1])).toBeCloseTo(61.382, 3); // minLat = 61.4 − 2 km
    expect(Number(bbox[2])).toBeGreaterThan(8.29);
    expect(Number(bbox[3])).toBeGreaterThan(61.41);

    // --- the candidates -----------------------------------------------------
    // The 22 km hut and the non-waypoint member are dropped.
    expect(huts).toHaveLength(1);
    const fondsbu = huts[0];
    expect(fondsbu.kind).toBe('hut');
    expect(fondsbu.name).toBe('Fondsbu');
    // Turrutebasen is curated Kartverket data, not OSM.
    expect(fondsbu.evidence).toBe('curated');
    // No hours are served, and none are invented — not even "24/7", and no hut
    // kind: the facility code is opaque, so no food can be inferred from it.
    expect(fondsbu.openingHours).toBeUndefined();
    expect(fondsbu).not.toHaveProperty('hutKind');
    // Read back in lat,lon order from the GML and converted once.
    expect(fondsbu.point.lat).toBeCloseTo(61.4003, 6);
    expect(fondsbu.point.lon).toBeCloseTo(8.25, 6);
    expect(fondsbu.detourM).toBeGreaterThan(25);
    expect(fondsbu.detourM).toBeLessThan(40);
    expect(fondsbu.alongRouteM).toBeGreaterThan(2600);
    expect(fondsbu.alongRouteM).toBeLessThan(2750);

    // --- parsing keeps the fields a curator would need, and nothing more ----
    const parsed = parseHutGml(GML);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      name: 'Fondsbu',
      maintainer: 'DNT | DNT Oslo og omegn',
      facilityCode: '42',
      updatedAt: '2026-09-02T11:00:35',
    });

    // A lat,lon bbox is refused before it can return an empty, silent answer.
    expect(hutGetFeatureUrl({ minLon: 8.2, minLat: 61.4, maxLon: 8.3, maxLat: 61.5 })).toContain(
      'bbox=8.2%2C61.4%2C8.3%2C61.5%2CEPSG%3A4326',
    );
    expect(() =>
      hutGetFeatureUrl({ minLon: 61.4, minLat: 8.2, maxLon: 61.5, maxLat: 8.3 }),
    ).toThrow(/lat,lon order/);
  });
});

/**
 * Regressions from the engine review.
 *
 * Both were confirmed bugs with the potential to hurt in production: a
 * definitive 4xx was retried (hammering Geonorge), and a country-length route
 * requested the entire national hut layer in one response.
 */
describe('fetchHutsAlong — request discipline', () => {
  it('never retries a definitive 4xx, and tiles a long route into bounded requests', async () => {
    // (a) a 404 is final: exactly one request, even with attempts: 3
    let calls = 0;
    const notFound = (async () => {
      calls += 1;
      return new Response('nope', { status: 404, statusText: 'Not Found' });
    }) as unknown as typeof fetch;

    await expect(
      fetchHutsAlong(ROUTE, { fetchImpl: notFound, attempts: 3 }),
    ).rejects.toThrow(/HTTP 404/);
    expect(calls).toBe(1);

    // (b) a route spanning the country must not become one national request
    const national: LonLat[] = [
      { lon: 5, lat: 58 },
      { lon: 30, lat: 71 },
    ];
    const urls: string[] = [];
    const ok = (async (url: string) => {
      urls.push(String(url));
      return new Response(GML, { status: 200, headers: { 'content-type': 'application/xml' } });
    }) as unknown as typeof fetch;

    await fetchHutsAlong(national, { fetchImpl: ok });
    expect(urls.length).toBeGreaterThan(1);
    expect(urls.length).toBeLessThanOrEqual(24);

    for (const url of urls) {
      const bbox = new URL(url).searchParams.get('bbox') ?? '';
      const [minLon, minLat, maxLon, maxLat] = bbox.split(',').map(Number);
      // No single request may cover the whole extent, and lon stays before lat.
      expect(maxLon - minLon).toBeLessThanOrEqual(30);
      expect(maxLat - minLat).toBeLessThanOrEqual(13.1);
      expect(minLon).toBeGreaterThanOrEqual(4);
      expect(maxLat).toBeLessThanOrEqual(72);
    }
  });
});

/**
 * The map's own hut query.
 *
 * The view query used to hand the box's two opposite corners to the corridor
 * client, so every hut was projected onto the box **diagonal** and anything more
 * than a radius off it was dropped — at z12 over Gjendesheim the WFS returned 3
 * waypoints in view and 2 survived. A view is a box, and the box is the filter.
 */
describe('fetchHutsInBounds — a view is a box', () => {
  it('keeps every waypoint in the box, drops the ones outside it, and pads nothing', async () => {
    const { fetchImpl, urls } = mockFetch(GML);
    const box = { minLon: 8.2, minLat: 61.39, maxLon: 8.32, maxLat: 61.61 };
    const huts = await fetchHutsInBounds(box, { fetchImpl, attempts: 1 });

    // Both waypoints are in the box and the second is 22 km from the first — far
    // outside any corridor radius, so a corridor query would have dropped it.
    expect(huts.map((hut) => hut.name)).toEqual(['Fondsbu', 'Ukjent']);
    expect(huts.every((hut) => hut.kind === 'hut' && hut.alongRouteM === 0)).toBe(true);
    expect(huts.every((hut) => hut.detourM === 0 && hut.evidence === 'curated')).toBe(true);
    expect(huts.every((hut) => hut.openingHours === undefined)).toBe(true);

    // The request is exactly the box: no route padding on top of it.
    const bbox = (new URL(urls[0]).searchParams.get('bbox') ?? '')
      .split(',')
      .slice(0, 4)
      .map(Number);
    expect(bbox).toEqual([8.2, 61.39, 8.32, 61.61]);
    expect(new URL(urls[0]).searchParams.get('bbox')).toContain('EPSG:4326');

    // A box that only reaches the southern waypoint returns only that one: the
    // client-side re-filter is what pins the answer to the view.
    const narrow = mockFetch(GML);
    const one = await fetchHutsInBounds({ ...box, maxLat: 61.45 }, {
      fetchImpl: narrow.fetchImpl,
      attempts: 1,
    });
    expect(one.map((hut) => hut.name)).toEqual(['Fondsbu']);
  });
});
