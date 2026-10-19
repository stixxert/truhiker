/**
 * Visible degradation states.
 *
 * Every failure in this app becomes a banner: a failed basemap cache, missing
 * terrain, a DEM outage, an unreadable GPX. There is deliberately no code path
 * that swallows a fetch error and leaves the screen unchanged.
 */

export type BannerKind = 'info' | 'warning' | 'error';

export interface BannerAction {
  label: string;
  onClick: () => void;
}

export interface BannerSpec {
  id: string;
  kind: BannerKind;
  message: string;
  /** Full technical detail, shown as a tooltip rather than in the banner. */
  detail?: string;
  action?: BannerAction;
  dismissible?: boolean;
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

  get specs(): BannerSpec[] {
    return [...this.entries.values()].map((entry) => entry.spec);
  }
}
