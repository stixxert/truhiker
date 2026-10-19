/**
 * The stats bar, and the two claims it must not get wrong.
 *
 *  1. **Vertical metres (D8).** Ascent and descent are heights, so they go
 *     through the elevation formatter. The horizontal `distance()` formatter
 *     switches to kilometres above 1,000 m, which printed a 1,500 m climb as
 *     "1,50 km" — a unit error in the most-read numbers on the screen.
 *  2. **No overclaiming (B3/B4).** The energy numbers come from a placeholder
 *     body until the user enters one, and the privacy line must name the
 *     services that do receive positions from the route.
 *
 * Both live here because they are the same rule: the UI says exactly what the
 * data supports, in the units it actually measured.
 */

import { describe, expect, it } from 'vitest';

import { createI18n } from '../src/i18n';
import { ascentLabel, descentLabel } from '../src/ui/stats';
import { isPlaceholderBody, placeholderProfileNotice } from '../src/ui/energy-view';

const no = createI18n('no');
const en = createI18n('en');

/** `defaultProfile()` from `src/store/trip.ts`, spelled out: the shipped default. */
const DEFAULT_PROFILE = {
  massKg: 75,
  heightCm: 178,
  ageYears: 35,
  sex: 'male' as const,
  packBaseKg: 12,
  dailyKm: 20,
  dailyHours: 8,
  support: 'carry-all' as const,
};

describe('stats bar — vertical metres, not horizontal kilometres', () => {
  it('renders a 1 500 m and a 3 000 m climb in metres, never as kilometres', () => {
    // Norwegian groups thousands with a non-breaking space; English with a comma.
    expect(ascentLabel(1500, no)).toBe('+1\u00a0500 m');
    expect(ascentLabel(3000, no)).toBe('+3\u00a0000 m');
    expect(descentLabel(1500, no)).toBe('−1\u00a0500 m');
    expect(descentLabel(3000, no)).toBe('−3\u00a0000 m');
    expect(ascentLabel(1500, en)).toBe('+1,500 m');

    // The regression itself: the distance formatter would have said "1,50 km".
    expect(no.format.distance(1500)).toBe('1,50 km');
    for (const label of [
      ascentLabel(1500, no),
      ascentLabel(3000, no),
      descentLabel(1500, no),
      descentLabel(3000, no),
      ascentLabel(1500, en),
    ]) {
      expect(label).not.toMatch(/km/);
      expect(label).toMatch(/ m$/);
    }
    // Below a metre the number is rounded, not shown as a decimal height.
    expect(ascentLabel(999.6, no)).toBe('+1\u00a0000 m');
  });
});

describe('default body and privacy copy — no claim the data does not support', () => {
  it('labels energy computed from the placeholder body, and names who receives route positions', () => {
    // B3: the default body satisfies every guard, so a first-time visitor would
    // otherwise be told "you can eat enough" for a body they never entered.
    expect(isPlaceholderBody(DEFAULT_PROFILE, DEFAULT_PROFILE)).toBe(true);
    const notice = placeholderProfileNotice(DEFAULT_PROFILE, DEFAULT_PROFILE, no)!;
    expect(notice).toContain('standardprofil');
    expect(notice).toContain('75 kg');
    expect(notice).toContain('35');
    expect(notice).toContain('ikke dine egne tall');
    expect(placeholderProfileNotice(DEFAULT_PROFILE, DEFAULT_PROFILE, en)).toContain(
      'default profile',
    );

    // Changing any body field — or entering the trip without one — silences it.
    const own = { ...DEFAULT_PROFILE, massKg: 68 };
    expect(isPlaceholderBody(own, DEFAULT_PROFILE)).toBe(false);
    expect(placeholderProfileNotice(own, DEFAULT_PROFILE, no)).toBeNull();
    // A different daily distance does not make the body the user's own.
    expect(isPlaceholderBody({ ...DEFAULT_PROFILE, dailyKm: 12 }, DEFAULT_PROFILE)).toBe(true);
    expect(placeholderProfileNotice(null, DEFAULT_PROFILE, no)).toBeNull();

    // B4: the old line said "the route never leaves your device", which is false:
    // elevation, trails and weather are fetched with positions from the route.
    for (const i18n of [no, en]) {
      const privacy = i18n.t('empty.privacy');
      expect(privacy).not.toMatch(/forlater aldri enheten|never leaves your device/);
      expect(privacy).toContain('Kartverket');
      expect(privacy).toContain('MET');
      expect(privacy).toContain('hoydedata.no');
      // ...and it still makes the claim that is true.
      expect(privacy.toLowerCase()).toMatch(/nettleseren|browser/);

      const about = i18n.t('about.privacy');
      expect(about).toContain('Kartverket');
      expect(about).toContain('MET');
      expect(about).toContain('hoydedata.no');
      expect(about.toLowerCase()).toMatch(/ingen sporing|no tracking/);
    }
  });
});
