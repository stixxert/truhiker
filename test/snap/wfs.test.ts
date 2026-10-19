import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  TURRUTE_OUTPUT_FORMAT,
  TurrutebasenClient,
  WFS_ENDPOINT,
  assertLonLatBBox,
  fetchTurruteBox,
  fetchTurruteHits,
  gmlAxisOrder,
  parsePosList,
  parseTurruteGml,
  turruteGetFeatureUrl,
  turruteHitsUrl,
  type LonLatBBox,
} from '../../src/snap/wfs';

const FIXTURE = readFileSync(new URL('./fixtures/turrute.gml', import.meta.url), 'utf8');

// The fixture is a real GetFeature response for lon 8.30–8.40, lat 61.47–61.53
// (Jotunheimen, 34 KB, recorded 2026-10). It contains seven Fotrute features.
const BBOX: LonLatBBox = { minLon: 8.3, minLat: 61.47, maxLon: 8.4, maxLat: 61.53 };

function fakeResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, ...init });
}

describe('parseTurruteGml (recorded fixture)', () => {
  const parsed = parseTurruteGml(FIXTURE);

  it('parses every feature and geometry, and never trusts the reported counts', () => {
    expect(parsed.featureCount).toBe(7);
    expect(parsed.lines).toHaveLength(7);
    // The server currently reports numberReturned=0 even when features are
    // present (numberMatched="unknown"); counts must never be trusted.
    expect(parsed.numberReturned).toBe(0);
    expect(parsed.numberMatched).toBeUndefined();
  });

  it('reads attributes from the nested fotruteInfo group, including a feature with two groups', () => {
    const jot15 = parsed.lines.find(
      (line) => line.attributes.lokalId === 'c9ee2353-e4d5-4eb8-bade-3d87ea394402',
    );
    expect(jot15).toBeDefined();
    expect(jot15?.attributes.rutenummer).toBe('jot15');
    expect(jot15?.attributes.vedlikeholdsansvarlig).toBe('DNT | DNT Oslo og omegn');
    expect(jot15?.attributes.rutenavn).toBe('Ukjent');
    expect(jot15?.attributes.merking).toBe('JA');
    expect(jot15?.attributes.ruteFolger).toBe('ST');
    expect(jot15?.attributes.oppdateringsdato).toMatch(/^2026-/);

    // Every feature in this box is maintained by the same DNT chapter, and
    // grade and season are empty in the source for these routes.
    expect(
      parsed.lines.every((line) => line.attributes.vedlikeholdsansvarlig === 'DNT | DNT Oslo og omegn'),
    ).toBe(true);
    expect(parsed.lines.every((line) => line.attributes.gradering === '')).toBe(true);
    expect(parsed.lines.every((line) => line.attributes.sesong === '')).toBe(true);

    // Feature 4c947071… carries jot15 and jot16; the first non-empty wins and
    // the feature is not duplicated.
    const twoGroups = parsed.lines.filter(
      (line) => line.attributes.lokalId === '4c947071-3f83-4831-9f87-ce84436e8c20',
    );
    expect(twoGroups).toHaveLength(1);
    expect(twoGroups[0]!.attributes.rutenummer).toBe('jot15');
  });
});

