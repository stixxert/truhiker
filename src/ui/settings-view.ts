/**
 * Trip settings: the user's numbers, validated.
 *
 * These are the user's own body, pack and pace — not defaults assumed about
 * them — so the dialog says so, every field is editable, and a missing optional
 * field stays missing (`bodyFatPercent` is omitted, never zero).
 *
 * Validation lives here, apart from the DOM, so the exact limits are testable
 * and the error is tied to the field that produced it.
 */

import type { SupportModel, UserProfile } from '../contracts';
import type { I18n } from '../i18n';

export interface SettingsFormValues {
  massKg: string;
  heightCm: string;
  ageYears: string;
  sex: 'male' | 'female';
  bodyFatPercent: string;
  packBaseKg: string;
  dailyKm: string;
  dailyHours: string;
  startDate: string;
  support: SupportModel;
}

export interface SettingsFieldError {
  readonly field: keyof SettingsFormValues;
  readonly message: string;
}

export interface SettingsParseOk {
  readonly ok: true;
  readonly profile: UserProfile;
}

export interface SettingsParseError {
  readonly ok: false;
  readonly errors: readonly SettingsFieldError[];
}

export type SettingsParseResult = SettingsParseOk | SettingsParseError;

/** Inclusive limits. They are wide on purpose; they exist to catch typos. */
export const SETTINGS_LIMITS = {
  massKg: { min: 30, max: 250 },
  heightCm: { min: 120, max: 230 },
  ageYears: { min: 10, max: 100 },
  bodyFatPercent: { min: 3, max: 60 },
  packBaseKg: { min: 0, max: 60 },
  dailyKm: { min: 1, max: 60 },
  dailyHours: { min: 0.5, max: 20 },
} as const;

export function settingsFromProfile(profile: UserProfile | null): SettingsFormValues {
  return {
    massKg: profile ? String(profile.massKg) : '75',
    heightCm: profile ? String(profile.heightCm) : '178',
    ageYears: profile ? String(profile.ageYears) : '35',
    sex: profile?.sex ?? 'male',
    bodyFatPercent:
      profile?.bodyFatPercent === undefined ? '' : String(profile.bodyFatPercent),
    packBaseKg: profile ? String(profile.packBaseKg) : '12',
    dailyKm: profile ? String(profile.dailyKm) : '20',
    dailyHours: profile ? String(profile.dailyHours) : '8',
    startDate: profile?.startDate ?? '',
    support: profile?.support ?? 'carry-all',
  };
}

function parseNumber(raw: string): number {
  return Number.parseFloat(raw.replace(',', '.').trim());
}

function rangeError(
  field: keyof SettingsFormValues,
  value: number,
  limits: { min: number; max: number },
  i18n: Pick<I18n, 't' | 'format'>,
): SettingsFieldError | null {
  if (!Number.isFinite(value)) {
    return { field, message: i18n.t('settings.numberRequired') };
  }
  if (value < limits.min || value > limits.max) {
    return {
      field,
      message: i18n.t('settings.outOfRange', {
        min: i18n.format.number(limits.min, { maximumFractionDigits: 1 }),
        max: i18n.format.number(limits.max, { maximumFractionDigits: 0 }),
      }),
    };
  }
  return null;
}

/** Accept an empty start date ("not decided yet") and reject anything else. */
export function parseStartDate(raw: string): string | undefined | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const [year, month, day] = trimmed.split('-').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return trimmed;
}

export function parseSettingsForm(
  values: SettingsFormValues,
  i18n: Pick<I18n, 't' | 'format'>,
): SettingsParseResult {
  const errors: SettingsFieldError[] = [];

  const mass = parseNumber(values.massKg);
  const massError = rangeError('massKg', mass, SETTINGS_LIMITS.massKg, i18n);
  if (massError) errors.push(massError);

  const height = parseNumber(values.heightCm);
  const heightError = rangeError('heightCm', height, SETTINGS_LIMITS.heightCm, i18n);
  if (heightError) errors.push(heightError);

  const age = parseNumber(values.ageYears);
  const ageError = rangeError('ageYears', age, SETTINGS_LIMITS.ageYears, i18n);
  if (ageError) errors.push(ageError);

  let bodyFat: number | undefined;
  if (values.bodyFatPercent.trim().length > 0) {
    bodyFat = parseNumber(values.bodyFatPercent);
    const bodyFatError = rangeError(
      'bodyFatPercent',
      bodyFat,
      SETTINGS_LIMITS.bodyFatPercent,
      i18n,
    );
    if (bodyFatError) errors.push(bodyFatError);
  }

  const pack = parseNumber(values.packBaseKg);
  const packError = rangeError('packBaseKg', pack, SETTINGS_LIMITS.packBaseKg, i18n);
  if (packError) errors.push(packError);

  const dailyKm = parseNumber(values.dailyKm);
  const dailyKmError = rangeError('dailyKm', dailyKm, SETTINGS_LIMITS.dailyKm, i18n);
  if (dailyKmError) errors.push(dailyKmError);

  const dailyHours = parseNumber(values.dailyHours);
  const dailyHoursError = rangeError('dailyHours', dailyHours, SETTINGS_LIMITS.dailyHours, i18n);
  if (dailyHoursError) errors.push(dailyHoursError);

  const startDate = parseStartDate(values.startDate);
  if (startDate === null) {
    errors.push({ field: 'startDate', message: i18n.t('settings.dateInvalid') });
  }

  if (values.sex !== 'male' && values.sex !== 'female') {
    errors.push({ field: 'sex', message: i18n.t('settings.sexRequired') });
  }
  if (values.support !== 'carry-all' && values.support !== 'mail-drops') {
    errors.push({ field: 'support', message: i18n.t('settings.supportRequired') });
  }

  if (errors.length > 0) return { ok: false, errors };

  const profile: UserProfile = {
    massKg: mass,
    heightCm: height,
    ageYears: age,
    sex: values.sex,
    packBaseKg: pack,
    dailyKm,
    dailyHours,
    support: values.support,
    ...(bodyFat === undefined ? {} : { bodyFatPercent: bodyFat }),
    ...(typeof startDate === 'string' ? { startDate } : {}),
  };
  return { ok: true, profile };
}
