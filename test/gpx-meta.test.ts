import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseGpxMetadata, parseTurrutebasenDescription } from '../src/lib/gpx-meta';

describe('parseTurrutebasenDescription', () => {
  it('reads what the real wording states, and only what it can verify', () => {
    expect(
      parseTurrutebasenDescription(
        'Turrutebasen route jot21 - DNT | DNT Oslo og omegn. Marked trail. Data: (c)Kartverket, CC BY 4.0.',
      ),
    ).toEqual({
      routeNumber: 'jot21',
      maintainer: 'DNT | DNT Oslo og omegn',
      marked: true,
    });

    // A description with no provenance must not produce made-up values.
    expect(parseTurrutebasenDescription('A hand-drawn line')).toEqual({});

    // A maintainer name with punctuation stays out of the sentence.
    const parsed = parseTurrutebasenDescription('Turrutebasen route f_2018 - Statskog. Unmarked.');
    expect(parsed.routeNumber).toBe('f_2018');
    expect(parsed.maintainer).toBe('Statskog');
    expect(parsed.marked).toBeUndefined();
  });
});

describe('parseGpxMetadata', () => {
  it('reads the bundled demo provenance, falls back to the track name, handles prefixes and never throws', () => {
    const xml = readFileSync(
      new URL('../public/demo/memurubu-glitterheim-jot21.gpx', import.meta.url),
      'utf8',
    );
    const meta = parseGpxMetadata(xml);
    expect(meta.name).toBe('Memurubu-Glitterheim');
    expect(meta.routeNumber).toBe('jot21');
    expect(meta.maintainer).toBe('DNT | DNT Oslo og omegn');
    expect(meta.marked).toBe(true);
    expect(meta.author).toBe('Kartverket Turrutebasen');
    expect(meta.copyright).toBe('Kartverket');
    expect(meta.licence).toBe('CC BY 4.0');

    const bare = parseGpxMetadata(
      '<gpx version="1.1"><trk><name>My track</name><trkseg><trkpt lat="61" lon="8"/></trkseg></trk></gpx>',
    );
    expect(bare.name).toBe('My track');
    expect(bare.routeNumber).toBeUndefined();
    expect(bare.licence).toBeUndefined();

    expect(
      parseGpxMetadata(
        '<gpx:gpx xmlns:gpx="http://www.topografix.com/GPX/1/1"><gpx:metadata><gpx:name>Prefixed</gpx:name></gpx:metadata></gpx:gpx>',
      ).name,
    ).toBe('Prefixed');

    // Metadata is decoration: garbage yields nothing, never a throw.
    expect(parseGpxMetadata('not xml at all')).toEqual({});
    expect(parseGpxMetadata('')).toEqual({});
  });
});
