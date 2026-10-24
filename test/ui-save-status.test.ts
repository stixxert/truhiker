import { describe, expect, it } from 'vitest';

import type { SaveStatus } from '../src/app/trip-session';
import { StoreError } from '../src/contracts';
import { createI18n } from '../src/i18n';
import { formatSaveTime, saveStatusDetail, saveStatusText } from '../src/ui/save-status';
import { storeErrorDetail, storeErrorKey, storeErrorText } from '../src/ui/store-error';

/** 12:32 UTC on 1 July = 14:32 in Europe/Oslo (CEST). */
const AT = Date.UTC(2026, 6, 1, 12, 32, 0);
const status = (overrides: Partial<SaveStatus>): SaveStatus => ({ kind: 'dirty', ...overrides });

/**
 * Grouped deliberately: the suite has a case budget (320 cases in the gate), and
 * separate cases for every (status × language) pair cost more than they protect. Each
 * row still asserts what it used to; the store-error table lives here too
 * because it is the same "one visible sentence per failure" contract.
 */
describe('save status text', () => {
  it('renders every state in both languages in Europe/Oslo, and translates every StoreError code', () => {
    const no = createI18n('no');
    const en = createI18n('en');

    expect(saveStatusText({ kind: 'idle' }, no)).toBe('');

    expect(saveStatusText(status({}), no)).toBe('ikke lagret');
    expect(saveStatusText(status({}), en)).toBe('not saved');

    // A write that has been requested but has not committed says so.
    const saving = status({ kind: 'saving' });
    expect(saveStatusText(saving, no)).toBe('lagrer …');
    expect(saveStatusText(saving, en)).toBe('saving …');
    expect(saveStatusDetail(saving)).toBeNull();

    // D8: the clock is Europe/Oslo, not the device's zone. An instant given in
    // UTC must read 14:32 whatever the machine's timezone is (summer +02:00).
    expect(formatSaveTime(AT, 'en-GB')).toBe('14:32');
    expect(saveStatusText(status({ kind: 'saved', at: AT }), no)).toBe('lagret 14:32');
    // Winter is +01:00, so the same wall clock needs a different instant.
    expect(formatSaveTime(Date.UTC(2026, 0, 15, 9, 5), 'en-GB')).toBe('10:05');

    const quota = saveStatusText(
      status({ kind: 'error', code: 'quota-exceeded', message: 'DomException: quota' }),
      no,
    );
    expect(quota).toContain('nettleserlagringen er full');
    expect(quota).not.toContain('quota-exceeded');

    // D6: a quota failure names the size that failed, in the user's locale.
    const sized = saveStatusText(
      status({ kind: 'error', code: 'quota-exceeded', bytes: 8_400_000 }),
      no,
    );
    expect(sized).toContain('8,4 MB');
    expect(sized).toContain('turen er');
    expect(storeErrorText(new StoreError('quota-exceeded', 'too big', 8_400_000), no)).toContain(
      '8,4 MB',
    );

    const other = saveStatusText(
      status({ kind: 'error', message: 'first line\nsecond line' }),
      en,
    );
    expect(other).toContain('Saving failed');
    expect(other).toContain('first line');
    expect(other).not.toContain('second line');

    const unavailable = status({ kind: 'unavailable', message: 'no storage' });
    expect(saveStatusText(unavailable, no)).toContain('utilgjengelig');
    expect(saveStatusDetail(unavailable)).toBe('no storage');
    expect(saveStatusDetail(status({ kind: 'saved', at: AT }))).toBeNull();

    // Every StoreError code has a translated sentence; anything else falls back
    // to the raw message rather than hiding it.
    const expected: ReadonlyArray<[ConstructorParameters<typeof StoreError>[0], string]> = [
      ['quota-exceeded', 'full'],
      ['corrupt', 'skadet'],
      ['unsupported', 'privat modus'],
      ['not-found', 'finnes ikke'],
    ];
    for (const [code, fragment] of expected) {
      expect(storeErrorText(new StoreError(code, 'x'), no), code).toContain(fragment);
    }
    expect(storeErrorKey(new StoreError('corrupt', 'x'))).toBe('store.corrupt');
    expect(storeErrorKey(new Error('plain'))).toBeNull();

    const generic = storeErrorText(new Error('SyntaxError: bad JSON'), createI18n('en'));
    expect(generic).toContain('Something went wrong');
    expect(generic).toContain('SyntaxError');
    expect(storeErrorDetail(new Error('boom'))).toBe('Error: boom');
    expect(storeErrorDetail('not an error')).toBeNull();
  });
});
