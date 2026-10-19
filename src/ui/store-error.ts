/**
 * Store errors, in plain language.
 *
 * `StoreError` codes are precise, but "quota-exceeded" is not a sentence. Each
 * code maps to one translated explanation; the original message rides along in
 * the tooltip so a developer can still see what the browser actually said.
 */

import { StoreError, type StoreErrorCode } from '../contracts';
import type { I18n, MessageKey } from '../i18n';
import { formatSize } from './format-size';

const CODE_KEYS: Record<StoreErrorCode, MessageKey> = {
  'quota-exceeded': 'store.quota',
  corrupt: 'store.corrupt',
  unsupported: 'store.unsupported',
  'not-found': 'store.notFound',
};

/** Message key for a code; `null` for an unknown object. */
export function storeErrorKey(error: unknown): MessageKey | null {
  if (error instanceof StoreError) return CODE_KEYS[error.code] ?? null;
  return null;
}

/** Translated, user-facing text for any thrown store/import error. */
export function storeErrorText(error: unknown, i18n: Pick<I18n, 't' | 'format'>): string {
  const key = storeErrorKey(error);
  if (key === 'store.quota' && error instanceof StoreError && error.bytes !== undefined) {
    return i18n.t('store.quotaSize', { size: formatSize(error.bytes, i18n) });
  }
  if (key) return i18n.t(key);
  const message = error instanceof Error ? error.message : String(error);
  return i18n.t('store.generic', { message: message.split('\n')[0] });
}

/** Detail for a tooltip: the original message, never shown inline. */
export function storeErrorDetail(error: unknown): string | null {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return null;
}
