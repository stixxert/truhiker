import { describe, expect, it } from 'vitest';

import type { TurruteLine } from '../src/snap/wfs';
import { SnapService } from '../src/app/snap-service';
import { MemoryWeatherCache } from '../src/lib/weather-cache';

function line(id: string, lon: number, lat: number): TurruteLine {
  return {
    id,
    lokalId: id,
    srsName: 'urn:ogc:def:crs:EPSG::4258',
    coords: [
      { lon, lat },
      { lon: lon + 0.01, lat: lat + 0.01 },
    ],
    attributes: {
      lokalId: id,
      rutenavn: 'Memurubu–Glitterheim',
      rutenummer: 'jot21',
      vedlikeholdsansvarlig: 'DNT',
      gradering: 'B',
      merking: 'JA',
      ruteFolger: 'ST',
      underlagstype: '',
      sesong: '',
      oppdateringsdato: '2026-01-01T00:00:00.000Z',
    },
  };
}

const BBOX = { minLon: 8.2, minLat: 61.5, maxLon: 8.4, maxLat: 61.7 };

describe('SnapService', () => {
  it('indexes the trails for a viewport and snaps within the radius', async () => {
    const service = new SnapService({
      fetchBox: async () => [line('l1', 8.3, 61.6)],
    });
    expect(service.status).toBe('idle');
    expect(service.snap({ lon: 8.3, lat: 61.6 }, 75)).toBeNull();

    await service.loadViewport(BBOX);

    expect(service.status).toBe('ready');
    expect(service.lineCount).toBe(1);
    expect(service.isReady).toBe(true);

    const hit = service.snap({ lon: 8.305, lat: 61.605 }, 75);
    expect(hit?.lineId).toBe('l1');
    expect(hit?.attributes.rutenummer).toBe('jot21');
    // Nothing within 10 m of a point a kilometre away.
    expect(service.snap({ lon: 9.5, lat: 62.5 }, 75)).toBeNull();
  });

  it('reports a failure instead of an empty network', async () => {
    const service = new SnapService({
      fetchBox: async () => {
        throw new Error('HTTP 503');
      },
    });
    await service.loadViewport(BBOX);
    expect(service.status).toBe('failed');
    expect(service.errorMessage).toContain('503');
    expect(service.lineCount).toBe(0);
  });

  it('ignores a degenerate viewport and does not fetch', async () => {
    let calls = 0;
    const service = new SnapService({
      fetchBox: async () => {
        calls++;
        return [];
      },
    });
    await service.loadViewport({ minLon: 8.4, minLat: 61.7, maxLon: 8.2, maxLat: 61.5 });
    expect(calls).toBe(0);
    expect(service.status).toBe('idle');
  });
});

describe('MemoryWeatherCache', () => {
  it('returns a stored value and null for a miss', async () => {
    const cache = new MemoryWeatherCache();
    expect(await cache.get('met:61.5:8.3')).toBeNull();
    await cache.set('met:61.5:8.3', { tempC: 8 });
    expect(await cache.get('met:61.5:8.3')).toEqual({ tempC: 8 });
    expect(cache.stats.hits).toBe(1);
    expect(cache.stats.misses).toBe(1);
  });

  it('drops an entry after its explicit expiry', async () => {
    let now = 1000;
    const cache = new MemoryWeatherCache({ now: () => now });
    await cache.set('k', 'v', new Date(now + 5000).toISOString());
    expect(await cache.get('k')).toBe('v');
    now += 6000;
    expect(await cache.get('k')).toBeNull();
  });

  it('evicts the oldest entry when the cap is reached', async () => {
    const cache = new MemoryWeatherCache({ maxEntries: 2 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.set('c', 3);
    expect(cache.size).toBe(2);
    expect(await cache.get('a')).toBeNull();
    expect(await cache.get('c')).toBe(3);
  });

  it('ignores an unparsable expiry instead of expiring immediately', async () => {
    const cache = new MemoryWeatherCache();
    await cache.set('k', 'v', 'not-a-date');
    expect(await cache.get('k')).toBe('v');
  });
});
