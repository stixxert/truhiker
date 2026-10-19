/**
 * The save-status line: "lagret 14:32", "ikke lagret", or the store's reason.
 *
 * Pure so the states can be tested without a DOM, and so the same text is used
 * in the header, the trip library and the toast.
 */

import type { SaveStatus } from '../app/trip-session';
import { formatClockAt, type I18n } from '../i18n';
import { formatSize } from './format-size';

/**
 * `HH:MM` in Europe/Oslo (D8). The device's zone is not the trip's zone: a save
 * made at 23:30 UTC is 01:30 the next day in Oslo, and only one of those is the
 * time the user experienced.
 */
export function formatSaveTime(at: number, locale: string): string {
  return formatClockAt(at, locale);
}

/** One line for the visible status region. Empty when there is nothing to say. */
export function saveStatusText(
  status: SaveStatus,
  i18n: Pick<I18n, 't' | 'locale' | 'format'>,
): string {
  switch (status.kind) {
    case 'idle':
      return '';
    case 'dirty':
      return i18n.t('save.dirty');
    case 'saving':
      return i18n.t('save.saving');
    case 'saved':
      return i18n.t('save.saved', {
        time: formatSaveTime(status.at ?? Date.now(), i18n.locale),
      });
    case 'unavailable':
      return i18n.t('save.unavailable');
    case 'error':
      if (status.code === 'quota-exceeded') {
        // D6: name the size that failed. Without a size (an older store error)
        // fall back to the generic sentence rather than inventing one.
        return status.bytes === undefined
          ? i18n.t('save.quota')
          : i18n.t('save.quotaSize', { size: formatSize(status.bytes, i18n) });
      }
      return i18n.t('save.error', { message: briefMessage(status.message) });
    default:
      return '';
  }
}

/** The full technical detail, for a tooltip rather than the visible line. */
export function saveStatusDetail(status: SaveStatus): string | null {
  if (status.kind === 'error' || status.kind === 'unavailable') return status.message ?? null;
  return null;
}

/** True while a write has been requested but has not committed yet. */
export function isPendingSave(status: SaveStatus): boolean {
  return status.kind === 'saving';
}

/** Browsers sometimes return multi-line quota messages; one line is enough. */
function briefMessage(message: string | undefined): string {
  if (!message) return '';
  const line = message.split('\n')[0].trim();
  return line.length > 110 ? `${line.slice(0, 107)}…` : line;
}
