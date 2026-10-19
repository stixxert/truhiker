import { describe, expect, it } from 'vitest';

import type { UserProfile } from '../src/contracts';
import { createI18n } from '../src/i18n';
import {
  SETTINGS_LIMITS,
  parseSettingsForm,
  parseStartDate,
  settingsFromProfile,
  type SettingsFormValues,
} from '../src/ui/settings-view';

const PROFILE: UserProfile = {
  massKg: 68,
  heightCm: 172,
  ageYears: 41,
  sex: 'female',
  packBaseKg: 9.5,
  dailyKm: 18,
  dailyHours: 7.5,
  startDate: '2026-07-04',
  support: 'mail-drops',
};

function values(overrides: Partial<SettingsFormValues> = {}): SettingsFormValues {
  return {
    massKg: '70',
    heightCm: '175',
    ageYears: '40',
    sex: 'male',
    bodyFatPercent: '',
    packBaseKg: '11',
    dailyKm: '16',
    dailyHours: '7',
    startDate: '2026-07-01',
    support: 'carry-all',
    ...overrides,
  };
}

describe('trip settings form', () => {
  it('round-trips a profile without inventing a body-fat value', () => {
    const form = settingsFromProfile(PROFILE);
    expect(form.bodyFatPercent).toBe('');
    const result = parseSettingsForm(form, createI18n('no'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile).toEqual(PROFILE);
    expect('bodyFatPercent' in result.profile).toBe(false);
  });

  it('accepts a comma decimal separator', () => {
    const result = parseSettingsForm(values({ massKg: '70,5' }), createI18n('no'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.profile.massKg).toBe(70.5);
  });

  it('keeps an optional body-fat percentage when given', () => {
    const result = parseSettingsForm(values({ bodyFatPercent: '22' }), createI18n('no'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.profile.bodyFatPercent).toBe(22);
  });

  it('omits an undecided start date instead of faking one', () => {
    const result = parseSettingsForm(values({ startDate: '' }), createI18n('no'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.startDate).toBeUndefined();
      expect('startDate' in result.profile).toBe(false);
    }
  });

  it('accepts the exact limits', () => {
    const result = parseSettingsForm(
      values({
        massKg: String(SETTINGS_LIMITS.massKg.min),
        heightCm: String(SETTINGS_LIMITS.heightCm.max),
        ageYears: String(SETTINGS_LIMITS.ageYears.min),
        packBaseKg: String(SETTINGS_LIMITS.packBaseKg.max),
        dailyKm: String(SETTINGS_LIMITS.dailyKm.min),
        dailyHours: '0.5',
        bodyFatPercent: String(SETTINGS_LIMITS.bodyFatPercent.min),
      }),
      createI18n('no'),
    );
    expect(result.ok).toBe(true);
  });

  it('reports each invalid field by name, not as one opaque error', () => {
    const result = parseSettingsForm(
      values({
        massKg: '5',
        heightCm: '',
        ageYears: '500',
        dailyKm: '0',
        dailyHours: '99',
        bodyFatPercent: '90',
        packBaseKg: '-2',
      }),
      createI18n('no'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const fields = result.errors.map((error) => error.field);
    expect(fields).toEqual(
      expect.arrayContaining([
        'massKg',
        'heightCm',
        'ageYears',
        'dailyKm',
        'dailyHours',
        'bodyFatPercent',
        'packBaseKg',
      ]),
    );
    expect(fields).not.toContain('startDate');
    for (const error of result.errors) expect(error.message.length).toBeGreaterThan(0);
  });

  it('rejects an impossible calendar date but accepts a real one', () => {
    expect(parseStartDate('2026-02-30')).toBeNull();
    expect(parseStartDate('2026-02-28')).toBe('2026-02-28');
    expect(parseStartDate('01.07.2026')).toBeNull();
    expect(parseStartDate('  ')).toBeUndefined();
    const result = parseSettingsForm(values({ startDate: '2026-13-01' }), createI18n('en'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].field).toBe('startDate');
  });

  it('refuses an empty sex or support value', () => {
    const bad: SettingsFormValues = {
      ...values(),
      // Simulate a corrupted form (a select cannot produce this through the UI).
      sex: '' as 'male',
      support: 'teleport' as 'carry-all',
    };
    const result = parseSettingsForm(bad, createI18n('no'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.field)).toEqual(
        expect.arrayContaining(['sex', 'support']),
      );
    }
  });

  it('labels the range error with both bounds', () => {
    const result = parseSettingsForm(values({ massKg: '500' }), createI18n('no'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].message).toContain('30');
      expect(result.errors[0].message).toContain('250');
    }
  });
});
