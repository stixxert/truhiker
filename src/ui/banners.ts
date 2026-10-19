/**
 * Visible degradation states.
 *
 * Every failure in this app becomes a banner: a failed basemap cache, missing
 * terrain, a DEM outage, an unreadable GPX. There is deliberately no code path
 * that swallows a fetch error and leaves the screen unchanged.
 */

type BannerKind = 'info' | 'warning' | 'error';

interface BannerAction {
  label: string;
  onClick: () => void;
}

/** The same banner's words, produced again in whatever language is current. */
interface BannerText {
  message: string;
  /** Full technical detail, shown as a tooltip rather than in the banner. */
  detail?: string | null;
  /** New label for the action button; the handler stays as it was. */
  actionLabel?: string | null;
}

interface BannerSpec {
  id: string;
  kind: BannerKind;
  message: string;
  /** Full technical detail, shown as a tooltip rather than in the banner. */
  detail?: string;
  action?: BannerAction;
  dismissible?: boolean;
  /**
   * How to say this banner again after a language change (D8).
   *
   * A banner is a *state*, not a message: a quota error the user still has to
   * act on must not disappear — or stay in the old language — because they
   * switched to English. Banners whose text the app can rebuild from `state`
   * (map, basemap, DEM) do not need this; the ones caused by a one-off event do.
   */
  retext?: () => BannerText;
}

interface BannerEntry {
  spec: BannerSpec;
  element: HTMLElement;
}

export class BannerHost {
  private readonly container: HTMLElement;
  private readonly entries = new Map<string, BannerEntry>();
  private closeLabel: string;

  constructor(container: HTMLElement, closeLabel: string) {
    this.container = container;
    this.closeLabel = closeLabel;
  }

  show(spec: BannerSpec): void {
    this.dismiss(spec.id);
    const element = document.createElement('div');
    element.className = `banner banner--${spec.kind}`;
    element.dataset.bannerId = spec.id;
    element.setAttribute('role', spec.kind === 'error' ? 'alert' : 'status');
    if (spec.detail) element.title = spec.detail;

    const dot = document.createElement('span');
    dot.className = 'banner-dot';
    dot.setAttribute('aria-hidden', 'true');
    element.append(dot);

    const text = document.createElement('p');
    text.className = 'banner-text';
    text.textContent = spec.message;
    element.append(text);

    if (spec.action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'banner-action';
      button.textContent = spec.action.label;
      button.addEventListener('click', spec.action.onClick);
      element.append(button);
    }

    if (spec.dismissible !== false) {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'banner-close';
      close.setAttribute('aria-label', this.closeLabel);
      close.textContent = '×';
      close.addEventListener('click', () => this.dismiss(spec.id));
      element.append(close);
    }

    this.container.append(element);
    this.entries.set(spec.id, { spec, element });
    this.container.hidden = false;
  }

  dismiss(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.element.remove();
    this.entries.delete(id);
    if (this.entries.size === 0) this.container.hidden = true;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  clear(): void {
    for (const id of [...this.entries.keys()]) this.dismiss(id);
  }

  /** Close-label localisation hook, applied when the language changes. */
  setCloseLabel(label: string): void {
    this.closeLabel = label;
    for (const entry of this.entries.values()) {
      entry.element.querySelector<HTMLButtonElement>('.banner-close')?.setAttribute('aria-label', label);
    }
  }

  /**
   * Re-word every live banner in place — same position, same action handler.
   *
   * Called on a language change. Banners without a `retext` source (the ones
   * `refreshBanners()` rebuilds from `this.state`) are left to the app.
   */
  refreshLanguage(): void {
    for (const entry of this.entries.values()) {
      const next = entry.spec.retext?.();
      if (!next) continue;
      entry.spec = {
        ...entry.spec,
        message: next.message,
        detail: next.detail ?? entry.spec.detail,
        action:
          entry.spec.action && next.actionLabel
            ? { ...entry.spec.action, label: next.actionLabel }
            : entry.spec.action,
      };
      const paragraph = entry.element.querySelector<HTMLElement>('.banner-text');
      if (paragraph) paragraph.textContent = next.message;
      if (next.detail) entry.element.title = next.detail;
      const button = entry.element.querySelector<HTMLButtonElement>('.banner-action');
      if (button && next.actionLabel) button.textContent = next.actionLabel;
    }
  }

  get specs(): BannerSpec[] {
    return [...this.entries.values()].map((entry) => entry.spec);
  }
}