describe('GML axis order and posList parsing', () => {
  it('reads geographic CRSs as lat,lon, parses real and synthetic posLists, and throws on malformed ones', () => {
    expect(gmlAxisOrder('urn:ogc:def:crs:EPSG::4258')).toBe('lat-lon');
    expect(gmlAxisOrder('urn:ogc:def:crs:EPSG::4326')).toBe('lat-lon');
    expect(gmlAxisOrder('urn:ogc:def:crs:OGC:1.3:CRS84')).toBe('lon-lat');
    expect(gmlAxisOrder('EPSG:4326')).toBe('lon-lat');

    expect(parsePosList('61.5 8.3 61.51 8.31', 'urn:ogc:def:crs:EPSG::4258')).toEqual([
      { lon: 8.3, lat: 61.5 },
      { lon: 8.31, lat: 61.51 },
    ]);
    expect(parsePosList('8.3 61.5', 'urn:ogc:def:crs:OGC:1.3:CRS84')).toEqual([{ lon: 8.3, lat: 61.5 }]);

    // The real jot34 geometry must be decoded with lat first, not swapped.
    const jot34 = parseTurruteGml(FIXTURE).lines.find((line) => line.attributes.rutenummer === 'jot34');
    expect(jot34?.srsName).toBe('urn:ogc:def:crs:EPSG::4258');
    const first = jot34?.coords[0];
    expect(first?.lat).toBeGreaterThan(61);
    expect(first?.lat).toBeLessThan(62);
    expect(first?.lon).toBeGreaterThan(8);
    expect(first?.lon).toBeLessThan(9);
    expect(jot34?.coords.length).toBeGreaterThan(50);

    expect(() => parsePosList('61.5 8.3 61.51', 'urn:ogc:def:crs:EPSG::4258')).toThrow(/odd/);
    expect(() => parsePosList('61.5 abc', 'urn:ogc:def:crs:EPSG::4258')).toThrow(/non-numeric/);
    expect(() => parsePosList('120 8.3 61.5 8.31', 'urn:ogc:def:crs:EPSG::4258')).toThrow(/axis-swapped/);
  });
});

describe('parseTurruteGml — failures', () => {
  it('rejects an OWS exception, accepts a legitimately empty collection and throws on non-XML bodies', () => {
    const exception = `<?xml version="1.0"?>
      <ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1">
        <ows:Exception><ows:ExceptionText>outputFormat is mandatory</ows:ExceptionText></ows:Exception>
      </ows:ExceptionReport>`;
    expect(() => parseTurruteGml(exception)).toThrow(/OWS exception.*outputFormat is mandatory/);

    const empty = `<?xml version="1.0"?>
      <wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0"
        numberMatched="0" numberReturned="0"></wfs:FeatureCollection>`;
    expect(parseTurruteGml(empty)).toMatchObject({ lines: [], featureCount: 0, numberMatched: 0 });

    expect(() => parseTurruteGml('<html>nope')).toThrow(/Invalid XML|parseable XML/);
    expect(() => parseTurruteGml('<?xml version="1.0"?><root/>')).toThrow(/FeatureCollection/);
    expect(() => parseTurruteGml('')).toThrow(/empty/);
  });
});

describe('axis-order guards and URLs', () => {
  it('accepts a lon,lat bbox, rejects a swapped one, and builds the documented GetFeature and hits URLs', () => {
    expect(() => assertLonLatBBox(BBOX)).not.toThrow();

    const swapped: LonLatBBox = { minLon: 61.47, minLat: 8.3, maxLon: 61.53, maxLat: 8.4 };
    expect(() => assertLonLatBBox(swapped)).toThrow(/looks like lat,lon/);
    expect(() => turruteGetFeatureUrl(swapped)).toThrow(/looks like lat,lon/);

    expect(() =>
      assertLonLatBBox({ minLon: 8.3, minLat: 61.5, maxLon: 8.2, maxLat: 61.6 }),
    ).toThrow(RangeError);
    expect(() =>
      assertLonLatBBox({ minLon: Number.NaN, minLat: 61.5, maxLon: 8.3, maxLat: 61.6 }),
    ).toThrow(RangeError);
    expect(() =>
      assertLonLatBBox({ minLon: 8.3, minLat: 61.5, maxLon: 8.4, maxLat: 95 }),
    ).toThrow(RangeError);

    const url = new URL(turruteGetFeatureUrl(BBOX));
    expect(url.origin + url.pathname).toBe(WFS_ENDPOINT);
    expect(url.searchParams.get('version')).toBe('2.0.0');
    expect(url.searchParams.get('typeNames')).toBe('app:Fotrute');
    expect(url.searchParams.get('request')).toBe('GetFeature');
    expect(url.searchParams.get('outputFormat')).toBe(TURRUTE_OUTPUT_FORMAT);
    // The `+` must be encoded as %2B or the server drops outputFormat.
    expect(url.search).toContain('application%2Fgml%2Bxml%3B+version%3D3.2');
    // lon,lat order, then the exact CRS spelling with EPSG:4326.
    expect(url.searchParams.get('bbox')).toBe('8.3,61.47,8.4,61.53,EPSG:4326');
    // cql_filter is silently ignored by this server; never send it.
    expect(url.searchParams.has('cql_filter')).toBe(false);

    const hits = new URL(turruteHitsUrl(BBOX));
    expect(hits.searchParams.get('resultType')).toBe('hits');
    expect(hits.searchParams.get('typeNames')).toBe('app:Fotrute');
    expect(hits.searchParams.has('cql_filter')).toBe(false);
  });
});

