/**
 * The resupply + energy panel.
 *
 * One aside, two tabs, because a 390 px viewport cannot hold two floating panels
 * and the two questions ("what do I carry?" and "can I eat enough?") are answered
 * together. This class only renders the models from `resupply-view.ts` and
 * `energy-view.ts`; every honesty rule lives there.
 *
 * Interaction:
 *  - a point row is a real `<button>`, so it is keyboard reachable, and clicking
 *    it moves the elevation-profile cursor to its along-route distance;
 *  - the assumptions (food density, pack mass) are inputs, not constants;
 *  - every state without numbers says why, in the user's language.
 */

import type { I18n } from '../i18n';
import type { EnergyAssumptions, EnergyViewModel, MassPoint } from './energy-view';
import type { ResupplyRowView, ResupplyViewModel } from './resupply-view';
import { RADIUS_OPTIONS_M } from './resupply-view';

export type SupplyTab = 'resupply' | 'energy';

interface SupplyPanelHandlers {
  onClose: () => void;
  onRefresh: () => void;
  onSettings: () => void;
  onOpenRoute: () => void;
  /** A point row was activated: move the profile cursor to this distance. */
  onSelectPoint: (row: ResupplyRowView) => void;
  onRadius: (radiusM: number) => void;
  onAssumptions: (assumptions: EnergyAssumptions) => void;
  /** Escape closed the panel; the app returns focus to the trigger button. */
  onEscape?: () => void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export class SupplyPanel {
  private readonly root: HTMLElement;
  private readonly i18n: I18n;
  private readonly handlers: SupplyPanelHandlers;
  private readonly tabs: { resupply: HTMLButtonElement; energy: HTMLButtonElement };
  private readonly sections: { resupply: HTMLElement; energy: HTMLElement };
  private readonly close: HTMLButtonElement;
  private readonly refresh: HTMLButtonElement;
  private readonly radius: HTMLSelectElement;
  private readonly resupplyStatus: HTMLElement;
  private readonly resupplyMessage: HTMLElement;
  private readonly resupplyMessageText: HTMLElement;
  private readonly resupplyAction: HTMLButtonElement;
  private readonly indexLabel: HTMLElement;
  private readonly hutsError: HTMLElement;
  private readonly filters: HTMLElement;
  private readonly filterButtons: {
    all: HTMLButtonElement;
    food: HTMLButtonElement;
    hut: HTMLButtonElement;
  };
  private filter: 'all' | 'food' | 'hut' = 'all';
  private readonly pointList: HTMLOListElement;
  private readonly pointEmpty: HTMLElement;
  private readonly legsWrap: HTMLElement;
  private readonly legList: HTMLOListElement;
  private readonly warningsWrap: HTMLElement;
  private readonly warningList: HTMLElement;
  private readonly totals: HTMLElement;
  private readonly worstGap: HTMLElement;
  private readonly engineDetails: HTMLDetailsElement;
  private readonly engineList: HTMLElement;
  private readonly attribution: HTMLElement;
  private readonly note: HTMLElement;

  private readonly energyMessage: HTMLElement;
  private readonly energyMessageText: HTMLElement;
  private readonly energyAction: HTMLButtonElement;
  /** B3: the badge for numbers computed from the default body. */
  private readonly energyNotice: HTMLElement;
  private readonly energyNoticeText: HTMLElement;
  private readonly energyNoticeButton: HTMLButtonElement;
  private readonly energyHeadline: HTMLElement;
  private readonly energyBody: HTMLElement;
  private readonly energyChartWrap: HTMLElement;
  private readonly energyRangeTitle: HTMLElement;
  private readonly energyRangeValue: HTMLElement;
  private readonly energyCeiling: HTMLElement;
  private readonly energyCentre: HTMLElement;
  private readonly energyBmr: HTMLElement;
  private readonly energyIntake: HTMLElement;
  private readonly energyNote: HTMLElement;
  private readonly energyBand: SVGSVGElement;
  private readonly energyMassWrap: HTMLElement;
  private readonly energyMassTitle: HTMLElement;
  private readonly energyMassCurve: SVGSVGElement;
  private readonly energyMassLabel: HTMLElement;
  private readonly energyDays: HTMLElement;
  private readonly energyFat: HTMLElement;
  private readonly assumptionsTitle: HTMLElement;
  private readonly densityInput: HTMLInputElement;
  private readonly densityLabel: HTMLElement;
  private readonly densityHint: HTMLElement;
  private readonly packInput: HTMLInputElement;
  private readonly packLabel: HTMLElement;
  private readonly packHint: HTMLElement;
  private readonly foodMass: HTMLElement;

  private radiusM: number = RADIUS_OPTIONS_M[0];
  private assumptions: EnergyAssumptions = { foodKcalPerGram: 4.4, packMassKg: 12 };
  /** Kept so the kind filter can re-render without the app re-querying. */
  private lastResupply: ResupplyViewModel | null = null;
  private actionKind: ResupplyViewModel['action'] = 'none';

  constructor(root: HTMLElement, i18n: I18n, handlers: SupplyPanelHandlers) {
    this.root = root;
    this.i18n = i18n;
    this.handlers = handlers;
    const q = <T extends HTMLElement = HTMLElement>(id: string): T => required<T>(root, id);

    this.tabs = {
      resupply: q<HTMLButtonElement>('supply-tab-resupply'),
      energy: q<HTMLButtonElement>('supply-tab-energy'),
    };
    this.sections = {
      resupply: q('supply-section-resupply'),
      energy: q('supply-section-energy'),
    };
    this.close = q<HTMLButtonElement>('supply-close');
    this.refresh = q<HTMLButtonElement>('supply-refresh');
    this.radius = q<HTMLSelectElement>('supply-radius');
    this.resupplyStatus = q('supply-status');
    this.resupplyMessage = q('supply-message');
    this.resupplyMessageText = q('supply-message-text');
    this.resupplyAction = q<HTMLButtonElement>('supply-action');
    this.indexLabel = q('supply-index');
    this.hutsError = q('supply-huts-error');
    this.filters = q('supply-filters');
    this.filterButtons = {
      all: q<HTMLButtonElement>('supply-filter-all'),
      food: q<HTMLButtonElement>('supply-filter-food'),
      hut: q<HTMLButtonElement>('supply-filter-hut'),
    };
    this.pointList = q<HTMLOListElement>('supply-points');
    this.pointEmpty = q('supply-empty');
    this.legsWrap = q('supply-legs-wrap');
    this.legList = q<HTMLOListElement>('supply-legs');
    this.warningsWrap = q('supply-warnings-wrap');
    this.warningList = q('supply-warnings');
    this.totals = q('supply-totals');
    this.worstGap = q('supply-worst-gap');
    this.engineDetails = q<HTMLDetailsElement>('supply-engine');
    this.engineList = q('supply-engine-list');
    this.attribution = q('supply-attribution');
    this.note = q('supply-note');

    this.energyMessage = q('energy-message');
    this.energyMessageText = q('energy-message-text');
    this.energyAction = q<HTMLButtonElement>('energy-action');

    // Built here rather than in index.html: it only exists while the numbers
    // come from the built-in default body (B3). The panel is not hidden for
    // it — it is labelled, in place, with the button that fixes it.
    const doc = this.sections.energy.ownerDocument;
    this.energyNotice = doc.createElement('div');
    this.energyNotice.className = 'energy-notice';
    this.energyNotice.hidden = true;
    this.energyNotice.setAttribute('role', 'status');
    this.energyNoticeText = doc.createElement('span');
    this.energyNoticeText.className = 'energy-notice-text';
    this.energyNoticeButton = doc.createElement('button');
    this.energyNoticeButton.type = 'button';
    this.energyNoticeButton.className = 'btn btn-small';
    this.energyNoticeButton.textContent = i18n.t('energy.setOwnNumbers');
    this.energyNoticeButton.addEventListener('click', () => this.handlers.onSettings());
    this.energyNotice.append(this.energyNoticeText, this.energyNoticeButton);
    this.sections.energy.prepend(this.energyNotice);
    this.energyHeadline = q('energy-headline');
    this.energyBody = q('energy-headline-body');
    this.energyChartWrap = q('energy-chart-wrap');
    this.energyRangeTitle = q('energy-range-title');
    this.energyRangeValue = q('energy-range-value');
    this.energyCeiling = q('energy-ceiling');
    this.energyCentre = q('energy-centre');
    this.energyBmr = q('energy-bmr');
    this.energyIntake = q('energy-intake');
    this.energyNote = q('energy-note');
    this.energyBand = requiredSvg(root, 'energy-band');
    this.energyMassWrap = q('energy-mass-wrap');
    this.energyMassTitle = q('energy-mass-title');
    this.energyMassCurve = requiredSvg(root, 'energy-mass-curve');
    this.energyMassLabel = q('energy-mass-label');
    this.energyDays = q('energy-days');
    this.energyFat = q('energy-fat');
    this.assumptionsTitle = q('energy-assumptions-title');
    this.densityInput = q<HTMLInputElement>('energy-density');
    this.densityLabel = q('energy-density-label');
    this.densityHint = q('energy-density-hint');
    this.packInput = q<HTMLInputElement>('energy-pack');
    this.packLabel = q('energy-pack-label');
    this.packHint = q('energy-pack-hint');
    this.foodMass = q('energy-food-mass');

    for (const key of ['all', 'food', 'hut'] as const) {
      this.filterButtons[key].addEventListener('click', () => {
        this.filter = key;
        for (const other of ['all', 'food', 'hut'] as const) {
          this.filterButtons[other].setAttribute('aria-pressed', String(other === key));
        }
        if (this.lastResupply) this.renderPoints(this.lastResupply);
      });
    }
    this.root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        this.handlers.onClose();
        this.handlers.onEscape?.();
      }
    });
    this.close.addEventListener('click', () => this.handlers.onClose());
    this.refresh.addEventListener('click', () => this.handlers.onRefresh());
    this.resupplyAction.addEventListener('click', () => this.runAction());
    this.energyAction.addEventListener('click', () => this.runAction());
    for (const tab of ['resupply', 'energy'] as const) {
      this.tabs[tab].addEventListener('click', () => this.selectTab(tab));
    }
    this.tabs.resupply.addEventListener('keydown', (event) =>
      this.handleTabKey(event, 'resupply'),
    );
    this.tabs.energy.addEventListener('keydown', (event) => this.handleTabKey(event, 'energy'));
    this.radius.addEventListener('change', () => {
      const value = Number(this.radius.value);
      if (!Number.isFinite(value) || value <= 0) return;
      this.radiusM = value;
      this.handlers.onRadius(value);
    });
    const commit = (): void => {
      const density = Number(this.densityInput.value.replace(',', '.'));
      const pack = Number(this.packInput.value.replace(',', '.'));
      const next: EnergyAssumptions = {
        foodKcalPerGram: Number.isFinite(density) && density > 0 ? density : this.assumptions.foodKcalPerGram,
        packMassKg: Number.isFinite(pack) && pack >= 0 ? pack : this.assumptions.packMassKg,
      };
      if (
        next.foodKcalPerGram === this.assumptions.foodKcalPerGram &&
        next.packMassKg === this.assumptions.packMassKg
      ) {
        return;
      }
      this.assumptions = next;
      this.handlers.onAssumptions(next);
    };
    for (const input of [this.densityInput, this.packInput]) {
      input.addEventListener('change', commit);
      input.addEventListener('blur', commit);
    }
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(tab: SupplyTab = 'resupply'): void {
    this.root.hidden = false;
    this.selectTab(tab);
    // Opened from the keyboard or the mouse: land on the active tab so the
    // panel is reachable with Tab and the arrow keys immediately.
    this.tabs[tab].focus();
  }

  hide(): void {
    this.root.hidden = true;
  }

  get activeTab(): SupplyTab {
    return this.tabs.energy.getAttribute('aria-selected') === 'true' ? 'energy' : 'resupply';
  }

  /** The corridor the panel is currently asking for, metres. */
  get corridorRadiusM(): number {
    return this.radiusM;
  }

  selectTab(tab: SupplyTab): void {
    for (const name of ['resupply', 'energy'] as const) {
      const selected = name === tab;
      this.tabs[name].setAttribute('aria-selected', String(selected));
      this.tabs[name].tabIndex = selected ? 0 : -1;
      this.sections[name].hidden = !selected;
    }
  }

  private handleTabKey(event: KeyboardEvent, tab: SupplyTab): void {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next: SupplyTab = tab === 'resupply' ? 'energy' : 'resupply';
    this.selectTab(next);
    this.tabs[next].focus();
  }

  setRadius(radiusM: number, options: readonly number[] = RADIUS_OPTIONS_M): void {
    this.radiusM = radiusM;
    const doc = this.root.ownerDocument;
    const chosen = options.includes(radiusM) ? radiusM : null;
    this.radius.replaceChildren();
    for (const option of options) {
      const element = doc.createElement('option');
      element.value = String(option);
      element.textContent = this.i18n.t('supply.radiusOption', {
        km: this.i18n.format.number(option / 1000, { maximumFractionDigits: 0 }),
      });
      if (option === (chosen ?? options[0])) element.selected = true;
      this.radius.append(element);
    }
  }

  setAssumptions(assumptions: EnergyAssumptions): void {
    this.assumptions = assumptions;
    if (this.densityInput.value === '') {
      this.densityInput.value = String(assumptions.foodKcalPerGram);
    }
    if (this.packInput.value === '') {
      this.packInput.value = String(assumptions.packMassKg);
    }
  }

  private runAction(): void {
    if (this.actionKind === 'settings') this.handlers.onSettings();
    else if (this.actionKind === 'open-route') this.handlers.onOpenRoute();
    else if (this.actionKind === 'retry') this.handlers.onRefresh();
  }

  renderResupply(view: ResupplyViewModel): void {
    this.lastResupply = view;
    this.actionKind = view.action;
    this.root.dataset.resupplyState = view.state;

    this.resupplyStatus.textContent = [view.fetchedLabel, view.statusLine]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' · ');
    this.indexLabel.textContent = view.indexLabel ?? '';
    this.indexLabel.hidden = view.indexLabel === null;
    this.hutsError.textContent = view.hutsError ?? '';
    this.hutsError.hidden = view.hutsError === null;

    this.setMessage(
      this.resupplyMessage,
      this.resupplyMessageText,
      this.resupplyAction,
      view,
    );

    this.renderPoints(view);
    this.renderLegs(view);
    this.renderWarnings(view);
    this.totals.textContent = view.totalsLabel ?? '';
    this.totals.hidden = view.totalsLabel === null;
    this.worstGap.textContent = view.worstGapLabel ?? '';
    this.worstGap.hidden = view.worstGapLabel === null;
    this.worstGap.dataset.danger = String(view.worstGapDanger);
    this.engineDetails.hidden = view.engineWarnings.length === 0;
    this.renderEngineWarnings(view.engineWarnings);
    this.attribution.textContent = view.attribution;
    this.note.textContent = view.note;
    this.pointEmpty.textContent = view.emptyMessage ?? '';
    this.pointEmpty.hidden = view.emptyMessage === null;
  }

  private renderPoints(view: ResupplyViewModel): void {
    const doc = this.root.ownerDocument;
    this.pointList.replaceChildren();
    const food = view.rows.filter((row) => row.countsAsFood).length;
    const huts = view.rows.filter((row) => row.kind === 'hut').length;
    this.filters.hidden = view.rows.length === 0;
    this.filterButtons.all.textContent = this.i18n.t('supply.filterAll', {
      count: this.i18n.format.number(view.rows.length, { maximumFractionDigits: 0 }),
    });
    this.filterButtons.food.textContent = this.i18n.t('supply.filterFood', {
      count: this.i18n.format.number(food, { maximumFractionDigits: 0 }),
    });
    this.filterButtons.hut.textContent = this.i18n.t('supply.filterHuts', {
      count: this.i18n.format.number(huts, { maximumFractionDigits: 0 }),
    });
    // Long routes pass dozens of huts; a filter keeps the shops readable while
    // "Alle" stays the default so nothing is hidden by accident.
    const visible = view.rows.filter((row) =>
      this.filter === 'all'
        ? true
        : this.filter === 'food'
          ? row.countsAsFood
          : row.kind === 'hut',
    );
    for (const row of visible) {
      const item = doc.createElement('li');
      item.className = 'supply-point';
      item.dataset.kind = row.kind;
      item.dataset.usable = String(row.countsAsFood);

      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'supply-point-main';
      // No aria-label: the row's visible text *is* its accessible name, so the
      // announced label always matches what is on screen (WCAG 2.5.3).
      button.addEventListener('click', () => this.handlers.onSelectPoint(row));

      const head = doc.createElement('span');
      head.className = 'supply-point-head';
      const name = doc.createElement('span');
      name.className = 'supply-point-name';
      name.textContent = row.name;
      head.append(name);
      if (!row.countsAsFood) {
        const flag = doc.createElement('span');
        flag.className = 'supply-flag';
        flag.textContent = this.i18n.t('supply.notFood');
        head.append(flag);
      }
      button.append(head);

      const meta = doc.createElement('span');
      meta.className = 'supply-point-meta';
      meta.textContent = [row.kindLabel, row.distanceLabel, row.detourLabel].join(' · ');
      button.append(meta);

      if (row.gapLabel !== null) {
        const gap = doc.createElement('span');
        gap.className = 'supply-point-gap';
        gap.dataset.danger = String(row.gapDanger);
        gap.textContent = this.i18n.t('supply.gapToNext', { gap: row.gapLabel });
        button.append(gap);
      }

      if (row.badges.length > 0) {
        const badges = doc.createElement('span');
        badges.className = 'supply-badges';
        for (const badge of row.badges) {
          const element = doc.createElement('span');
          element.className = 'supply-badge';
          element.textContent = badge;
          badges.append(element);
        }
        button.append(badges);
      }

      const provenance = doc.createElement('span');
      provenance.className = 'supply-provenance';
      provenance.textContent = row.provenanceLabel;
      button.append(provenance);

      item.append(button);

      if (row.warning) {
        const warning = doc.createElement('p');
        warning.className = 'supply-warning';
        warning.setAttribute('role', 'note');
        warning.textContent = row.warning;
        item.append(warning);
      }

      // D1: "ikke bekreftet" is only honest if the user can check it. The link
      // sits outside the row button (a link inside a button is not clickable)
      // and opens in a new tab with no opener and no referrer.
      if (row.checkUrl !== null) {
        const check = doc.createElement('a');
        check.className = 'supply-check';
        check.href = row.checkUrl;
        check.target = '_blank';
        check.rel = 'noopener noreferrer';
        check.textContent = row.checkLabel ?? row.checkUrl;
        item.append(check);
      }
      this.pointList.append(item);
    }
  }

  private renderLegs(view: ResupplyViewModel): void {
    const doc = this.root.ownerDocument;
    this.legList.replaceChildren();
    this.legsWrap.hidden = view.legs.length === 0;
    for (const leg of view.legs) {
      const item = doc.createElement('li');
      item.className = 'supply-leg';
      item.dataset.danger = String(leg.danger);
      const title = doc.createElement('span');
      title.className = 'supply-leg-title';
      title.textContent = leg.title;
      const numbers = doc.createElement('span');
      numbers.className = 'supply-leg-numbers';
      numbers.textContent = leg.numbersLabel;
      item.append(title, numbers);
      if (leg.carryWarning) {
        const warning = doc.createElement('span');
        warning.className = 'supply-warning';
        warning.textContent = leg.carryWarning;
        item.append(warning);
      }
      this.legList.append(item);
    }
  }

  private renderWarnings(view: ResupplyViewModel): void {
    const doc = this.root.ownerDocument;
    this.warningList.replaceChildren();
    this.warningsWrap.hidden = view.warnings.length === 0;
    for (const warning of view.warnings) {
      const item = doc.createElement('li');
      item.className = 'supply-warning-item';
      item.dataset.severity = warning.severity;
      const dot = doc.createElement('span');
      dot.className = 'supply-warning-dot';
      dot.setAttribute('aria-hidden', 'true');
      const text = doc.createElement('span');
      text.textContent = warning.text;
      item.append(dot, text);
      this.warningList.append(item);
    }
  }

  private renderEngineWarnings(warnings: readonly string[]): void {
    const doc = this.root.ownerDocument;
    this.engineList.replaceChildren();
    for (const warning of warnings) {
      const item = doc.createElement('li');
      item.textContent = warning;
      this.engineList.append(item);
    }
    if (warnings.length > 0) {
      const summary = this.engineDetails.querySelector('summary');
      if (summary) summary.textContent = this.i18n.t('supply.engineWarnings');
    }
  }

  /** One visible block per section: the message, its detail and its action. */
  private setMessage(
    wrap: HTMLElement,
    text: HTMLElement,
    action: HTMLButtonElement,
    view: ResupplyViewModel | EnergyViewModel,
  ): void {
    const show = view.message !== null;
    wrap.hidden = !show;
    text.textContent = view.message ?? '';
    if (view.detail) wrap.title = view.detail;
    else wrap.removeAttribute('title');
    action.hidden = view.action === 'none' || view.action === 'retry';
    action.textContent =
      view.action === 'open-route'
        ? this.i18n.t('action.openGpx')
        : this.i18n.t('supply.openSettings');
  }

  renderEnergy(view: EnergyViewModel): void {
    this.root.dataset.energyState = view.state;
    this.setMessage(this.energyMessage, this.energyMessageText, this.energyAction, view);

    // The placeholder-body badge, always re-stated, in the current language.
    this.energyNotice.hidden = view.profileNotice === null;
    this.energyNoticeText.textContent = view.profileNotice ?? '';
    this.energyNoticeButton.textContent = this.i18n.t('energy.setOwnNumbers');

    this.energyRangeTitle.textContent = view.rangeTitle;
    this.assumptionsTitle.textContent = view.assumptionsTitle;
    this.densityLabel.textContent = view.foodDensityLabel;
    this.densityHint.textContent = view.foodDensityHint;
    this.packLabel.textContent = view.packMassLabel;
    this.packHint.textContent = view.packMassHint;
    this.energyNote.textContent = view.rangeNote;
    this.energyMassTitle.textContent = view.massTitle;

    const disabled = view.state !== 'ready';
    this.energyChartWrap.hidden = disabled;
    this.energyMassWrap.hidden = disabled;
    this.energyMassCurve.toggleAttribute('hidden', disabled || view.curve.length < 2);
    this.energyHeadline.hidden = disabled;
    this.energyBody.hidden = disabled || view.headlineBody === null;
    this.foodMass.hidden = disabled;

    if (disabled) {
      this.energyHeadline.textContent = '';
      this.energyBody.textContent = '';
      this.energyRangeValue.textContent = '';
      this.energyCeiling.textContent = '';
      this.energyCentre.textContent = '';
      this.energyBmr.textContent = '';
      this.energyIntake.textContent = '';
      this.energyMassLabel.textContent = '';
      this.energyDays.textContent = '';
      this.energyFat.textContent = '';
      this.foodMass.textContent = '';
      this.energyBand.replaceChildren();
      this.energyMassCurve.replaceChildren();
      return;
    }

    this.energyHeadline.textContent = view.headline;
    this.energyHeadline.dataset.verdict = view.unsustainable ? 'unavoidable' : 'ok';
    this.energyBody.textContent = view.headlineBody ?? '';
    this.energyRangeValue.textContent = view.rangeLabel ?? '';
    this.energyCeiling.textContent = view.ceilingLabel ?? '';
    this.energyCentre.textContent = view.centreLabel ?? '';
    this.energyBmr.textContent = view.bmrLabel ?? '';
    this.energyIntake.textContent = view.intakeLabel ?? '';
    this.energyMassLabel.textContent = view.massLabel ?? '';
    this.energyDays.textContent = view.daysLabel ?? '';
    this.energyFat.textContent = view.fatNote ?? '';
    this.foodMass.textContent = view.foodMassLabel ?? '';
    this.foodMass.hidden = view.foodMassLabel === null;
    if (view.band) this.drawBand(view.band, view.rangeLabel ?? '');
    this.drawCurve(view.curve, view.massLabel ?? '');
    if (view.assumptions) this.setAssumptions(view.assumptions);
  }

  /**
   * The range band, the ceiling line and the midpoint, on one axis.
   *
   * The band is the model's spread (×0.75–×1.30) and is the widest element on
   * purpose: a single tick is exactly what this panel must not reduce to. The
   * ceiling is drawn heavier and dashed because it decides whether you can eat
   * enough at all.
   */
  private drawBand(band: NonNullable<EnergyViewModel['band']>, label: string): void {
    const svg = this.energyBand;
    svg.replaceChildren();
    svg.setAttribute('viewBox', '0 0 300 52');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
    const base = svg.ownerDocument;
    const x = (value: number): number => clamp((value / band.max) * 276, 0, 276) + 12;
    const left = x(band.low);
    const right = x(band.high);

    svg.append(
      svgLine(base, 12, 30, 288, 30, 'energy-axis'),
      svgRect(base, left, 18, Math.max(4, right - left), 24, 'energy-range'),
      svgLine(base, left, 14, left, 42, 'energy-band-edge'),
      svgLine(base, right, 14, right, 42, 'energy-band-edge'),
      svgLine(base, x(band.centre), 12, x(band.centre), 44, 'energy-centre'),
      svgLine(base, x(band.ceiling), 6, x(band.ceiling), 50, 'energy-ceiling'),
    );
  }

  /**
   * Projected body mass over the trip, scaled to the trip's own change so the
   * shape is readable. The total is printed underneath: the axis deliberately
   * has no gridlines, because a gridline would imply a precision the model
   * does not have.
   */
  private drawCurve(curve: readonly MassPoint[], label: string): void {
    const svg = this.energyMassCurve;
    svg.replaceChildren();
    if (curve.length < 2) return;
    svg.setAttribute('viewBox', '0 0 300 64');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
    const base = svg.ownerDocument;
    const last = curve[curve.length - 1];
    const maxDays = Math.max(1, last.day);
    const minKg = Math.min(...curve.map((point) => point.kg));
    const loss = Math.max(0.2, Math.abs(minKg));
    const px = (day: number): number => 12 + (day / maxDays) * 276;
    const py = (kg: number): number => 10 + (Math.abs(kg) / loss) * 40;

    // Zero line on top: mass only ever goes one way when you cannot eat enough.
    svg.append(
      svgLine(base, 12, 10, 288, 10, 'energy-axis'),
      svgLine(base, 12, 50, 288, 50, 'energy-axis-muted'),
    );
    const points = curve.map((point) => `${px(point.day).toFixed(1)},${py(point.kg).toFixed(1)}`);
    const path = base.createElementNS(SVG_NS, 'polyline');
    path.setAttribute('points', points.join(' '));
    path.setAttribute('class', 'energy-curve');
    svg.append(path);
    const end = base.createElementNS(SVG_NS, 'circle');
    end.setAttribute('cx', px(last.day).toFixed(1));
    end.setAttribute('cy', py(last.kg).toFixed(1));
    end.setAttribute('r', '3');
    end.setAttribute('class', 'energy-curve-dot');
    svg.append(end);
  }
}

