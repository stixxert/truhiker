import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { TurrutebasenClient } from '../../src/snap/wfs';
import { loadTrailNetwork } from '../../src/route/trail-network';

const FIXTURE = readFileSync(new URL('../snap/fixtures/turrute.gml', import.meta.url), 'utf8');

const hitsXml = (matched: number): string => `<?xml version="1.0" encoding="UTF-8"?>
<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="${matched}" numberReturned="0"></wfs:FeatureCollection>`;

interface FakeOptions {
  readonly matched: number;
  readonly failHits?: boolean;
  readonly failBox?: boolean;
}

function fakeClient(options: FakeOptions): { client: TurrutebasenClient; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('resultType=hits')) {
      if (options.failHits) throw new Error('hits unavailable');
      return new Response(hitsXml(options.matched), { status: 200 });
    }
    if (options.failBox) throw new Error('features unavailable');
    return new Response(FIXTURE, { status: 200 });
  }) as unknown as typeof fetch;
  return { client: new TurrutebasenClient({ fetchImpl, attempts: 1, retryBaseMs: 1 }), calls };
}

const START = { lon: 8.31, lat: 61.48 };
const END = { lon: 8.39, lat: 61.52 };

describe('trail network loader', () => {
  it('fetches and converts the lines for the box around both points', async () => {
    const { client, calls } = fakeClient({ matched: 7 });
    const result = await loadTrailNetwork(START, END, { client, cache: new Map() });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.lines).toHaveLength(7);
    expect(result.featureCount).toBe(7);
    expect(result.bbox.minLon).toBeLessThan(START.lon);
    expect(result.bbox.maxLat).toBeGreaterThan(END.lat);
    // One hits request, one feature request.
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('GetFeature');
  });

  it('refuses an oversized area without touching the network', async () => {
    const { client, calls } = fakeClient({ matched: 7 });
    const result = await loadTrailNetwork(
      { lon: 5, lat: 61.5 },
      { lon: 12, lat: 61.5 },
      { client, cache: new Map() },
    );
    expect(result).toEqual({ kind: 'failed', code: 'area-too-large', detail: expect.any(String) });
    expect(calls).toHaveLength(0);
  });

  it('refuses before downloading when the hit count exceeds the cap', async () => {
    const { client, calls } = fakeClient({ matched: 6000 });
    const result = await loadTrailNetwork(START, END, { client, cache: new Map(), maxFeatures: 5000 });
    expect(result).toEqual({ kind: 'failed', code: 'too-many-features', detail: expect.any(String) });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('resultType=hits');
  });

  it('reports an unavailable network instead of an empty one', async () => {
    const hits = fakeClient({ matched: 7, failHits: true });
    expect(await loadTrailNetwork(START, END, { client: hits.client, cache: new Map() })).toMatchObject({
      kind: 'failed',
      code: 'network-unavailable',
    });

    const box = fakeClient({ matched: 7, failBox: true });
    expect(await loadTrailNetwork(START, END, { client: box.client, cache: new Map() })).toMatchObject({
      kind: 'failed',
      code: 'network-unavailable',
    });
  });

  it('serves a repeated box from the session cache', async () => {
    const { client, calls } = fakeClient({ matched: 7 });
    const cache = new Map();
    const first = await loadTrailNetwork(START, END, { client, cache });
    const second = await loadTrailNetwork(START, END, { client, cache });
    expect(first).toBe(second);
    expect(calls).toHaveLength(2);
  });

  it('caps after download when the parsed feature count exceeds the limit', async () => {
    const client = {
      fetchHits: async () => 7,
      fetchBox: async () => ({
        featureCount: 6000,
        lines: [
          {
            id: 'a',
            lokalId: 'a',
            attributes: {},
            coords: [
              { lon: 8.3, lat: 61.5 },
              { lon: 8.31, lat: 61.5 },
            ],
            srsName: 'urn:ogc:def:crs:EPSG::4258',
          },
        ],
      }),
    };
    const result = await loadTrailNetwork(START, END, {
      client: client as never,
      cache: new Map(),
      maxFeatures: 5000,
    });
    expect(result).toEqual({ kind: 'failed', code: 'too-many-features', detail: '6000 features' });
  });

  it('does not let a cached result bypass a smaller feature cap', async () => {
    const { client, calls } = fakeClient({ matched: 7 });
    const cache = new Map();
    expect((await loadTrailNetwork(START, END, { client, cache, maxFeatures: 5000 })).kind).toBe('ok');
    const capped = await loadTrailNetwork(START, END, { client, cache, maxFeatures: 3 });
    expect(capped).toEqual({ kind: 'failed', code: 'too-many-features', detail: '7 features' });
    expect(calls).toHaveLength(2);
  });

  it('rejects a negative margin', async () => {
    await expect(loadTrailNetwork(START, END, { marginM: -1 })).rejects.toThrow(RangeError);
  });
});