describe('fetchTurruteBox / fetchTurruteHits', () => {
  it('requests the exact bbox, parses the response, retries only 5xx and handles an empty box', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return fakeResponse(FIXTURE);
    }) as typeof fetch;
    const result = await fetchTurruteBox(BBOX, { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(result.lines).toHaveLength(7);
    expect(new URL(result.url).searchParams.get('bbox')).toBe('8.3,61.47,8.4,61.53,EPSG:4326');

    // Definitive 4xx: one attempt only.
    const badRequest = vi.fn(async () => fakeResponse('bad request', { status: 400 }));
    await expect(
      fetchTurruteBox(BBOX, { fetchImpl: badRequest as unknown as typeof fetch, retryBaseMs: 1 }),
    ).rejects.toThrow(/HTTP 400/);
    expect(badRequest).toHaveBeenCalledTimes(1);

    // 5xx: retried, then fails loudly.
    const serverError = vi.fn(async () => fakeResponse('boom', { status: 503 }));
    await expect(
      fetchTurruteBox(BBOX, {
        fetchImpl: serverError as unknown as typeof fetch,
        attempts: 3,
        retryBaseMs: 1,
      }),
    ).rejects.toThrow(/after 3 attempt/);
    expect(serverError).toHaveBeenCalledTimes(3);

    // A zero-feature box is not an error.
    const empty = `<?xml version="1.0"?><wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="0" numberReturned="0"></wfs:FeatureCollection>`;
    const emptyResult = await fetchTurruteBox(BBOX, {
      fetchImpl: (async () => fakeResponse(empty)) as typeof fetch,
    });
    expect(emptyResult.lines).toEqual([]);
    expect(emptyResult.featureCount).toBe(0);
  });

  it('reads the national feature count from resultType=hits', async () => {
    let requestedUrl = '';
    const hits = `<?xml version="1.0"?><wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="137196" numberReturned="0"></wfs:FeatureCollection>`;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      requestedUrl = String(input);
      return fakeResponse(hits);
    }) as typeof fetch;
    expect(await fetchTurruteHits(BBOX, { fetchImpl })).toBe(137196);
    expect(new URL(requestedUrl).searchParams.get('resultType')).toBe('hits');
  });
});

describe('TurrutebasenClient', () => {
  it('caps concurrency at 2, counts requests and honours an abort signal while queued', async () => {
    let active = 0;
    let maxActive = 0;
    const fetchImpl = (async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return fakeResponse(FIXTURE);
    }) as typeof fetch;

    const client = new TurrutebasenClient({ fetchImpl });
    const boxes: LonLatBBox[] = Array.from({ length: 6 }, (_, i) => ({
      minLon: 8 + i * 0.01,
      minLat: 61.47,
      maxLon: 8.02 + i * 0.01,
      maxLat: 61.49,
    }));
    await Promise.all(boxes.map((box) => client.fetchBox(box)));
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(client.requestCount).toBe(6);
    expect(client.activeCount).toBe(0);

    // An abort while queued rejects only the queued request.
    let release: (() => void) | undefined;
    const blocking = (async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return fakeResponse(FIXTURE);
    }) as typeof fetch;
    const serial = new TurrutebasenClient({ fetchImpl: blocking, concurrency: 1 });
    const first = serial.fetchBox(BBOX);
    const controller = new AbortController();
    const second = serial.fetchBox(BBOX, { signal: controller.signal });
    controller.abort();
    await expect(second).rejects.toThrow(/abort/i);
    release?.();
    await first;
  });
});