function required<T extends HTMLElement = HTMLElement>(root: HTMLElement, id: string): T {
  const element = root.querySelector<T>(`#${id}`);
  if (!element) throw new Error(`supply panel is missing #${id}`);
  return element;
}

function requiredSvg(root: HTMLElement, id: string): SVGSVGElement {
  const element = root.querySelector<SVGSVGElement>(`#${id}`);
  if (!element) throw new Error(`supply panel is missing #${id}`);
  return element;
}

function svgLine(
  document: Document,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  className: string,
): SVGLineElement {
  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('x1', x1.toFixed(1));
  line.setAttribute('y1', String(y1));
  line.setAttribute('x2', x2.toFixed(1));
  line.setAttribute('y2', String(y2));
  line.setAttribute('class', className);
  return line;
}

function svgRect(
  document: Document,
  x: number,
  y: number,
  width: number,
  height: number,
  className: string,
): SVGRectElement {
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('x', x.toFixed(1));
  rect.setAttribute('y', String(y));
  rect.setAttribute('width', width.toFixed(1));
  rect.setAttribute('height', String(height));
  rect.setAttribute('rx', '4');
  rect.setAttribute('class', className);
  return rect;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The map's hover/select card: the same facts as a list row, in one small box.
 *
 * Built as DOM (never HTML) so a shop name from OSM cannot inject markup.
 */
export function buildResupplyCard(
  document_: Document,
  row: ResupplyRowView,
  i18n: Pick<I18n, 't'>,
): HTMLElement {
  const card = document_.createElement('div');
  card.className = 'map-card';
  card.dataset.kind = row.kind;

  const title = document_.createElement('strong');
  title.className = 'map-card-title';
  title.textContent = row.name;
  card.append(title);

  const kind = document_.createElement('span');
  kind.className = 'map-card-line';
  kind.textContent = row.kindLabel;
  card.append(kind);

  const distance = document_.createElement('span');
  distance.className = 'map-card-line';
  distance.textContent = `${row.distanceLabel} · ${row.detourLabel}`;
  card.append(distance);

  if (row.gapLabel !== null) {
    const gap = document_.createElement('span');
    gap.className = 'map-card-line';
    gap.dataset.danger = String(row.gapDanger);
    gap.textContent = i18n.t('supply.gapToNext', { gap: row.gapLabel });
    card.append(gap);
  }

  const badges = document_.createElement('span');
  badges.className = 'map-card-badges';
  badges.textContent = row.badges.join(' · ');
  if (row.badges.length > 0) card.append(badges);

  const provenance = document_.createElement('span');
  provenance.className = 'map-card-provenance';
  provenance.textContent = row.provenanceLabel;
  card.append(provenance);
  return card;
}

export { RADIUS_OPTIONS_M };
