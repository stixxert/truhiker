/**
 * The stats bar: distance, ascent, descent, Naismith walking time, elevation
 * range, and the elevation-source badge.
 *
 * Degradation rule: when the DEM is unavailable, DEM-derived numbers are
 * rendered as "—" with a visible explanation — never as zero. Distance comes
 * from the GPX geometry and stays meaningful, so it remains.
 */

import type { I18n } from '../i18n';

export type SourceStatus = 'idle' | 'ready' | 'loading' | 'error';

export interface StatsValues {
  distanceM: number | null;
  ascentM: number | null;
  descentM: number | null;
  minutes: number | null;
  minEle: number | null;
  maxEle: number | null;
}

export interface StatsModel {
  values: StatsValues;
  source: SourceStatus;
  /** Why the DEM-derived values are disabled, shown as a tooltip. */
  disabledReason?: string;
  /** Naismith parameters, for the tooltip on the time cell. */
  paceHint?: string;
}

const ID = {
  distance: 'stat-distance',
  ascent: 'stat-ascent',
  descent: 'stat-descent',
  time: 'stat-time',
  elevation: 'stat-elevation',
} as const;

export class StatsBar {
  private readonly root: HTMLElement;
  private readonly i18n: I18n;
  private readonly sourceBadge: HTMLElement;
  private readonly sourceLabel: HTMLElement;
  private lastModel: StatsModel | null = null;

  constructor(root: HTMLElement, i18n: I18n) {
    this.root = root;
    this.i18n = i18n;
    const badge = root.querySelector<HTMLElement>('#source-badge');
    const label = root.querySelector<HTMLElement>('#source-label');
    if (!badge || !label) throw new Error('stats bar is missing #source-badge/#source-label');
    this.sourceBadge = badge;
    this.sourceLabel = label;
  }

  render(model: StatsModel): void {
    this.lastModel = model;
    const { values, source, disabledReason, paceHint } = model;
    const demReady = source === 'ready' && disabledReason === undefined;

    const apply = (id: string, text: string, enabled: boolean, title?: string): void => {
      const element = this.root.querySelector<HTMLElement>(`#${id}`);
      if (!element) return;
      element.textContent = text;
      element.classList.toggle('is-disabled', !enabled);
      if (enabled) {
        element.removeAttribute('aria-label');
        if (title) element.title = title;
        else element.removeAttribute('title');
      } else {
        element.setAttribute('aria-label', this.i18n.t('stats.disabled'));
        if (disabledReason) element.title = disabledReason;
      }
    };

    apply(
      ID.distance,
      values.distanceM === null ? '—' : this.i18n.format.distance(values.distanceM),
      values.distanceM !== null,
    );
    apply(
      ID.ascent,
      demReady && values.ascentM !== null ? `+${this.i18n.format.distance(values.ascentM)}` : '—',
      demReady && values.ascentM !== null,
    );
    apply(
      ID.descent,
      demReady && values.descentM !== null ? `−${this.i18n.format.distance(values.descentM)}` : '—',
      demReady && values.descentM !== null,
    );
    apply(
      ID.time,
      demReady && values.minutes !== null ? this.i18n.format.duration(values.minutes) : '—',
      demReady && values.minutes !== null,
      paceHint,
    );
    apply(
      ID.elevation,
      demReady && values.minEle !== null && values.maxEle !== null
        ? this.i18n.format.elevationRange(values.minEle, values.maxEle)
        : '—',
      demReady && values.minEle !== null && values.maxEle !== null,
    );

    this.sourceBadge.dataset.status = source;
    this.sourceLabel.textContent =
      source === 'ready'
        ? this.i18n.t('source.ready')
        : source === 'loading'
          ? this.i18n.t('source.loading')
          : source === 'error'
            ? this.i18n.t('source.error')
            : this.i18n.t('source.none');
    this.sourceBadge.title =
      source === 'ready'
        ? this.i18n.t('source.title')
        : (disabledReason ?? this.i18n.t('source.error'));
  }

  /** Re-render after a language change, using the last model. */
  refresh(): void {
    if (this.lastModel) this.render(this.lastModel);
  }
}
