import { describe, expect, it } from 'vitest';

import type { SaveStatus } from '../src/app/trip-session';
import { StoreError } from '../src/contracts';
import { createI18n } from '../src/i18n';
import { formatSaveTime, saveStatusDetail, saveStatusText } from '../src/ui/save-status';
import { storeErrorDetail, storeErrorKey, storeErrorText } from '../src/ui/store-error';

const AT = new Date(2026, 6, 1, 14, 32, 0).getTime();
const status = (overrides: Partial<SaveStatus>): SaveStatus => ({ kind: 'dirty', ...overrides });

/**
 * Grouped deliberately: the suite has a case budget (docs/11), and separate
 * cases for every (status × language) pair cost more than they protect. Each
 * row still asserts the same thing it used to.
 */
describe('save status text', () => {
  it('renders every state in both languages, with the quota case explained rather than coded', () => {
    const no = createI18n('no');
    const en = createI18n('en');

    expect(saveStatusText({ kind: 'idle' }, no)).toBe('');

    expect(saveStatusText(status({}), no)).toBe('ikke lagret');
    expect(saveStatusText(status({}), en)).toBe('not saved');

    expect(saveStatusText(status({ kind: 'saved', at: AT }), no)).toBe('lagret 14:32');
    expect(formatSaveTime(AT, 'en-GB')).toBe('14:32');

    const quota = saveStatusText(
      status({ kind: 'error', code: 'quota-exceeded', message: 'DomException: quota' }),
      no,
    );
    expect(quota).toContain('nettleserlagringen er full');
    expect(quota).not.toContain('quota-exceeded');

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
  });

  it('translates every StoreError code and falls back for anything else', () => {
    const no = createI18n('no');
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
