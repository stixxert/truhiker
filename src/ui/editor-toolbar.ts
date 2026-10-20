/**
 * The route-editing toolbar.
 *
 * One bar over the map with the mode switch (Vis / Tegn / Rediger), undo/redo,
 * the snap toggle and radius, the selection actions (delete point, split,
 * reverse, trim, delete leg, rename), reroute, and two status lines: what the
 * cursor is snapping to, and which stretches of the route are off-trail.
 *
 * The bar renders a model and reports intent; it never touches the trip. The
 * enable/disable rules come from `availableCommands()` in `editor-state.ts`, so
 * a button can only be enabled when the corresponding command is valid.
 */

import type { CommandAvailability, InteractionMode } from '../app/editor-state';
import type { I18n } from '../i18n';

export type EditorAction =
  | 'delete-vertex'
  | 'split'
  | 'reverse'
  | 'trim'
  | 'delete-leg'
  | 'reroute'
  | 'route'
  | 'rename';

interface EditorToolbarModel {
  /** False when the engines are missing or no trip is loaded. */
  available: boolean;
  mode: InteractionMode;
  snapping: boolean;
  radiusM: number;
  canUndo: boolean;
  canRedo: boolean;
  commands: CommandAvailability;
  selectionLabel: string | null;
  legName: string;
  /** Live snap indicator, e.g. "snapper til jot21 · Memurubu–Glitterheim". */
  snapIndicator: string;
  /** Machine-readable indicator state; drives mobile visibility. */
  snapState: 'off' | 'loading' | 'failed' | 'idle' | 'hit' | 'miss' | 'ready';
  /** Badge text for off-trail stretches. */
  offTrailLabel: string;
  /** Off-trail detail lines (one per stretch). */
  offTrailSpans: readonly string[];
  hint: string;
  vertexCount: number;
  renameEnabled: boolean;
}

interface EditorToolbarHandlers {
  onMode: (mode: InteractionMode) => void;
  onSnapToggle: (enabled: boolean) => void;
  onRadius: (radiusM: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onAction: (action: EditorAction) => void;
  onRename: (name: string) => void;
}

const ACTION_IDS: Record<Exclude<EditorAction, 'rename'>, string> = {
  'delete-vertex': 'btn-vertex-delete',
  split: 'btn-split',
  reverse: 'btn-reverse',
  trim: 'btn-trim',
  'delete-leg': 'btn-leg-delete',
  reroute: 'btn-reroute',
  route: 'btn-route',
};

const ACTION_FLAGS = {
  'delete-vertex': 'canDeleteVertex',
  split: 'canSplit',
  reverse: 'canReverse',
  trim: 'canTrim',
  'delete-leg': 'canDeleteLeg',
  reroute: 'canReroute',
  route: 'canRoute',
} as const;

export class EditorToolbar {
  private readonly root: HTMLElement;
  private readonly i18n: I18n;
  private readonly handlers: EditorToolbarHandlers;
  private readonly modeButtons: HTMLButtonElement[];
  private readonly snapToggle: HTMLInputElement;
  private readonly radius: HTMLInputElement;
  private readonly undo: HTMLButtonElement;
  private readonly redo: HTMLButtonElement;
  private readonly actionsRow: HTMLElement;
  private readonly actionButtons: Map<EditorAction, HTMLButtonElement>;
  private readonly selectionLabel: HTMLElement;
  private readonly legNameInput: HTMLInputElement;
  private readonly renameButton: HTMLButtonElement;
  private readonly legNameField: HTMLElement;
  private readonly snapIndicator: HTMLElement;
  private readonly offTrail: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly count: HTMLElement;

  /**
   * @param dock The editor dock, when the actions live there rather than in the
   *   bar. The bar keeps modes, history and the snap controls; the dock holds
   *   what can be done to the selected object.
   */
  constructor(
    root: HTMLElement,
    i18n: I18n,
    handlers: EditorToolbarHandlers,
    dock: HTMLElement = root,
  ) {
    this.root = root;
    this.i18n = i18n;
    this.handlers = handlers;
    this.modeButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-mode]')];
    this.snapToggle = required<HTMLInputElement>(dock, 'snap-enabled');
    this.radius = required<HTMLInputElement>(dock, 'snap-radius');
    this.undo = required<HTMLButtonElement>(root, 'btn-undo');
    this.redo = required<HTMLButtonElement>(root, 'btn-redo');
    this.actionsRow = required(dock, 'editor-actions');
    this.selectionLabel = required(dock, 'editor-selection');
    this.legNameInput = required<HTMLInputElement>(dock, 'leg-name');
    this.renameButton = required<HTMLButtonElement>(dock, 'editor-rename-apply');
    this.legNameField = this.legNameInput.closest('.leg-name') ?? this.legNameInput;
    this.snapIndicator = required(dock, 'snap-indicator');
    this.offTrail = required(dock, 'offtrail-legend');
    this.hint = required(dock, 'editor-hint');
    this.count = required(dock, 'editor-count');

