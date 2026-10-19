import { describe, expect, it } from 'vitest';

import {
  MAX_HASH_CHARS,
  base64UrlDecode,
  base64UrlEncode,
  compactGpx,
  decodeRouteHash,
  encodeRouteHash,
  hasRouteHash,
} from '../src/lib/share';

const gpx = `<?xml version="1.0"?>
<gpx version="1.1"><trk><name>Fjellrute æøå</name><trkseg>
<trkpt lat="61.5" lon="8.3"/><trkpt lat="61.5" lon="8.32"/>
</trkseg></trk></gpx>`;

describe('base64url', () => {
  it('round-trips arbitrary bytes, matches known vectors, and rejects malformed input', () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 255, 128, 42]);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(base64UrlDecode(encoded)).toEqual(bytes);

    expect(base64UrlEncode(new TextEncoder().encode('a'))).toBe('YQ');
    expect(base64UrlEncode(new TextEncoder().encode('ab'))).toBe('YWI');
    expect(base64UrlEncode(new TextEncoder().encode('abc'))).toBe('YWJj');

    expect(base64UrlDecode('!!!!')).toBeNull();
    expect(base64UrlDecode('a')).toBeNull();
  });
});

describe('route hash', () => {
  it('round-trips Norwegian characters, accepts the payload with or without its prefix, and refuses to overflow', () => {
    const hash = encodeRouteHash(gpx);
    expect(hash?.startsWith('#r=')).toBe(true);
    expect(decodeRouteHash(hash!)).toBe(gpx);
    expect(decodeRouteHash(hash!.slice(3))).toBe(gpx);
    expect(decodeRouteHash(hash!.slice(1))).toBe(gpx);

    expect(encodeRouteHash(gpx + 'x'.repeat(MAX_HASH_CHARS * 2))).toBeNull();
    // A custom cap makes the same behaviour testable on a tiny input.
    expect(encodeRouteHash(gpx, 10)).toBeNull();
  });

  it('returns null for an invalid or empty fragment and detects a route fragment', () => {
    expect(decodeRouteHash('#r=')).toBeNull();
    expect(decodeRouteHash('#r=!!!!')).toBeNull();
    expect(decodeRouteHash('')).toBeNull();

    expect(hasRouteHash('#r=YWJj')).toBe(true);
    expect(hasRouteHash('#r=')).toBe(true);
    expect(hasRouteHash('#other')).toBe(false);
    expect(hasRouteHash('')).toBe(false);
  });
});

describe('compactGpx', () => {
  it('strips a BOM and surrounding whitespace', () => {
    expect(compactGpx('\ufeff  <gpx/>\n')).toBe('<gpx/>');
  });
});