    this.actionButtons = new Map();
    for (const [action, id] of Object.entries(ACTION_IDS) as Array<
      [Exclude<EditorAction, 'rename'>, string]
    >) {
      const button = required<HTMLButtonElement>(dock, id);
      this.actionButtons.set(action, button);
      button.addEventListener('click', () => this.handlers.onAction(action));
    }

    for (const button of this.modeButtons) {
      button.addEventListener('click', () => {
        const mode = button.dataset.mode;
        if (mode === 'view' || mode === 'draw' || mode === 'edit') this.handlers.onMode(mode);
      });
    }
    this.snapToggle.addEventListener('change', () =>
      this.handlers.onSnapToggle(this.snapToggle.checked),
    );
    this.radius.addEventListener('change', () => this.handlers.onRadius(Number(this.radius.value)));
    this.undo.addEventListener('click', () => this.handlers.onUndo());
    this.redo.addEventListener('click', () => this.handlers.onRedo());
    this.renameButton.addEventListener('click', () => this.submitRename());
    this.legNameInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this.submitRename();
    });
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  render(model: EditorToolbarModel): void {
    this.root.dataset.mode = model.mode;
    this.root.dataset.available = model.available ? 'true' : 'false';

    for (const button of this.modeButtons) {
      const pressed = button.dataset.mode === model.mode;
      button.setAttribute('aria-pressed', String(pressed));
      button.disabled = !model.available;
    }
    this.snapToggle.checked = model.snapping;
    this.snapToggle.disabled = !model.available;
    this.radius.disabled = !model.available;
    if (this.root.ownerDocument.activeElement !== this.radius) {
      this.radius.value = String(model.radiusM);
    }
    this.undo.disabled = !model.available || !model.canUndo;
    this.redo.disabled = !model.available || !model.canRedo;

    const showActions = model.available && model.mode === 'edit';
    // Show only what applies to the current selection. A row of greyed-out verbs
    // is a menu the user has to read; a toolbar shows the three things that can
    // be done now. The enable rules still come from `availableCommands()`.
    let visibleActions = 0;
    for (const [action, flag] of Object.entries(ACTION_FLAGS) as Array<
      [keyof typeof ACTION_FLAGS, keyof CommandAvailability]
    >) {
      const button = this.actionButtons.get(action);
      if (!button) continue;
      const enabled = showActions && model.commands[flag];
      button.disabled = !enabled;
      button.hidden = !enabled;
      if (enabled) visibleActions += 1;
    }

    this.selectionLabel.textContent = model.selectionLabel ?? '';
    if (this.root.ownerDocument.activeElement !== this.legNameInput) {
      this.legNameInput.value = model.legName;
    }
    const rename = showActions && model.renameEnabled;
    this.legNameField.hidden = !rename;
    this.renameButton.hidden = !rename;
    this.legNameInput.disabled = !rename;
    this.renameButton.disabled = !rename;
    if (rename) visibleActions += 1;
    this.actionsRow.hidden = visibleActions === 0;

    // The bar shows a state word; the sentence belongs in the title. A truncated
    // sentence ("loading the trail net…") reads as broken chrome, not as status.
    this.snapIndicator.textContent = this.i18n.t(`editor.snapState.${model.snapState}` as never);
    if (model.snapIndicator) this.snapIndicator.title = model.snapIndicator;
    else this.snapIndicator.removeAttribute('title');
    this.snapIndicator.dataset.state = model.snapState;
    this.offTrail.replaceChildren();
    if (model.offTrailSpans.length === 0) {
      const span = this.root.ownerDocument.createElement('span');
      span.className = 'offtrail-summary is-clear';
      span.textContent = model.offTrailLabel;
      this.offTrail.append(span);
    } else {
      const summary = this.root.ownerDocument.createElement('span');
      summary.className = 'offtrail-summary';
      summary.textContent = model.offTrailLabel;
      this.offTrail.append(summary);
      for (const label of model.offTrailSpans) {
        const chip = this.root.ownerDocument.createElement('span');
        chip.className = 'offtrail-chip';
        chip.textContent = label;
        this.offTrail.append(chip);
      }
    }
    this.hint.textContent = model.hint;
    this.count.textContent = model.vertexCount > 0
      ? this.i18n.t('editor.vertexCount', { n: model.vertexCount })
      : '';
  }

  private submitRename(): void {
    const name = this.legNameInput.value.trim();
    if (name.length === 0) return;
    this.handlers.onRename(name);
  }
}

function required<T extends HTMLElement = HTMLElement>(root: HTMLElement, id: string): T {
  const element = root.querySelector<T>(`#${id}`);
  if (!element) throw new Error(`editor toolbar is missing #${id}`);
  return element;
}
