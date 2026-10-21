/**
 * The application shell: owns state, wires the map to the profile, and keeps
 * every degradation visible.
 *
 * State flow, in one line: GPX → `buildRoute` (map geometry) → worker DEM
 * sampling → `buildProfile` (numbers) → stats bar + chart → cursor ↔ map.
 */

import { parseGpx, type GpxTrack } from '../core/gpx';
import { buildProfile, seaLevelWarning, type Profile } from '../core/profile';
import { haversine, type LonLat } from '../core/geo';
import {
  StoreError,
  type RoutePoint,
  type Trip,
  type UserProfile,
} from '../contracts';
import {
  DEFAULT_PACE,
  PACE_LIMITS,
  naismithMinutes,
  normalizePace,
  type Pace,
} from '../lib/format';
import { elevationAtDistance, gradeAtDistance } from '../lib/chart';
import { createElevationJob, type ElevationJob, type ElevationProgress } from '../lib/elevation-client';
import {
  MAX_HASH_CHARS,
  compactGpx,
  decodeRouteHash,
  encodeRouteHash,
  hasRouteHash,
} from '../lib/share';
import {
  buildRoute,
  checkSupported,
  pickTrack,
  type Route,
  type RouteOrigin,
} from '../lib/route';
import { nearestRoutePoint, pointAtDistance } from '../lib/sync';
import {
  createI18n,
  readStoredLang,
  resolveLang,
  storeLang,
  type I18n,
  type Lang,
} from '../i18n';
import {
  MapController,
  type BasemapState,
  type CameraInfo,
  type TerrainState,
} from '../map/map-controller';
import { todayInOslo } from '../weather';
import { BannerHost } from '../ui/banners';
import { loadPace, savePace } from '../ui/pace-store';
import { ProfileChart, type CursorSource } from '../ui/profile-chart';
import { StatsBar } from '../ui/stats';
import { WeatherPanel } from '../ui/weather-panel';
import { SupplyPanel, buildPlaceCard, buildResupplyCard, type SupplyTab } from '../ui/supply-panel';
import {
  DEFAULT_RADIUS_M,
  buildResupplyView,
  candidateKey,
  countsAsFoodPlace,
  placeCardModel,
  type ResupplyPanelState,
  type ResupplyRowView,
} from '../ui/resupply-view';
import {
  DEFAULT_FOOD_KCAL_PER_G,
  buildEnergyView,
  computeEnergyModel,
  placeholderProfileNotice,
  type EnergyAssumptions,
  type EnergyPanelState,
} from '../ui/energy-view';
import {
  SupplyService,
  mergePlacesForView,
  placesDrawBounds,
} from './supply-service';
import { loadShopIndex, planResupplyForTrip, type ResupplyCandidate } from '../resupply';
import { TripLibraryDialog } from '../ui/trip-library';
import { TripSettingsDialog } from '../ui/trip-settings';
import { EditorToolbar, type EditorAction } from '../ui/editor-toolbar';
import { isPendingSave, saveStatusDetail, saveStatusText } from '../ui/save-status';
import { storeErrorDetail, storeErrorText } from '../ui/store-error';
import { buildTripLibraryView } from '../ui/trip-library-view';
import type { WeatherPanelState } from '../ui/weather-view';
import { MemoryWeatherCache } from '../lib/weather-cache';
import { findLeg, flattenTrip } from '../lib/trip-route';
import { loadTrailNetwork, type TrailNetworkFailureCode } from '../route/trail-network';
import {
  routeBetweenLines,
  type RouteBetweenResult,
  type RoutingFailureCode,
} from '../route/trail-routing';
import { snapRouteLabel } from '../lib/snap-label';
import { loadEngines } from './engine-loader';
import { DOCUMENTED_HORIZON_DAYS, type EngineSurface } from './engine-types';
import { TripSession, type SaveStatus } from './trip-session';
import {
  availableCommands,
  clearSelection,
  deleteLegCommand,
  deleteVertexCommand,
  drawStepCommand,
  editorKeyAction,
  initialEditorState,
  insertVertexCommand,
  moveVertexCommand,
  noteDrawnPoint,
  renameCommand,
  reverseCommand,
  selectLeg,
  selectVertex,
  setMode,
  setRadius,
  setSnapping,
  shouldPrefetchSnap,
  splitCommand,
  trimCommand,
  type EditorUiState,
  type InteractionMode,
} from './editor-state';
import { SnapService } from './snap-service';
import { EditOverlay, type OffTrailSegment } from '../map/edit-overlay';
import type { SnapResult } from '../snap';
import { buildTrailGraph, type TrailGraph } from '../route/trail-graph';
import { routeBetweenPoints } from '../route/trail-routing';
import { trailLinesToGeoJson } from '../snap/overlay';

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const ZOOM_STEP = 1;
/**
 * Two clicks at the same spot, i.e. a double-click: the second one commits a
 * vertex on top of the first, and finishing drops it. 20 m is far enough that a
 * deliberate short step survives, close enough that a double-click does not.
 */
const FINISH_DUPLICATE_M = 20;

type ProfileStatus = 'empty' | 'loading' | 'ready' | 'error';
type ProfileErrorKind = 'dem' | 'scope';

/**
 * `fetch` that resolves an app-absolute path against `document.baseURI`.
 *
 * The bundled shop index is requested as `/data/shops.osm.bin`; on a host that
 * serves the app from a sub-path, that absolute path points at the domain root
 * and 404s. Everything else passes through untouched.
 */
function baseAwareFetch(fetchImpl: typeof fetch): typeof fetch {
  return (input, init) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      return fetchImpl(new URL(input.replace(/^\//, ''), document.baseURI).toString(), init);
    }
    return fetchImpl(input, init);
  };
}

interface AppState {
  route: Route | null;
  profile: Profile | null;
  profileStatus: ProfileStatus;
  profileError: ProfileErrorKind | null;
  profileErrorMessage: string;
  progress: ElevationProgress;
  terrain: TerrainState;
  basemap: BasemapState;
  fatal: string | null;
  cursorDistance: number | null;
  cursorSource: CursorSource;
  /** When the live DEM finished sampling — provenance for the numbers. */
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`index.html is missing #${id}`);
  return element as T;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A banner gets one line. URLs and retry logs belong in the tooltip, not in the
 * visible message — a public app should not shout query strings at people.
 */
/** Weather failures are upstream states, not product copy.
 *
 * The MET client reports machine states ("requested time 2026-10-20T10:00:00Z
 * precedes MET's series, which starts ..."). That text is English, carries an ISO
 * timestamp, and is 150 characters wide in a 209 px cell — it must never be the
 * sentence a Norwegian user reads. The raw reason stays available as the title.
 */
function weatherFailure(error: unknown, i18n: I18n): { message: string; detail?: string } {
  const raw = messageOf(error);
  if (/precedes MET's series|starts .*T\d/i.test(raw)) {
    return { message: i18n.t('weather.beforeSeries'), detail: raw };
  }
  if (/past .*series|beyond the .* series|horizon/i.test(raw)) {
    return { message: i18n.t('weather.afterSeries'), detail: raw };
  }
  if (/fetch|network|abort|timeout|ENOTFOUND|ECONN/i.test(raw)) {
    return { message: i18n.t('weather.network'), detail: raw };
  }
  return { message: i18n.t('weather.failed'), detail: raw };
}

function briefError(message: string): string {
  const http = /\bHTTP (\d{3})\b/.exec(message);
  if (http) return `HTTP ${http[1]}`;
  if (/abort|timed? ?out/i.test(message)) return 'timeout';
  const firstLine = message.split('\n')[0].trim();
  return firstLine.length > 90 ? `${firstLine.slice(0, 87)}…` : firstLine;
}

function minMaxElevation(profile: Profile): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const sample of profile.samples) {
    if (!Number.isFinite(sample.ele)) continue;
    if (sample.ele < min) min = sample.ele;
    if (sample.ele > max) max = sample.ele;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: Number.NaN, max: Number.NaN };
  }
  return { min, max };
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // Sandboxed iframe or blocked storage: everything still works, it just
    // will not remember the language or the pace.
    return null;
  }
}

export class App {
  private readonly doc: Document;
  private readonly storage = safeStorage();
  private readonly i18n: I18n;

  private pace: Pace;
  private map: MapController | null = null;
  private chart!: ProfileChart;
  private stats!: StatsBar;
  private banners!: BannerHost;
  private job: ElevationJob | null = null;
  private markerFrame = 0;
  private pendingMarker: LonLat | null = null;

  // Phase 3 — trips, weather, editing
  private engines: EngineSurface | null = null;
  private engineError: string | null = null;
  private session: TripSession | null = null;
  private snapService: SnapService | null = null;
  private overlay: EditOverlay | null = null;
  private toolbar: EditorToolbar | null = null;
  private weatherPanel: WeatherPanel | null = null;
  /** What the user asked for: the trip's own dates, or a quick look from today. */
  private weatherFrom: 'trip' | 'now' = 'trip';
  /**
   * What is actually on screen. A trip without a start date can only be shown as
   * a quick look, but that must not overwrite the preference: set a start date and
   * the panel should return to the trip timeline, not stay in quick look.
   */
  private weatherFromEffective: 'trip' | 'now' = 'trip';
  private trips: TripLibraryDialog | null = null;
  private settings: TripSettingsDialog | null = null;
  private editorUi: EditorUiState = initialEditorState(null);
  /**
   * The mode is the user's until they change it. Trip-state resets (adopting a
   * saved trip, re-reading one after a save, the routing flow) rebuild the
   * editor state from scratch; without this, any of them could silently drop a
   * user out of Draw or Edit mid-task.
   */
  private editorMode: InteractionMode = 'view';
  private snapTrackerLine: string | null = null;
  /** The trail graph built from the indexed lines, keyed by the index's shape. */
  private trailGraph: { key: string; graph: TrailGraph } | null = null;
  private routePick: { start: LonLat | null; busy: boolean } | null = null;
  private snapIndicatorSnap: SnapResult | null = null;
  private snapHovering = false;
  private weatherState: WeatherPanelState = { kind: 'no-trip' };
  private supplyPanel: SupplyPanel | null = null;
  private supplyService: SupplyService | null = null;
  private supplyState: ResupplyPanelState = { kind: 'no-trip' };
  private supplyRows: readonly ResupplyRowView[] = [];
  private supplyRadius = DEFAULT_RADIUS_M;
  private supplyToken = 0;
  private energyAssumptions: EnergyAssumptions = {
    foodKcalPerGram: DEFAULT_FOOD_KCAL_PER_G,
    packMassKg: 12,
  };
  /** Once the user edits the assumptions, a profile change stops overwriting them. */
  private energyEdited = false;
  /** Signature of the trip/route the current resupply plan was built against. */
  private supplySig = '';
  /** Places in the current view (shops always, huts at zoom >= 12). */
  private places: readonly ResupplyCandidate[] = [];
  private placesToken = 0;
  private placesTimer: number | null = null;
  private horizonDays = DOCUMENTED_HORIZON_DAYS;
  private readonly weatherCache = new MemoryWeatherCache();
  private weatherToken = 0;
  private offTrailLabels: string[] = [];
  private offTrailComputed = false;
  private geometryTimer: number | null = null;
  private offTrailTimer: number | null = null;
  private weatherTimer: number | null = null;
  private snapTimer: number | null = null;
  private editorFrame = 0;
  private lastSaveBanner: string | null = null;
  /** Guards the async trip-library render against out-of-order results. */
  private tripRenderToken = 0;

  private readonly state: AppState = {
    route: null,
    profile: null,
    profileStatus: 'empty',
    profileError: null,
    profileErrorMessage: '',
    progress: { done: 0, total: 0, phase: 'download' },
    terrain: { status: 'probing' },
    basemap: { status: 'ok' },
    fatal: null,
    cursorDistance: null,
    cursorSource: 'map',
  };

  private readonly elements: {
    mapContainer: HTMLElement;
    profilePanel: HTMLElement;
    profileBody: HTMLElement;
    profileToggle: HTMLButtonElement;
    profileStatus: HTMLElement;
    profileReadout: HTMLElement;
    profileOverlay: HTMLElement;
    profileOverlayTitle: HTMLElement;
    profileOverlayDetail: HTMLElement;
    profileProgress: HTMLElement;
    profileRetry: HTMLButtonElement;
    profileChart: HTMLElement;
    profileCanvas: HTMLCanvasElement;
    stats: HTMLElement;
    emptyState: HTMLElement;
    mapFatal: HTMLElement;
    mapFatalMessage: HTMLElement;
    dropzone: HTMLElement;
    routeMeta: HTMLElement;
    routeName: HTMLElement;
    routeTag: HTMLElement;
    attribBasemap: HTMLAnchorElement;
    fileInput: HTMLInputElement;
    terrainButton: HTMLButtonElement;
    terrainHint: HTMLElement;
    langButtons: HTMLButtonElement[];
    basemapButtons: HTMLButtonElement[];
    aboutDialog: HTMLDialogElement;
    paceDialog: HTMLDialogElement;
    paceForm: HTMLFormElement;
    paceSpeed: HTMLInputElement;
    paceAscent: HTMLInputElement;
    paceError: HTMLElement;
    paceHint: HTMLElement;
    toast: HTMLElement;
    saveButton: HTMLButtonElement;
    saveStatus: HTMLElement;
    downloadGpxButton: HTMLButtonElement;
    tripsButton: HTMLButtonElement;
    weatherButton: HTMLButtonElement;
    supplyButton: HTMLButtonElement;
    settingsButton: HTMLButtonElement;
    editorToolbar: HTMLElement;
    weatherPanel: HTMLElement;
    editorPanel: HTMLElement;
    editorPanelTitle: HTMLElement;
    editorTrip: HTMLElement;
    editorLegs: HTMLElement;
    editorPanelClose: HTMLButtonElement;
    editorNew: HTMLButtonElement;
    editorSave: HTMLButtonElement;
    editorSaveStatus: HTMLElement;
    saveGroup: HTMLElement;
    supplyPanel: HTMLElement;
    tripsDialog: HTMLDialogElement;
    settingsDialog: HTMLDialogElement;
  };

  constructor() {
    this.doc = document;
    const lang = resolveLang(window.location.search, readStoredLang(this.storage));
    this.i18n = createI18n(lang);
    this.pace = loadPace(this.storage);

    this.elements = {
      mapContainer: byId('map'),
      profilePanel: byId('profile'),
      profileBody: byId('profile-body'),
      profileToggle: byId('profile-toggle'),
      profileStatus: byId('profile-status'),
      profileReadout: byId('profile-readout'),
      profileOverlay: byId('profile-overlay'),
      profileOverlayTitle: byId('profile-overlay-title'),
      profileOverlayDetail: byId('profile-overlay-detail'),
      profileProgress: byId('profile-progress'),
      profileRetry: byId('profile-retry'),
      profileChart: byId('profile-chart'),
      profileCanvas: byId<HTMLCanvasElement>('profile-canvas'),
      stats: byId('stats'),
      emptyState: byId('empty-state'),
      mapFatal: byId('map-fatal'),
      mapFatalMessage: byId('map-fatal-message'),
      dropzone: byId('dropzone'),
      routeMeta: byId('route-meta'),
      routeName: byId('route-name'),
      routeTag: byId('route-tag'),
      attribBasemap: byId<HTMLAnchorElement>('attrib-basemap'),
      downloadGpxButton: byId<HTMLButtonElement>('btn-download-gpx'),
      fileInput: byId<HTMLInputElement>('file-input'),
      terrainButton: byId<HTMLButtonElement>('btn-terrain'),
      terrainHint: byId('terrain-hint'),
      langButtons: [...this.doc.querySelectorAll<HTMLButtonElement>('[data-lang]')],
      basemapButtons: [...this.doc.querySelectorAll<HTMLButtonElement>('[data-basemap]')],
      aboutDialog: byId<HTMLDialogElement>('about-dialog'),
      paceDialog: byId<HTMLDialogElement>('pace-dialog'),
      paceForm: byId<HTMLFormElement>('pace-form'),
      paceSpeed: byId<HTMLInputElement>('pace-speed'),
      paceAscent: byId<HTMLInputElement>('pace-ascent'),
      paceError: byId('pace-error'),
      paceHint: byId('pace-hint'),
      toast: byId('toast'),
      saveButton: byId<HTMLButtonElement>('btn-save'),
      saveStatus: byId('save-status'),
      tripsButton: byId<HTMLButtonElement>('btn-trips'),
      weatherButton: byId<HTMLButtonElement>('btn-weather'),
      supplyButton: byId<HTMLButtonElement>('btn-supply'),
      settingsButton: byId<HTMLButtonElement>('btn-settings'),
      editorToolbar: byId('editor-toolbar'),
      weatherPanel: byId('weather-panel'),
      editorPanel: byId('editor-panel'),
      editorPanelTitle: byId('editor-panel-title'),
      editorTrip: byId('editor-trip'),
      editorLegs: byId('editor-legs'),
      editorPanelClose: byId<HTMLButtonElement>('editor-panel-close'),
      editorNew: byId<HTMLButtonElement>('editor-new'),
      editorSave: byId<HTMLButtonElement>('editor-save'),
      editorSaveStatus: byId('editor-save-status'),
      saveGroup: this.doc.querySelector<HTMLElement>('.save-group') as HTMLElement,
      supplyPanel: byId('supply-panel'),
      tripsDialog: byId<HTMLDialogElement>('trips-dialog'),
      settingsDialog: byId<HTMLDialogElement>('settings-dialog'),
    };
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    this.applyLanguageChrome();
    this.i18n.apply(this.doc);

    this.banners = new BannerHost(byId('banners'), this.i18n.t('action.close'));
    this.chart = new ProfileChart(
      this.elements.profileChart,
      this.elements.profileCanvas,
      this.i18n,
      { onCursor: (distance, source) => this.handleChartCursor(distance, source) },
    );
    this.stats = new StatsBar(this.elements.stats, this.i18n, {
      onSetOwnNumbers: () => this.openSettings(),
    });

    await this.initPhase3();

    this.wireControls();
    this.wireDialogs();
    this.wireDropzone();
    this.wireProfileCollapse();
    this.wireHashChanges();

    this.createMap();
    this.renderProfilePanel();
    this.renderStats();
    this.renderReadout(null);
    this.updateRouteMeta();

    if (this.map === null) return;
    await this.map.whenReady();
    this.initOverlay();
    // The style already shows the topo layer. Do not force it here: a basemap
    // fallback can fire while the first tiles load, and re-selecting topo would
    // silently undo it.
    await this.loadInitialRoute();
  }

  private createMap(): void {
    try {
      this.map = new MapController(
        this.elements.mapContainer,
        {
          onBasemapState: (state) => {
            this.state.basemap = state;
            this.updateBasemapButtons();
            this.refreshBanners();
          },
          onTerrainState: (state) => {
            this.state.terrain = state;
            this.syncTerrainButton();
            this.refreshBanners();
          },
          onCamera: (info) => this.handleCamera(info),
          onFatal: (message) => this.handleFatal(message),
        },
        { reducedMotion: prefersReducedMotion() },
      );
      if (import.meta.env.DEV) {
        // Exposed for the visual smoke test in development only.
        (window as unknown as { __map?: MapController }).__map = this.map;
      }
    } catch (error) {
      this.handleFatal(messageOf(error));
    }
  }

  private handleFatal(message: string): void {
    this.state.fatal = message;
    this.elements.mapFatal.hidden = false;
    this.elements.mapFatalMessage.textContent = this.i18n.t('banner.mapFailed', { message });
    this.showEmptyState(false);
    this.refreshBanners();
  }

  /**
   * One visible sentence when the browser gave us less than IndexedDB: the
   * localStorage fallback caps a trip at 1.5 MB, which the user must know
   * before they try to save a long route.
   */
  private async announceStorageBackend(): Promise<void> {
    const session = this.session;
    if (!session) return;
    await session.whenReady();
    const info = session.storageInfo;
    if (!info || info.backend === 'indexeddb') return;
    this.banners.show({
      id: 'storage-fallback',
      kind: 'warning',
      message: this.i18n.t('storage.fallback'),
      detail: info.problem ?? undefined,
      retext: () => ({
        message: this.i18n.t('storage.fallback'),
        detail: info.problem ?? null,
      }),
    });
  }

  // -------------------------------------------------------------------------
  // Phase 3 — engines, trips, weather, editing
  // -------------------------------------------------------------------------

  /**
   * Load the engine bundle and build the Phase 3 UI.
   *
   * A missing engine is a visible state, never a blank panel: the shell keeps
   * the map and the profile, disables the trip actions, and says why.
   */
  private async initPhase3(): Promise<void> {
    const result = await loadEngines();
    this.engines = result.engines;
    this.engineError = result.error;

    this.toolbar = new EditorToolbar(this.elements.editorToolbar, this.i18n, {
      onMode: (mode) => this.switchMode(mode),
      onSnapToggle: (enabled) => this.toggleSnapping(enabled),
      onRadius: (radius) => this.changeRadius(radius),
      onUndo: () => this.undoEdit(),
      onRedo: () => this.redoEdit(),
      onAction: (action) => this.runEditorAction(action),
      onRename: (name) => this.renameLeg(name),
    }, this.elements.editorPanel);
    this.toolbar.setVisible(true);

    this.weatherPanel = new WeatherPanel(this.elements.weatherPanel, this.i18n, {
      onRefresh: () => void this.refreshWeather(),
      onFromChange: (from) => {
        this.weatherFrom = from;
        void this.refreshWeather();
      },
      onSettings: () => this.openSettings(),
      onOpenRoute: () => this.openFilePicker(),
      onClose: () => this.hideWeatherPanel(),
      onEscape: () => this.elements.weatherButton.focus(),
    });

    this.supplyService = new SupplyService({
      fetchImpl: window.fetch.bind(window),
      // `SHOP_INDEX_PATH` is app-absolute ('/data/shops.osm.bin'); resolve it
      // against the page's base so a deployment under a sub-path still finds
      // the bundled file instead of a 404 at the domain root.
      loadIndex: (fetchImpl) => loadShopIndex(baseAwareFetch(fetchImpl)),
    });
    // Warm the 175 KB index now, not when the map first settles.
    this.prefetchShopIndex();
    this.supplyPanel = new SupplyPanel(this.elements.supplyPanel, this.i18n, {
      onClose: () => this.hideSupplyPanel(),
      onRefresh: () => void this.refreshSupply(true),
      onSettings: () => this.openSettings(),
      onOpenRoute: () => this.openFilePicker(),
      onSelectPoint: (row) => this.selectSupplyRow(row.id),
      onRadius: (radiusM) => {
        this.supplyRadius = radiusM;
        void this.refreshSupply(true);
      },
      onAssumptions: (assumptions) => {
        this.energyEdited = true;
        this.energyAssumptions = assumptions;
        this.renderEnergy();
      },
      onEscape: () => this.elements.supplyButton.focus(),
    });
    this.supplyPanel.setRadius(this.supplyRadius);

    this.trips = new TripLibraryDialog(this.elements.tripsDialog, this.i18n, {
      onOpen: (id) => void this.openSavedTrip(id),
      onRename: (id, name) => void this.renameSavedTrip(id, name),
      onDuplicate: (id) => void this.duplicateSavedTrip(id),
      onDelete: (id) => void this.deleteSavedTrip(id),
      onExportGpx: (id) => void this.exportSavedTrip(id, 'gpx'),
      onExportGeoJson: (id) => void this.exportSavedTrip(id, 'geojson'),
      onImport: (file) => void this.importTripFile(file),
      onSettings: () => this.openSettings(),
      onNewTrip: () => this.startNewTrip(),
    });

    this.settings = new TripSettingsDialog(this.elements.settingsDialog, this.i18n, {
      onSave: (profile) => this.saveProfile(profile),
    });

    this.elements.saveButton.addEventListener('click', () => void this.saveTrip());
    this.elements.tripsButton.addEventListener('click', () => this.openTripLibrary());
    this.elements.weatherButton.addEventListener('click', () => {
      if (this.weatherPanel?.isOpen) this.hideWeatherPanel();
      else this.showWeatherPanel();
    });
    this.elements.supplyButton.addEventListener('click', () => {
      if (this.supplyPanel?.isOpen) this.hideSupplyPanel();
      else this.showSupplyPanel();
    });
    this.elements.settingsButton.addEventListener('click', () => this.openSettings());

    if (!this.engines) {
      this.banners.show({
        id: 'engines-missing',
        kind: 'warning',
        message: this.i18n.t('banner.enginesMissing'),
        detail: result.error ?? undefined,
        action: { label: this.i18n.t('action.retry'), onClick: () => window.location.reload() },
        retext: () => ({
          message: this.i18n.t('banner.enginesMissing'),
          detail: result.error ?? null,
          actionLabel: this.i18n.t('action.retry'),
        }),
      });
      for (const button of [
        this.elements.tripsButton,
        this.elements.weatherButton,
        this.elements.supplyButton,
        this.elements.settingsButton,
        this.elements.saveButton,
      ]) {
        button.disabled = true;
      }
      this.elements.saveStatus.textContent = this.i18n.t('save.unavailable');
      this.elements.saveStatus.dataset.kind = 'unavailable';
      this.weatherState = { kind: 'engine-missing', message: result.error ?? '' };
      this.renderEditor();
      this.renderWeather();
      return;
    }

    try {
      this.session = new TripSession({
        engines: this.engines,
        storage: this.storage,
        onChange: () => this.handleSessionChange(),
      });
      // Choosing the backend is asynchronous (IndexedDB). If the browser makes
      // us fall back, say so once, rather than only inside the trips dialog.
      void this.announceStorageBackend();
    } catch (error) {
      this.engines = null;
      const reason = messageOf(error);
      this.engineError = reason;
      this.banners.show({
        id: 'engines-missing',
        kind: 'error',
        message: this.i18n.t('banner.enginesMissing'),
        detail: reason,
        retext: () => ({ message: this.i18n.t('banner.enginesMissing'), detail: reason }),
      });
    }

    this.snapService = new SnapService({
      onChange: () => {
        this.renderEditor();
        this.renderTrails();
        this.reportTrailState();
        this.scheduleOffTrail();
      },
    });

    try {
      const engines = this.engines;
      this.horizonDays = engines ? engines.forecastHorizonDays() : DOCUMENTED_HORIZON_DAYS;
    } catch {
      this.horizonDays = DOCUMENTED_HORIZON_DAYS;
    }

    this.renderEditor();
    this.renderSaveStatus();
    this.renderWeather();
  }

  private initOverlay(): void {
    if (!this.map) return;
    this.overlay = new EditOverlay(
      {
        map: this.map.map,
        getTrip: () => this.session?.trip ?? null,
        isSnapping: () => this.editorUi.snapping,
        snap: (point) => this.snapAt(point),
        onDrawPoint: (point, snap) => this.drawPoint(point, snap),
        onSelect: (legId, index, extend) => this.selectVertexAt(legId, index, extend),
        onMoveVertex: (legId, index, point, snap) => this.moveVertex(legId, index, point, snap),
        onInsertPoint: (legId, index, point) => this.insertVertex(legId, index, point),
        onSnapIndicator: (snap, hovering) => this.setSnapIndicator(snap, hovering),
        onRoutePoint: (point) => this.handleRoutePoint(point),
        getDrawAnchor: () => this.drawAnchor(),
        onFinishDraw: () => this.finishDraw(),
      },
      // initOverlay runs after `whenReady()`: `load` has already fired.
      { mapReady: true },
    );
    this.overlay.setEnabled(this.engines !== null);
    this.overlay.setMode(this.editorUi.mode);
    this.overlay.setTrip(this.session?.trip ?? null);
  }

  // --- session -------------------------------------------------------------

  private handleSessionChange(): void {
    const trip = this.session?.trip ?? null;
    // Keep the route object identity when the name is unchanged: `showRouteOnMap`
    // uses identity to drop a stale render, and a needless spread would make the
    // first route draw (and its fit) look stale.
    if (trip && this.state.route && this.state.route.name !== trip.name) {
      this.state.route = { ...this.state.route, name: trip.name };
    }
    this.renderSaveStatus();
    this.updateRouteMeta();
    this.invalidateSupply();
    if (this.trips?.isOpen) this.renderTrips();
  }

  private async saveTrip(): Promise<void> {
    const session = this.session;
    if (!session?.trip) return;
    // `saveNow` resolves when the write has committed (or failed): the toast
    // follows the truth, not the intent.
    const status = await session.saveNow();
    if (status.kind === 'saved') {
      this.showToast(saveStatusText(status, this.i18n));
    }
    this.renderSaveStatus();
  }

  private renderSaveStatus(): void {
    const session = this.session;
    const status: SaveStatus = !this.engines
      ? { kind: 'unavailable', message: this.engineError ?? undefined }
      : (session?.saveStatus ?? { kind: 'idle' });
    const element = this.elements.saveStatus;
    element.textContent = saveStatusText(status, this.i18n);
    element.dataset.kind = status.kind;
    const detail = saveStatusDetail(status);
    if (detail) element.title = detail;
    else element.removeAttribute('title');
    this.elements.saveButton.disabled = !session?.trip;
    // A write in flight is not "saved" and the button says so without blocking
    // a second save: the session queues them.
    this.elements.saveButton.setAttribute('aria-busy', String(isPendingSave(status)));

    // The dock carries the same action while editing, because saving belongs next
    // to the work; the top bar keeps it for every other mode, and never both.
    const text = saveStatusText(status, this.i18n);
    const dockStatus = this.elements.editorSaveStatus;
    dockStatus.textContent = text;
    dockStatus.dataset.kind = status.kind;
    dockStatus.hidden = text.length === 0;
    if (detail) dockStatus.title = detail;
    else dockStatus.removeAttribute('title');
    this.elements.editorSave.disabled = !session?.trip;
    this.elements.editorSave.setAttribute('aria-busy', String(isPendingSave(status)));
    // Save is the same control in every mode. Hiding it while editing and showing
    // the drawer's copy moved the primary action under the pointer as soon as you
    // switched from Vis to Tegn — one action, one place.
    this.elements.saveGroup.hidden = false;

    if (status.kind === 'error') {
      const signature = `${status.code ?? ''}:${status.message ?? ''}`;
      if (this.lastSaveBanner !== signature) {
        this.lastSaveBanner = signature;
        this.banners.show({
          id: 'trip-save',
          kind: 'error',
          message: this.i18n.t('banner.tripSaveFailed', {
            message: saveStatusText(status, this.i18n),
          }),
          detail: detail ?? undefined,
        });
      }
    } else {
      // Always dismiss: the banner is a state, and this is the only place that
      // knows the state changed. A no-op when nothing is on screen.
      this.lastSaveBanner = null;
      this.banners.dismiss('trip-save');
    }
  }

  // --- trips ---------------------------------------------------------------

  /**
   * Reset the editor for a trip, keeping the current mode when it is the *same*
   * trip. A save round-trip or a re-adopt must not throw a user out of Draw or
   * Edit: the mode is theirs until they change it or open another trip.
   */
  private editorStateFor(trip: Trip | null): EditorUiState {
    return { ...initialEditorState(trip, this.editorUi.snapping), mode: this.editorMode };
  }

  private adoptTrip(trip: Trip, options: { save?: 'now' | 'deferred' | 'manual' } = {}): void {
    this.session?.adopt(trip, { save: options.save ?? 'deferred' });
    this.editorUi = this.editorStateFor(trip);
    this.overlay?.setTrip(trip);
    this.overlay?.setMode(this.editorUi.mode);
    this.overlay?.setSelection(null);
    this.renderEditor();
    this.renderSaveStatus();
    this.scheduleOffTrail();
  }

  private adoptTripFromTrack(track: GpxTrack, origin: RouteOrigin): void {
    const engines = this.engines;
    const session = this.session;
    if (!engines || !session) return;
    const points: RoutePoint[] = track.points.map((point) =>
      point.ele !== undefined && Number.isFinite(point.ele)
        ? { lon: point.lon, lat: point.lat, ele: point.ele, eleSource: 'gpx' as const }
        : { lon: point.lon, lat: point.lat },
    );
    const name = track.name?.trim() || this.i18n.t('route.unnamed');
    const profile = session.trip?.profile ?? engines.defaultProfile();
    let trip: Trip;
    try {
      trip = engines.tripFromPoints(points, name, profile);
    } catch (error) {
      const reason = messageOf(error);
      const text = (): string =>
        this.i18n.t('banner.tripBuildFailed', { message: briefError(reason) });
      this.banners.show({
        id: 'trip-build',
        kind: 'error',
        message: text(),
        detail: reason,
        retext: () => ({ message: text(), detail: reason }),
      });
      return;
    }
    this.banners.dismiss('trip-build');
    // A demo or shared link is something the user is looking at, not something
    // they chose to keep: do not write it until they edit or press Save.
    this.adoptTrip(trip, { save: origin === 'file' ? 'deferred' : 'manual' });
  }

  private openTripLibrary(): void {
    if (!this.engines) {
      const reason = this.engineError;
      this.banners.show({
        id: 'trips-unavailable',
        kind: 'warning',
        message: this.i18n.t('trips.engineMissing'),
        detail: reason ?? undefined,
        retext: () => ({ message: this.i18n.t('trips.engineMissing'), detail: reason }),
      });
      return;
    }
    this.renderTrips();
    this.trips?.open();
  }

  /**
   * Fill the library from the store. Asynchronous (listing reads the summaries
   * store), so a token drops a render whose data was superseded meanwhile.
   */
  private renderTrips(): void {
    const dialog = this.trips;
    if (!dialog) return;
    const session = this.session;
    if (!session) {
      dialog.render(
        buildTripLibraryView(
          {
            summaries: [],
            currentId: null,
            problem: { kind: 'unavailable' },
            importEnabled: false,
            storage: null,
          },
          this.i18n,
        ),
      );
      return;
    }

    const token = ++this.tripRenderToken;
    void (async () => {
      await session.whenReady();
      const [summaries, usage] = await Promise.all([session.list(), session.usage()]);
      if (token !== this.tripRenderToken) return;
      const info = session.storageInfo;
      const migration = session.migration;
      dialog.render(
        buildTripLibraryView(
          {
            summaries,
            currentId: session.trip?.id ?? null,
            problem: session.listProblem,
            importEnabled: this.engines !== null,
            storage: info
              ? {
                  backend: info.backend,
                  persistent: info.persistent,
                  usedBytes: usage?.usedBytes ?? null,
                  quotaBytes: usage?.quotaBytes ?? null,
                  problem: info.problem,
                  migrated: migration?.imported ?? 0,
                  migrationError: migration?.error ?? null,
                }
              : null,
          },
          this.i18n,
        ),
      );
    })();
  }

  private async openSavedTrip(id: string): Promise<void> {
    const session = this.session;
    if (!session) return;
    const trip = await session.open(id);
    if (!trip) {
      this.renderTrips();
      this.showToast(this.i18n.t('store.notFound'), 'warning');
      return;
    }
    this.trips?.close();
    this.editorUi = this.editorStateFor(trip);
    this.overlay?.setTrip(trip);
    this.overlay?.setMode(this.editorUi.mode);
    this.overlay?.setSelection(null);
    this.applyTripGeometry();
    this.renderEditor();
    this.renderSaveStatus();
    this.updateRouteMeta();
    this.scheduleOffTrail();
    this.resetWeatherForTrip();
    this.showToast(this.i18n.t('route.loaded', { name: trip.name }));
  }

  private async renameSavedTrip(id: string, name: string): Promise<void> {
    const session = this.session;
    if (!session) return;
    const ok = await session.renameSaved(id, name);
    if (ok) this.showToast(this.i18n.t('route.loaded', { name: name.trim() }));
    this.renderTrips();
    this.handleSessionChange();
  }

  private async duplicateSavedTrip(id: string): Promise<void> {
    const session = this.session;
    if (!session) return;
    const newId = await session.duplicate(id, this.i18n.t('trips.duplicateSuffix'));
    this.renderTrips();
    if (!newId) {
      this.showToast(this.i18n.t('store.quota'), 'warning');
      return;
    }
    const copy = await session.open(newId);
    if (copy) {
      this.editorUi = initialEditorState(copy, this.editorUi.snapping);
      this.overlay?.setTrip(copy);
      this.overlay?.setMode(this.editorUi.mode);
      this.overlay?.setSelection(null);
      this.applyTripGeometry();
      this.renderEditor();
      this.renderSaveStatus();
      this.updateRouteMeta();
      this.resetWeatherForTrip();
    }
  }

  private async deleteSavedTrip(id: string): Promise<void> {
    const session = this.session;
    if (!session) return;
    const wasCurrent = session.trip?.id === id;
    if (!(await session.remove(id))) {
      this.showToast(this.i18n.t('store.quota'), 'warning');
    }
    this.renderTrips();
    if (wasCurrent) this.clearActiveRoute();
  }

  /**
   * Remove the displayed route after its trip was deleted from the library.
   * Keeping it on screen with no trip and no save status would be a lie about
   * what is currently open.
   */
  private clearActiveRoute(): void {
    this.job?.cancel();
    this.job = null;
    this.session?.close();
    this.editorUi = initialEditorState(null, this.editorUi.snapping);
    this.overlay?.setTrip(null);
    this.overlay?.setOffTrail([]);
    this.offTrailLabels = [];
    this.offTrailComputed = false;
    this.state.route = null;
    this.state.profile = null;
    this.state.profileStatus = 'empty';
    this.state.cursorDistance = null;
    this.state.profileError = null;
    this.state.profileErrorMessage = '';
    this.chart.setProfile(null);
    this.map?.setRoute(null, { fit: false });
    this.map?.setCursor(null);
    this.showEmptyState(true);
    this.renderProfilePanel();
    this.renderStats();
    this.renderReadout(null);
    this.updateRouteMeta();
    this.renderEditor();
    this.renderSaveStatus();
    // There is no trip any more: no forecast can belong to it.
    this.resetWeatherForTrip();
  }

  /**
   * Download the open route as GPX, saved or not. The library's export works
   * from storage by id; this one works from the trip in memory, so the button
   * does not have to be preceded by Save.
   */
  private downloadCurrentGpx(): void {
    const session = this.session;
    if (!session) return;
    const text = session.exportGpx();
    if (text === null) {
      this.showToast(this.i18n.t('store.unsupported'), 'warning');
      return;
    }
    const name = this.state.route?.name ?? this.i18n.t('route.unnamed');
    this.downloadText(this.safeFileName(name, '.gpx'), text, 'application/gpx+xml');
  }

  private async exportSavedTrip(id: string, format: 'gpx' | 'geojson'): Promise<void> {
    const session = this.session;
    if (!session) return;
    const [summaries, text] = await Promise.all([
      session.list(),
      format === 'gpx' ? session.exportGpxFor(id) : session.exportGeoJsonFor(id),
    ]);
    const summary = summaries.find((candidate) => candidate.id === id);
    if (text === null) {
      this.showToast(this.i18n.t('store.unsupported'), 'warning');
      return;
    }
    const name = this.safeFileName(
      summary?.name ?? 'tur',
      format === 'gpx' ? '.gpx' : '.geojson',
    );
    this.downloadText(
      name,
      text,
      format === 'gpx' ? 'application/gpx+xml' : 'application/geo+json',
    );
  }

  private async importTripFile(file: File): Promise<void> {
    const session = this.session;
    if (!session) {
      await this.loadFile(file);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      this.showFileTooLarge(file.size);
      return;
    }
    let text = '';
    try {
      // Reading the file can fail (the file was moved, the stream was cut):
      // that rejection must land in the same visible banner as a parse error,
      // not escape as an unhandled promise the user never sees.
      text = await file.text();
      const trip = await session.importFile(text, file.name);
      this.banners.dismiss('import-failed');
      this.editorUi = this.editorStateFor(trip);
      this.overlay?.setTrip(trip);
      this.overlay?.setMode(this.editorUi.mode);
      this.overlay?.setSelection(null);
      this.applyTripGeometry();
      this.renderEditor();
      this.renderSaveStatus();
      this.renderTrips();
      this.resetWeatherForTrip();
      this.showToast(this.i18n.t('trips.imported', { name: trip.name }));
    } catch (error) {
      this.showImportFailed(error);
      // The map and profile do not depend on the store: show the route anyway.
      if (error instanceof StoreError && text.length > 0) {
        await this.loadGpxText(text, 'file', file.name);
      }
    }
  }

  /** The two import banners, in one place so a language change can re-word them. */
  private showFileTooLarge(bytes: number): void {
    const text = (): string =>
      this.i18n.t('banner.fileTooLarge', {
        size: this.i18n.format.number(bytes / (1024 * 1024), { maximumFractionDigits: 1 }),
        max: this.i18n.format.number(MAX_FILE_BYTES / (1024 * 1024), { maximumFractionDigits: 0 }),
      });
    this.banners.show({
      id: 'file-too-large',
      kind: 'error',
      message: text(),
      retext: () => ({ message: text() }),
    });
  }

  private showImportFailed(error: unknown): void {
    const text = (): string =>
      this.i18n.t('banner.importFailed', { message: storeErrorText(error, this.i18n) });
    this.banners.show({
      id: 'import-failed',
      kind: 'error',
      message: text(),
      detail: storeErrorDetail(error) ?? undefined,
      retext: () => ({ message: text(), detail: storeErrorDetail(error) }),
    });
  }

  /**
   * Start an empty trip and switch to draw mode. The engine's `emptyTrip`
   * carries one placeholder leg (the two-point invariant), which the first
   * drawn point replaces — see `drawPointCommand`.
   */
  private startNewTrip(): void {
    const engines = this.engines;
    const session = this.session;
    if (!engines || !session) return;
    let trip: Trip;
    try {
      trip = engines.emptyTrip(
        this.i18n.t('trips.newTripName'),
        session.trip?.profile ?? engines.defaultProfile(),
      );
    } catch (error) {
      this.showToast(this.i18n.t('banner.tripBuildFailed', { message: messageOf(error) }), 'warning');
      return;
    }
    this.job?.cancel();
    this.job = null;
    session.adopt(trip, { save: 'manual' });
    this.editorUi = setMode(this.editorStateFor(trip), 'draw', trip);
    this.overlay?.setTrip(trip);
    this.overlay?.setMode('draw');
    this.overlay?.setSelection(null);
    this.state.route = null;
    this.state.profile = null;
    this.state.profileStatus = 'empty';
    this.state.cursorDistance = null;
    this.chart.setProfile(null);
    this.map?.setRoute(null, { fit: false });
    this.map?.setCursor(null);
    this.showEmptyState(false);
    this.renderProfilePanel();
    this.renderStats();
    this.renderReadout(null);
    this.updateRouteMeta();
    this.trips?.close();
    this.switchMode('draw');
    this.offTrailComputed = false;
    this.offTrailLabels = [];
    this.renderTrips();
    this.renderSaveStatus();
    this.resetWeatherForTrip();
  }

  private safeFileName(name: string, extension: string): string {
    const base = name
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '_')
      .slice(0, 80);
    return `${base.length > 0 ? base : 'tur'}${extension}`;
  }

  private downloadText(filename: string, text: string, mime: string): void {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = this.doc.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    this.doc.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // --- settings ------------------------------------------------------------

  private openSettings(focus?: 'startDate' | 'dailyKm'): void {
    if (!this.engines) {
      const reason = this.engineError;
      this.banners.show({
        id: 'settings-unavailable',
        kind: 'warning',
        message: this.i18n.t('settings.engineMissing'),
        detail: reason ?? undefined,
        retext: () => ({ message: this.i18n.t('settings.engineMissing'), detail: reason }),
      });
      return;
    }
    this.settings?.open(this.session?.trip?.profile ?? null, { available: true });
    if (focus) this.settings?.focusField(focus);
  }

  private saveProfile(profile: UserProfile): void {
    const session = this.session;
    if (!session?.trip) {
      this.settings?.close();
      this.showToast(this.i18n.t('settings.missingTrip'), 'warning');
      return;
    }
    session.rewrite({ ...session.trip, profile });
    this.settings?.close();
    this.afterTripChange(false);
    // Write it now: the toast must not claim "saved" for a pending autosave.
    void this.saveTrip();
    if (this.weatherPanel?.isOpen) void this.refreshWeather();
    if (this.supplyPanel?.isOpen) void this.refreshSupply(true);
  }

  // --- weather -------------------------------------------------------------

  private showWeatherPanel(): void {
    // One floating panel at a time: they share the same corner, and at 390 px
    // they share the whole screen.
    if (this.supplyPanel?.isOpen) this.hideSupplyPanel();
    this.weatherPanel?.show();
    this.elements.weatherButton.setAttribute('aria-expanded', 'true');
    void this.refreshWeather();
  }

  private hideWeatherPanel(): void {
    this.weatherPanel?.hide();
    this.elements.weatherButton.setAttribute('aria-expanded', 'false');
  }

  private renderWeather(): void {
    const profile = this.session?.trip?.profile ?? null;
    // "Now" plans from today, so the view must be told today is the day it is
    // looking at — otherwise it reports a missing start date over a full table.
    const effective =
      profile && this.weatherFromEffective === 'now'
        ? { ...profile, startDate: todayInOslo() }
        : profile;
    this.weatherPanel?.render(
      this.weatherState,
      effective,
      this.horizonDays,
      this.weatherFromEffective,
      Boolean(profile?.startDate),
    );
  }

  /**
   * A different trip (or no trip) is now open: the forecast on screen was about
   * another route. Never leave it there with the trip name changed.
   */
  private resetWeatherForTrip(): void {
    // Invalidate an in-flight fetch as well, or it lands on the new trip.
    this.weatherToken += 1;
    this.weatherState = { kind: 'no-trip' };
    this.weatherFrom = 'trip';
    this.weatherFromEffective = 'trip';
    this.renderWeather();
    if (this.weatherPanel?.isOpen) void this.refreshWeather();
  }

  private async refreshWeather(): Promise<void> {
    const token = ++this.weatherToken;
    if (!this.engines) {
      this.weatherState = { kind: 'engine-missing', message: this.engineError ?? '' };
      this.renderWeather();
      return;
    }
    const trip = this.session?.trip;
    if (!trip) {
      this.weatherState = { kind: 'no-trip' };
      this.renderWeather();
      return;
    }
    // A trip without a start date has no timeline to draw, so "now" stops being
    // a preference and becomes the only honest mode — never a dead end that tells
    // the user to go and set a trip date before the weather will appear.
    const from: 'trip' | 'now' = trip.profile.startDate ? this.weatherFrom : 'now';
    this.weatherFromEffective = from;
    const startDate = from === 'now' ? todayInOslo() : trip.profile.startDate;
    if (!startDate) {
      this.weatherState = { kind: 'needs-start-date' };
      this.renderWeather();
      return;
    }
    if (!(trip.profile.dailyKm > 0)) {
      this.weatherState = { kind: 'needs-daily-km' };
      this.renderWeather();
      return;
    }
    // A quick look does not rewrite the trip: it plans the same route from today.
    const planned =
      from === 'now' && trip.profile.startDate !== startDate
        ? { ...trip, profile: { ...trip.profile, startDate } }
        : trip;

    this.weatherState = { kind: 'loading' };
    this.renderWeather();
    try {
      const plan = await this.engines.planTripWeather(planned, {
        fetch: window.fetch.bind(window),
        cache: this.weatherCache,
        now: () => new Date(),
        maxPoints: 40,
        concurrency: 2,
      });
      if (token !== this.weatherToken) return;
      this.weatherState = { kind: 'ready', plan, ...(from === 'now' ? { from } : {}) };
    } catch (error) {
      if (token !== this.weatherToken) return;
      const failure = weatherFailure(error, this.i18n);
      this.weatherState = {
        kind: 'error',
        message: failure.message,
        ...(failure.detail ? { detail: failure.detail } : {}),
      };
    }
    this.renderWeather();
  }

  private scheduleWeatherRefresh(): void {
    if (this.weatherTimer !== null) window.clearTimeout(this.weatherTimer);
    this.weatherTimer = window.setTimeout(() => {
      this.weatherTimer = null;
      void this.refreshWeather();
    }, 900);
  }

  // --- resupply + energy ---------------------------------------------------

  private showSupplyPanel(tab: SupplyTab = 'resupply'): void {
    if (this.weatherPanel?.isOpen) this.hideWeatherPanel();
    this.supplyPanel?.open(tab);
    this.elements.supplyButton.setAttribute('aria-expanded', 'true');
    this.syncEnergyAssumptions();
    void this.refreshSupply(true);
  }

  private hideSupplyPanel(): void {
    this.supplyPanel?.hide();
    this.elements.supplyButton.setAttribute('aria-expanded', 'false');
  }

  /**
   * Keep the pack mass following the trip's own base pack mass until the user
   * edits the assumptions — then their number wins, because it is theirs.
   */
  private syncEnergyAssumptions(): void {
    const profile = this.session?.trip?.profile;
    if (!profile || this.energyEdited) return;
    const packMassKg = Math.max(0, profile.packBaseKg);
    if (packMassKg !== this.energyAssumptions.packMassKg) {
      this.energyAssumptions = { ...this.energyAssumptions, packMassKg };
    }
  }

  /**
   * Correlate the route with the bundled shops and the live huts, then plan.
   *
   * The index is fetched on first open (lazy) and cached by the service; a hut
   * failure is a partial result, an index failure is a visible dead end.
   */
  private async refreshSupply(force = false): Promise<void> {
    const panel = this.supplyPanel;
    if (!panel) return;
    const token = ++this.supplyToken;
    const trip = this.session?.trip ?? null;
    const route = this.state.route;

    if (!trip) {
      this.supplyState = { kind: 'no-trip' };
      this.renderSupply();
      return;
    }
    if (!route) {
      this.supplyState = { kind: 'no-route' };
      this.renderSupply();
      return;
    }
    const profile = trip.profile;
    if (!(profile.massKg > 0) || !(profile.heightCm > 0) || !(profile.ageYears > 0)) {
      this.supplyState = { kind: 'no-profile' };
      this.renderSupply();
      return;
    }
    if (!force && this.supplyState.kind === 'ready') {
      // A ready plan for the same trip and route is reused; a refresh is asked
      // for explicitly.
      this.renderSupply();
      return;
    }

    this.supplyState = { kind: 'loading' };
    this.renderSupply();
    const service = this.supplyService;
    if (!service) {
      this.supplyState = { kind: 'index-failed', message: 'the supply service is unavailable' };
      this.renderSupply();
      return;
    }
    try {
      const result = await service.corridor(route.points, this.supplyRadius);
      if (token !== this.supplyToken) return;
      try {
        const plan = planResupplyForTrip(trip, result.candidates);
        this.supplyState = {
          kind: 'ready',
          data: { ...result, candidates: result.candidates, plan, radiusM: this.supplyRadius },
        };
      } catch (error) {
        this.supplyState = { kind: 'plan-failed', message: messageOf(error) };
      }
    } catch (error) {
      if (token !== this.supplyToken) return;
      this.supplyState = { kind: 'index-failed', message: messageOf(error) };
    }
    if (token !== this.supplyToken) return;
    this.renderSupply();
  }

  /** Render both tabs from the current state and put the points on the map. */
  private renderSupply(): void {
    const panel = this.supplyPanel;
    if (!panel) return;
    this.syncEnergyAssumptions();
    const view = buildResupplyView(this.supplyState, this.i18n);
    this.supplyRows = view.rows;
    panel.setAssumptions(this.energyAssumptions);
    panel.renderResupply(view);
    this.renderSupplyMap();
    this.renderEnergy();
  }

  private renderSupplyMap(): void {
    const map = this.map;
    if (!map) return;
    const corridor = this.supplyRows.map((row) => ({
      id: row.id,
      kind: row.kind,
      position: row.point,
      usable: row.countsAsFood,
    }));
    const onRoute = new Set(corridor.map((point) => point.id));
    // Everything else in view: the map shows the country, not just this route.
    const aroundHere = this.places
      .map((candidate) => ({
        id: candidateKey(candidate),
        kind: candidate.kind,
        position: candidate.point,
        usable: countsAsFoodPlace(candidate),
      }))
      .filter((point) => !onRoute.has(point.id));
    map.setResupplyPoints([...corridor, ...aroundHere]);
    map.setResupplyHandlers({
      onSelect: (id) => {
        if (onRoute.has(id)) this.selectSupplyRow(id);
      },
      cardFor: (id) => {
        const row = this.supplyRows.find((candidate) => candidate.id === id);
        if (row) return buildResupplyCard(this.doc, row, this.i18n);
        const place = this.places.find((candidate) => candidateKey(candidate) === id);
        return place ? buildPlaceCard(this.doc, placeCardModel(place, this.i18n)) : null;
      },
    });
  }

  /**
   * Ask the service what is around the current view, once the map settles.
   *
   * The delay is only there to collapse a drag's worth of camera frames into one
   * query; the query itself is a local scan, so it is kept short. It used to be
   * 450 ms, which was most of the wait a user felt between zooming out and seeing
   * the badges arrive.
   */
  private schedulePlaces(): void {
    if (this.placesTimer !== null) window.clearTimeout(this.placesTimer);
    this.placesTimer = window.setTimeout(() => {
      this.placesTimer = null;
      void this.refreshPlaces();
    }, 200);
  }

  /**
   * Warm the bundled index with the first paint.
   *
   * The map needs the shops whether or not the panel is open (D20), and the
   * layer used to wait for a camera settle *and* the debounce before asking for
   * the file — so on a phone the first badges arrived seconds after the map. The
   * service de-duplicates the request, so the panel's own query joins this one.
   */
  private prefetchShopIndex(): void {
    const service = this.supplyService;
    if (!service) return;
    // A data-saver connection is not made to pay 175 KB for map decoration.
    const connection = (navigator as { connection?: { saveData?: boolean } }).connection;
    if (connection?.saveData === true) return;
    // Not fatal here: the panel's query retries and reports the failure.
    void service.shopIndex().catch(() => {});
  }

  private async refreshPlaces(): Promise<void> {
    const map = this.map;
    const service = this.supplyService;
    if (!map || !service) return;
    // A metered or data-saver connection does not need 175 KB of POIs to plan a
    // walk; the supply panel still has them when it is opened explicitly.
    const connection = (navigator as { connection?: { saveData?: boolean } }).connection;
    if (connection?.saveData === true) return;
    const token = ++this.placesToken;
    const view = map.getViewBounds();
    try {
      const result = await service.placesIn(view);
      if (token !== this.placesToken) return;
      // Keep what is already drawn: a pan must add and drop glyphs at its edges,
      // not replace the layer. Anything still inside the covered box stays, so a
      // shop in front of the user does not vanish and come back as a "new" one.
      this.places = mergePlacesForView(this.places, result.places, placesDrawBounds(view));
      this.renderSupplyMap();
      this.banners.dismiss('places-failed');
    } catch (error) {
      if (token !== this.placesToken) return;
      // Orientation only: keep the markers already on the map, but say why the
      // layer is not updating instead of leaving a silent gap.
      const text = (): string =>
        this.i18n.t('banner.placesFailed', { message: briefError(messageOf(error)) });
      this.banners.show({
        id: 'places-failed',
        kind: 'warning',
        message: text(),
        retext: () => ({ message: text() }),
      });
    }
  }

  /**
   * A resupply point was activated — on the map or in the list. The profile
   * cursor moves to its along-route distance, so the two views answer together.
   */
  private selectSupplyRow(id: string): void {
    const row = this.supplyRows.find((candidate) => candidate.id === id);
    if (!row) return;
    this.map?.setResupplySelection(row.id);
    const route = this.state.route;
    if (!route) return;
    this.state.cursorDistance = row.alongRouteM;
    this.state.cursorSource = 'map';
    this.chart.setExternalCursor(row.alongRouteM);
    this.renderReadout(row.alongRouteM);
    this.scheduleMarker(pointAtDistance(route, row.alongRouteM));
    if (!this.map) return;
    this.map.focusOn(row.point);
  }

  private energyState(): EnergyPanelState {
    const trip = this.session?.trip ?? null;
    if (!trip) return { kind: 'no-trip' };
    const profile = trip.profile;
    if (!(profile.massKg > 0) || !(profile.heightCm > 0) || !(profile.ageYears > 0)) {
      return { kind: 'no-profile' };
    }
    const route = this.state.route;
    if (!route) return { kind: 'no-route' };
    const routeProfile = this.state.profile;
    if (this.state.profileStatus !== 'ready' || routeProfile === null) {
      const reason =
        this.state.profileError === 'scope'
          ? 'scope'
          : this.state.profileError === 'dem'
            ? 'dem'
            : this.state.profileStatus === 'loading'
              ? 'loading'
              : 'none';
      return { kind: 'elevation-missing', reason };
    }
    const model = computeEnergyModel({
      profile,
      // The profile's own length is the one the cursor and the chart use.
      routeDistanceM: routeProfile.distanceM,
      ascentM: routeProfile.ascentM,
      descentM: routeProfile.descentM,
      assumptions: this.energyAssumptions,
    });
    if (!model) {
      return { kind: 'invalid', message: this.i18n.t('energy.noProfile') };
    }
    return { kind: 'ready', model };
  }

  /**
   * The badge for numbers computed from the built-in default body (B3).
   *
   * `defaultProfile()` satisfies every guard in the energy model, so a first
   * visitor would otherwise be told "you can eat enough" for a body they never
   * entered. The panel stays usable; it is labelled, and the label carries the
   * button that opens the settings dialog.
   */
  private profileNotice(): string | null {
    const engines = this.engines;
    if (!engines) return null;
    return placeholderProfileNotice(
      this.session?.trip?.profile ?? null,
      engines.defaultProfile(),
      this.i18n,
    );
  }

  private renderEnergy(): void {
    const profile = this.session?.trip?.profile ?? null;
    const defaults = this.engines?.defaultProfile() ?? null;
    // The bar and the tab carry the same caveat, worded once (B3).
    this.stats.setProfileNotice(placeholderProfileNotice(profile, defaults, this.i18n));
    this.supplyPanel?.renderEnergy(
      buildEnergyView(this.energyState(), this.i18n, { profile, defaults }),
    );
  }

  /** Everything a resupply plan depends on, in one comparable string. */
  private supplySignature(): string {
    const trip = this.session?.trip ?? null;
    return [
      trip?.updatedAt ?? '',
      trip ? JSON.stringify(trip.profile) : '',
      this.supplyRadius,
      this.state.route?.distanceM ?? -1,
      this.state.profileStatus,
      this.state.profile?.ascentM ?? -1,
    ].join('|');
  }

  /**
   * The route, the profile or the trip changed. The energy panel is cheap and
   * is always re-rendered; the corridor query is repeated when something it
   * depends on actually changed.
   *
   * It runs whether or not the panel is open, because the points are drawn on
   * the map: a shop or a hut the user never sees because the panel is closed is
   * not a resupply point they can plan around. A closed panel asks with
   * `force = false`, so the service's own cache answers a repeat route.
   */
  private invalidateSupply(): void {
    const signature = this.supplySignature();
    if (signature === this.supplySig) {
      this.renderEnergy();
      return;
    }
    this.supplySig = signature;
    // The signature changed, so a cached "ready" plan describes a different
    // route. Ask with force: the service still answers repeats from its cache.
    void this.refreshSupply(true);
  }

  // --- editor --------------------------------------------------------------

  /**
   * Delete what is selected. A single vertex goes through the undoable command;
   * a span is left to the inspector's explicit "Trim to span" / "Delete span",
   * because a silent multi-vertex delete is one keystroke away from a disaster.
   */
  private deleteSelection(): void {
    const selection = this.editorUi.selection;
    if (!selection) return;
    if (selection.to !== null && selection.to !== selection.from) return;
    this.runEditorAction('delete-vertex');
  }

  private switchMode(mode: InteractionMode): void {
    this.editorMode = mode;
    if (!this.engines || !this.session?.trip) return;
    this.cancelRoute();
    this.editorUi = setMode(this.editorUi, mode, this.session.trip);
    this.overlay?.setMode(mode);
    this.overlay?.setTrip(this.session.trip);
    this.snapTrackerLine = null;
    if (mode !== 'view') this.ensureSnapNetwork();
    this.renderTrails();
    this.renderEditor();
  }

  private toggleSnapping(enabled: boolean): void {
    this.editorUi = setSnapping(this.editorUi, enabled);
    this.snapTrackerLine = null;
    if (enabled) this.ensureSnapNetwork();
    this.renderTrails();
    this.scheduleOffTrail();
    this.renderEditor();
  }

  private changeRadius(radius: number): void {
    this.editorUi = setRadius(this.editorUi, radius);
    this.snapTrackerLine = null;
    this.scheduleOffTrail();
    this.renderEditor();
  }

  private ensureSnapNetwork(): void {
    const service = this.snapService;
    if (!service || !this.map) return;
    if (service.status === 'loading') return;
    const connection = (navigator as { connection?: { saveData?: boolean } }).connection;
    if (
      !shouldPrefetchSnap({
        zoom: this.map.map.getZoom(),
        saveData: connection?.saveData === true,
      })
    ) {
      return;
    }
    const bounds = this.map.map.getBounds();
    void service.loadViewport({
      minLon: bounds.getWest(),
      minLat: bounds.getSouth(),
      maxLon: bounds.getEast(),
      maxLat: bounds.getNorth(),
    });
  }

  /**
   * Draw the trail network exactly where it is what a click will snap to.
   *
   * The lines come from the index the snapper queries, so the picture cannot
   * promise a path the pointer will not take. Outside draw/edit, or with snapping
   * off, they are hidden: a trail the app will not use is decoration.
   */
  private renderTrails(): void {
    const map = this.map;
    const service = this.snapService;
    if (!map || !service) return;
    map.setTrailLines(trailLinesToGeoJson(service.index.lines));
    const actionable = this.editorUi.mode !== 'view' && this.editorUi.snapping && service.lineCount > 0;
    map.setTrailsVisible(actionable);
  }

  /**
   * Say it when the trail network is unavailable, and offer the retry.
   *
   * "Laster stier…" that never resolves is the worst of both worlds: the user is
   * told to wait for something that is not coming, and drawing silently stops
   * snapping. D7 asks for visible degradation — so a failure becomes a banner that
   * names the reason, says what still works, and can be retried. A successful load
   * takes it away.
   */
  private reportTrailState(): void {
    const service = this.snapService;
    if (!service) return;
    const text = (): string =>
      this.i18n.t(
        service.failureKind === 'timeout' ? 'banner.trailsTimeout' : 'banner.trailsFailed',
      );
    if (service.status === 'failed') {
      this.banners.show({
        id: 'trails-failed',
        kind: 'warning',
        message: text(),
        detail: service.errorMessage ?? undefined,
        action: {
          label: this.i18n.t('banner.trailsRetry'),
          onClick: () => {
            this.banners.dismiss('trails-failed');
            this.ensureSnapNetwork();
          },
        },
        retext: () => ({ message: text(), actionLabel: this.i18n.t('banner.trailsRetry') }),
      });
      return;
    }
    this.banners.dismiss('trails-failed');
  }

  private snapAt(point: LonLat): SnapResult | null {
    const service = this.snapService;
    if (!service || !this.editorUi.snapping) return null;
    const result = service.snap(point, this.editorUi.radiusM, this.snapTrackerLine);
    this.snapTrackerLine = result?.lineId ?? null;
    return result;
  }

  private setSnapIndicator(snap: SnapResult | null, hovering = false): void {
    this.snapIndicatorSnap = snap;
    this.snapHovering = hovering;
    if (this.editorFrame !== 0) return;
    this.editorFrame = requestAnimationFrame(() => {
      this.editorFrame = 0;
      this.renderEditor();
    });
  }

  private selectVertexAt(legId: string, index: number, extend: boolean): void {
    this.editorUi = selectVertex(this.editorUi, legId, index, extend);
    this.overlay?.setSelection(this.editorUi.selection);
    this.renderEditor();
  }

  private drawPoint(point: LonLat, snap: SnapResult | null = null): void {
    const session = this.session;
    const engines = this.engines;
    let trip = session?.trip;
    if (!session || !trip || !engines) return;

    // A brand-new trip has no legs (emptyTrip is genuinely empty). The first
    // drawn point creates the placeholder leg that `emptyLeg` is for; this is
    // the one whole-trip replacement in the drawing flow, and it has no history
    // to lose.
    if (findLeg(trip, this.editorUi.activeLegId) === undefined) {
      const leg = engines.emptyLeg();
      const withLeg: Trip = { ...trip, legs: [...trip.legs, leg] };
      session.rewrite(withLeg);
      this.editorUi = {
        ...this.editorUi,
        activeLegId: leg.id,
        selection: null,
        drawPoints: [],
        drawReplacesLeg: true,
      };
      this.overlay?.setTrip(withLeg);
      trip = withLeg;
    }

    const leg = findLeg(trip, this.editorUi.activeLegId);
    const anchor = this.drawAnchor();

    // Draw *along* the trail when both ends snapped and the network connects them:
    // otherwise a click is a vertex and the leg is a chord, which is what used to
    // happen always. The decision and the command are pure (`drawStepCommand`), so
    // they are tested without a map or a network; this method only supplies the
    // path and applies the result.
    // Ask the snapper about the anchor *now*, rather than remembering that the
    // last click snapped: an undo, a vertex move or a reload can leave a remembered
    // flag pointing at a vertex that is no longer on a trail, and a path would then
    // start from the trail instead of from where the leg actually is.
    const anchorSnapped = anchor && this.snapService ? this.snapService.snap(anchor, this.editorUi.radiusM, null) : null;
    const wantsPath = Boolean(leg && snap && anchorSnapped && anchor && leg.points.length >= 2);
    const path = wantsPath && anchor ? this.pathBetween(anchor, point) : null;
    const routePoint = { lon: point.lon, lat: point.lat };
    const command = drawStepCommand({
      state: this.editorUi,
      trip,
      point: routePoint,
      snapped: snap !== null,
      anchor: wantsPath ? anchor : null,
      path,
    });
    if (!command) return;
    if (session.apply(command)) {
      const appended = command.type === 'replace-span';
      const committed = appended ? command.points[command.points.length - 1] : routePoint;
      if (committed) this.editorUi = noteDrawnPoint(this.editorUi, committed);
      this.afterTripChange();
    }
  }

  /**
   * The trail path between two points, from the lines already indexed.
   *
   * Built from `SnapIndex.lines`, so it cannot route on anything the map is not
   * showing, and it is the same 5 m node-merge rule as D16 — trails that do not
   * share a node are not joined, and `null` means "no path", never a straight line.
   * The graph is memoised on the index's shape: rebuilding it per click would cost
   * more than the click.
   */
  private pathBetween(from: LonLat, to: LonLat): readonly { lon: number; lat: number }[] | null {
    const service = this.snapService;
    if (!service) return null;
    const key = `${service.index.lineCount}:${service.index.segmentCount}`;
    if (this.trailGraph?.key !== key) {
      const lines = service.index.lines
        .filter((line) => line.coords.length >= 2)
        .map((line) => ({ id: line.id, points: line.coords }));
      this.trailGraph = { key, graph: buildTrailGraph(lines, { mergeToleranceM: 5 }) };
    }
    const result = routeBetweenPoints(this.trailGraph.graph, from, to, {
      maxSnapDistanceM: this.editorUi.radiusM,
    });
    return result.kind === 'ok' ? result.points : null;
  }

  /**
   * Where a new click would extend the route from — the active leg's last vertex.
   *
   * `null` for a brand-new trip (the placeholder leg is two points at 0°/0°, which
   * is not a place) so the draft preview does not draw a line from the Gulf of
   * Guinea.
   */
  private drawAnchor(): LonLat | null {
    const trip = this.session?.trip;
    if (!trip) return null;
    const leg = findLeg(trip, this.editorUi.activeLegId);
    if (!leg || leg.points.length === 0) return null;
    const last = leg.points[leg.points.length - 1];
    if (!Number.isFinite(last.lat) || !Number.isFinite(last.lon)) return null;
    // Not `isPlaceholderLeg`: after the first click the leg is the padded pair
    // [p, p], which that helper calls placeholder (because it is all one
    // coordinate) — but p is exactly the point the next click extends from. The
    // only geometry with no anchor is `emptyLeg()` itself: exactly two points at
    // the 0°/0° sentinel. Checked by length, because this runs on every pointer
    // move and an imported trip can carry 100 000 vertices.
    const sentinelLeg =
      leg.points.length === 2 && last.lon === 0 && last.lat === 0 && leg.points[0].lon === 0;
    if (sentinelLeg) return null;
    return { lon: last.lon, lat: last.lat };
  }

  /**
   * Double-click in draw mode: the leg is finished.
   *
   * A double-click is two clicks, so the second one has usually just committed a
   * vertex on top of the first. That duplicate is dropped before leaving, because
   * a zero-length segment at the end of every drawn leg is noise the user did not
   * ask for — and it is one undo, not a silent edit.
   */
  private finishDraw(): void {
    const trip = this.session?.trip;
    const leg = trip ? findLeg(trip, this.editorUi.activeLegId) : undefined;
    if (leg && leg.points.length >= 2) {
      const last = leg.points[leg.points.length - 1];
      const previous = leg.points[leg.points.length - 2];
      const sentinel = last.lon === 0 && last.lat === 0;
      if (!sentinel && haversine(previous, last) < FINISH_DUPLICATE_M && this.session?.undo()) {
        this.afterTripChange();
      }
    }
    this.switchMode('view');
  }

  private moveVertex(legId: string, index: number, point: LonLat, snap: SnapResult | null = null): void {
    const session = this.session;
    if (!session?.trip) return;
    const command = moveVertexCommand(
      legId,
      index,
      { lon: point.lon, lat: point.lat },
      snap !== null,
    );
    if (session.apply(command)) this.afterTripChange();
  }

  private insertVertex(legId: string, index: number, point: LonLat): void {
    const session = this.session;
    if (!session?.trip) return;
    if (session.apply(insertVertexCommand(legId, index, { lon: point.lon, lat: point.lat }))) {
      this.afterTripChange();
    }
  }

  private undoEdit(): void {
    if (this.session?.undo()) {
      this.editorUi = clearSelection(this.editorUi);
      this.afterTripChange();
    }
  }

  private redoEdit(): void {
    if (this.session?.redo()) {
      this.editorUi = clearSelection(this.editorUi);
      this.afterTripChange();
    }
  }

  private runEditorAction(action: EditorAction): void {
    const session = this.session;
    const trip = session?.trip;
    if (!session || !trip) return;
    let command = null;
    switch (action) {
      case 'delete-vertex':
        command = deleteVertexCommand(this.editorUi);
        break;
      case 'split':
        command = splitCommand(this.editorUi);
        break;
      case 'reverse':
        command = reverseCommand(this.editorUi, trip);
        break;
      case 'trim':
        command = trimCommand(this.editorUi);
        break;
      case 'delete-leg':
        command = deleteLegCommand(this.editorUi, trip);
        break;
      case 'reroute':
        this.rerouteSelection();
        return;
      case 'route':
        this.toggleRoute();
        return;
      case 'rename':
        return;
    }
    if (command && session.apply(command)) {
      this.editorUi = clearSelection(this.editorUi);
      this.overlay?.setSelection(null);
      this.afterTripChange();
    }
  }

  private renameLeg(name: string): void {
    const session = this.session;
    const trip = session?.trip;
    if (!session || !trip) return;
    const command = renameCommand(this.editorUi, trip, name);
    if (command && session.apply(command)) this.afterTripChange();
  }

  /**
   * Reroute re-snaps the selected span and applies the result as a normal
   * `replace-span` command, so it lands on the undo stack like every other edit.
   * If the engine returns unchanged geometry (no trail within the radius) we do
   * not pretend an edit happened: the span is left alone and the off-trail
   * computation marks it.
   */
  private rerouteSelection(): void {
    const session = this.session;
    const engines = this.engines;
    const selection = this.editorUi.selection;
    const trip = session?.trip;
    const service = this.snapService;
    if (!session || !engines || !trip || !selection || selection.to === null) return;
    if (!service || service.lineCount === 0) {
      this.showToast(this.i18n.t('editor.rerouteNeedsSnap'), 'warning');
      return;
    }
    const from = Math.min(selection.from, selection.to);
    const to = Math.max(selection.from, selection.to);
    const leg = findLeg(trip, selection.legId);
    if (!leg) return;
    let rerouted: Trip;
    try {
      rerouted = engines.rerouteSpan(trip, selection.legId, from, to, {
        radiusM: this.editorUi.radiusM,
        snapIndex: service.index,
      });
    } catch (error) {
      const reason = messageOf(error);
      const text = (): string =>
        this.i18n.t('banner.tripSaveFailed', { message: briefError(reason) });
      this.banners.show({
        id: 'reroute-failed',
        kind: 'error',
        message: text(),
        detail: reason,
        retext: () => ({ message: text(), detail: reason }),
      });
      return;
    }
    const reroutedLeg = findLeg(rerouted, selection.legId);
    if (!reroutedLeg) return;
    const span = reroutedLeg.points.slice(from, to + 1);
    const original = leg.points.slice(from, to + 1);
    const changed =
      span.length !== original.length ||
      span.some(
        (point, index) =>
          point.lon !== original[index].lon || point.lat !== original[index].lat,
      );
    if (!changed) {
      this.showToast(this.i18n.t('editor.rerouteNoTrail'), 'warning');
      this.recomputeOffTrail();
      return;
    }
    const applied = session.apply({
      type: 'replace-span',
      legId: selection.legId,
      from,
      to,
      points: span,
      snapped: true,
    });
    if (applied) this.afterTripChange();
  }

  // --- trail routing -------------------------------------------------------

  /** Turrutebasen routing replaces the active leg with a routed polyline. */
  private toggleRoute(): void {
    if (this.routePick) {
      this.cancelRoute();
      return;
    }
    const session = this.session;
    const trip = session?.trip;
    if (!session || !trip) return;
    if (!findLeg(trip, this.editorUi.activeLegId) && trip.legs.length === 0) {
      this.showToast(this.i18n.t('route.needsLeg'), 'warning');
      return;
    }
    // With a span selected, "route along the trail" needs no picks: the span's own
    // endpoints are the question, and the answer replaces only that span. Without
    // one, the two-click pick starts, and the result replaces the active leg.
    const span = this.selectedSpan();
    if (span) {
      void this.runRoute(span.from, span.to);
      return;
    }
    this.routePick = { start: null, busy: false };
    this.overlay?.setRouteMode(true);
    this.showToast(this.i18n.t('route.pickStart'));
  }

  /**
   * The endpoints of the selected span, when there is one to route inside.
   *
   * `null` means "the whole active leg", which is the behaviour every existing
   * caller and the e2e journey rely on.
   */
  private selectedSpan(): { from: LonLat; to: LonLat; fromIndex: number; toIndex: number } | null {
    const trip = this.session?.trip;
    const selection = this.editorUi.selection;
    if (!trip || !selection || selection.to === null) return null;
    const leg = findLeg(trip, selection.legId);
    if (!leg) return null;
    const fromIndex = Math.min(selection.from, selection.to);
    const toIndex = Math.max(selection.from, selection.to);
    const first = leg.points[fromIndex];
    const last = leg.points[toIndex];
    if (!first || !last) return null;
    return {
      from: { lon: first.lon, lat: first.lat },
      to: { lon: last.lon, lat: last.lat },
      fromIndex,
      toIndex,
    };
  }

  private cancelRoute(): void {
    if (!this.routePick) return;
    this.routePick = null;
    this.overlay?.setRouteMode(false);
  }

  private handleRoutePoint(point: LonLat): void {
    const pick = this.routePick;
    if (!pick || pick.busy) return;
    if (!pick.start) {
      pick.start = point;
      this.overlay?.setRoutePick(point, null);
      this.showToast(this.i18n.t('route.pickEnd'));
      return;
    }
    void this.runRoute(pick.start, point);
  }

  private async runRoute(start: LonLat, end: LonLat): Promise<void> {
    const pick = this.routePick;
    if (!pick || pick.busy) return;
    pick.busy = true;
    this.overlay?.setRoutePick(start, end);
    this.showToast(this.i18n.t('route.loading'));

    const network = await loadTrailNetwork(start, end);
    // Escape or a mode switch may have cancelled while the fetch was in flight;
    // a late result must not overwrite the map.
    if (this.routePick !== pick) return;
    if (network.kind === 'failed') {
      this.failRoute(network.code, network.detail);
      return;
    }
    let routed: RouteBetweenResult;
    try {
      routed = routeBetweenLines(network.lines, start, end, { maxSnapDistanceM: 250 });
    } catch (error) {
      if (this.routePick === pick) this.failRoute('network-unavailable', messageOf(error));
      return;
    }
    if (this.routePick !== pick) return;
    if (routed.kind === 'failed') {
      this.failRoute(routed.code, null);
      return;
    }
    this.commitRoute(routed);
  }

  private failRoute(
    code: RoutingFailureCode | TrailNetworkFailureCode,
    detail: string | null,
  ): void {
    const radius = this.i18n.format.distance(250);
    let message: string;
    switch (code) {
      case 'no-trail-near-start':
        message = this.i18n.t('route.noTrailStart', { radius });
        break;
      case 'no-trail-near-end':
        message = this.i18n.t('route.noTrailEnd', { radius });
        break;
      case 'no-path':
        message = this.i18n.t('route.noPath');
        break;
      case 'area-too-large':
        message = this.i18n.t('route.areaTooLarge');
        break;
      case 'too-many-features':
        message = this.i18n.t('route.tooManyFeatures');
        break;
      default:
        message = this.i18n.t('route.networkUnavailable', { detail: detail ?? '—' });
    }
    this.cancelRoute();
    this.showToast(message, 'warning');
  }

  private commitRoute(result: Extract<RouteBetweenResult, { kind: 'ok' }>): void {
    const session = this.session;
    const trip = session?.trip;
    if (!session || !trip) return;
    const selection = this.editorUi.selection;
    const selectedLeg = selection ? findLeg(trip, selection.legId) : undefined;
    const spanless = selection === null || selection?.to === null;
    const leg = spanless ? findLeg(trip, this.editorUi.activeLegId) ?? trip.legs[0] : selectedLeg;
    if (!leg) {
      this.failRoute('network-unavailable', null);
      return;
    }
    // Span-scoped when a span is selected: routing inside a leg must not rewrite
    // the parts of it the user did not select.
    const from = selection && selection.to !== null ? Math.min(selection.from, selection.to) : 0;
    const to =
      selection && selection.to !== null
        ? Math.max(selection.from, selection.to)
        : leg.points.length - 1;
    const applied = session.apply({
      type: 'replace-span',
      legId: leg.id,
      from,
      to,
      points: result.points,
      snapped: true,
      provenance: [
        {
          kind: 'turrutebasen',
          label: 'Turrutebasen',
          url: 'https://wfs.geonorge.no/skwms1/wfs.turogfriluftsruter',
          fetchedAt: new Date().toISOString(),
          licence: 'CC BY 4.0 ©Kartverket',
          modified: true,
        },
      ],
    });
    this.cancelRoute();
    if (applied) {
      this.afterTripChange();
      this.showToast(this.i18n.t('route.done', { distance: this.i18n.format.distance(result.distanceM) }));
    } else {
      this.showToast(this.i18n.t('route.failed'), 'warning');
    }
  }

  private afterTripChange(refreshGeometry = true): void {
    const session = this.session;
    const trip = session?.trip ?? null;
    if (!trip) {
      this.renderEditor();
      this.renderSaveStatus();
      return;
    }
    if (this.state.route && this.state.route.name !== trip.name) {
      this.state.route = { ...this.state.route, name: trip.name };
    }
    this.overlay?.setTrip(trip);
    this.overlay?.setSelection(this.editorUi.selection);
    this.renderEditor();
    this.renderSaveStatus();
    this.updateRouteMeta();
    this.scheduleOffTrail();
    if (refreshGeometry) this.scheduleGeometryRefresh();
    if (this.weatherPanel?.isOpen) this.scheduleWeatherRefresh();
  }

  private scheduleGeometryRefresh(): void {
    if (this.geometryTimer !== null) window.clearTimeout(this.geometryTimer);
    this.geometryTimer = window.setTimeout(() => {
      this.geometryTimer = null;
      this.applyTripGeometry();
    }, 350);
  }

  /** Rebuild the displayed route from the trip and re-sample the DEM. */
  private applyTripGeometry(): void {
    const trip = this.session?.trip;
    if (!trip) return;
    const flat = flattenTrip(trip);
    if (flat.points.length < 2 || !(flat.distanceM > 0)) return;
    let route: Route;
    try {
      route = buildRoute({
        name: trip.name,
        coords: flat.points.map((point) => ({ lon: point.lon, lat: point.lat })),
        // Editing a demo keeps its origin: the trip still came from the demo,
        // it is not suddenly an imported file.
        origin: this.state.route?.origin ?? 'file',
      });
    } catch {
      // A zero-length or degenerate edit: leave the current view alone.
      return;
    }
    this.job?.cancel();
    this.job = null;
    this.banners.dismiss('gpx-error');
    this.state.route = route;
    this.state.profile = null;
    this.state.profileStatus = 'loading';
    this.state.profileError = null;
    this.state.profileErrorMessage = '';
    this.state.progress = { done: 0, total: 0, phase: 'download' };
    this.state.cursorDistance = null;
    this.state.cursorSource = 'map';
    this.showEmptyState(false);
    this.updateRouteMeta();
    void this.showRouteOnMap(route);
    this.chart.setProfile(null);
    this.renderProfilePanel();
    this.renderStats();
    this.renderReadout(null);
    if (!checkSupported(route.points).ok) {
      this.setProfileError('scope');
      return;
    }
    this.sampleRoute(route);
  }

  private scheduleOffTrail(): void {
    if (this.offTrailTimer !== null) window.clearTimeout(this.offTrailTimer);
    this.offTrailTimer = window.setTimeout(() => {
      this.offTrailTimer = null;
      this.recomputeOffTrail();
    }, 450);
  }

  /**
   * Classify every segment as on- or off-trail by snapping its midpoint.
   * Consecutive off-trail segments are merged into one labelled stretch; the
   * dashed map line uses the individual segments.
   */
  private recomputeOffTrail(): void {
    const trip = this.session?.trip;
    const service = this.snapService;
    const segments: OffTrailSegment[] = [];
    const labels: string[] = [];
    this.offTrailComputed = Boolean(
      trip && service && service.isReady && service.lineCount > 0 && this.editorUi.snapping,
    );
    if (this.offTrailComputed && trip && service) {
      const flat = flattenTrip(trip);
      let runStart: number | null = null;
      let runEnd: number | null = null;
      for (let i = 0; i + 1 < flat.points.length; i++) {
        const a = flat.points[i];
        const b = flat.points[i + 1];
        const off =
          service.snap(
            { lon: (a.lon + b.lon) / 2, lat: (a.lat + b.lat) / 2 },
            this.editorUi.radiusM,
          ) === null;
        if (off) {
          if (runStart === null) runStart = i;
          runEnd = i + 1;
          segments.push({
            from: { lon: a.lon, lat: a.lat },
            to: { lon: b.lon, lat: b.lat },
          });
        } else if (runStart !== null && runEnd !== null) {
          labels.push(this.offTrailLabel(labels.length + 1, flat.distances[runStart], flat.distances[runEnd]));
          runStart = null;
          runEnd = null;
        }
      }
      if (runStart !== null && runEnd !== null) {
        labels.push(this.offTrailLabel(labels.length + 1, flat.distances[runStart], flat.distances[runEnd]));
      }
    }
    this.offTrailLabels = labels.slice(0, 3);
    this.overlay?.setOffTrail(segments);
    this.renderEditor();
  }

  private offTrailLabel(n: number, fromM: number, toM: number): string {
    return this.i18n.t('editor.offTrailSpan', {
      n: this.i18n.format.number(n, { maximumFractionDigits: 0 }),
      from: this.i18n.format.distance(fromM),
      to: this.i18n.format.distance(toM),
    });
  }

  /**
   * The editor dock: the trip, its legs, and (from R3) what can be done to the
   * selection. The leg list is the thing the old bar never had — the object the
   * verbs act on, visible and clickable.
   */
  private renderEditorPanel(trip: Trip | null): void {
    const panel = this.elements.editorPanel;
    // The card is the route's structure, so it is there whenever a route is:
    // in View it is a short, read-only list; Draw and Edit grow the sections that
    // only make sense while editing. The mode switch lives here, so it cannot be
    // hidden behind the very mode it selects.
    const open = trip !== null;
    panel.hidden = !open;
    if (!open || !trip) {
      this.map?.setLegHighlight(null);
      // Leaving the dock puts the trip-level Save back in the bar.
      this.renderSaveStatus();
      return;
    }
    this.elements.editorPanelTitle.textContent = this.i18n.t(
      this.editorUi.mode === 'draw'
        ? 'editor.panelTitleDraw'
        : this.editorUi.mode === 'edit'
          ? 'editor.panelTitle'
          : 'editor.panelTitleView',
    );

    const flat = flattenTrip(trip);
    this.elements.editorTrip.textContent =
      trip.legs.length === 0
        ? this.i18n.t('editor.noLegs')
        : this.i18n.t(
            trip.legs.length === 1 ? 'editor.tripSummaryOne' : 'editor.tripSummaryMany',
            {
            legs: this.i18n.format.number(trip.legs.length, { maximumFractionDigits: 0 }),
            distance: this.i18n.format.distance(flat.distanceM),
            points: this.i18n.format.number(flat.points.length, { maximumFractionDigits: 0 }),
          },
          );

    const rows = trip.legs.map((leg, index) => {
      const button = this.doc.createElement('button');
      button.type = 'button';
      button.className = 'leg-row';
      button.dataset.legId = leg.id;
      button.setAttribute('role', 'listitem');
      button.setAttribute('aria-current', String(leg.id === this.editorUi.activeLegId));

      const name = this.doc.createElement('span');
      name.className = 'leg-row-name';
      name.textContent =
        leg.name?.trim() || this.i18n.t('editor.legRowName', { n: String(index + 1) });

      const meta = this.doc.createElement('span');
      meta.className = 'leg-row-meta';
      meta.textContent = this.i18n.t('editor.legRowMeta', {
        distance: leg.distanceM === null ? '—' : this.i18n.format.distance(leg.distanceM),
        points: this.i18n.format.number(leg.points.length, { maximumFractionDigits: 0 }),
      });

      button.append(name, meta);
      button.addEventListener('click', () => this.selectLegInPanel(leg.id));
      return button;
    });
    this.elements.editorLegs.replaceChildren(...rows);
    this.renderSaveStatus();
  }

  /** A leg row: make it the active leg, frame it on the map, show it in the dock. */
  private selectLegInPanel(legId: string): void {
    const trip = this.session?.trip ?? null;
    const leg = findLeg(trip, legId);
    this.editorUi = selectLeg(this.editorUi, legId);
    this.overlay?.setSelection(null);
    this.overlay?.setMode(this.editorUi.mode);
    this.renderEditor();
    if (!leg || !this.map) return;
    const points = leg.points.map((point) => ({ lon: point.lon, lat: point.lat }));
    this.map.setLegHighlight(points);
    this.map.fitToPoints(points);
  }

  private renderEditor(): void {
    if (!this.toolbar) return;
    const trip = this.session?.trip ?? null;
    this.renderEditorPanel(trip);
    const available = this.engines !== null && trip !== null;
    const legId = this.editorUi.selection?.legId ?? this.editorUi.activeLegId;
    const leg = findLeg(trip, legId);
    const legIndex = leg && trip ? trip.legs.findIndex((candidate) => candidate.id === leg.id) : -1;
    const legLabel =
      leg?.name?.trim() ||
      (legIndex >= 0 ? this.i18n.t('editor.legFallback', { n: legIndex + 1 }) : '');
    const selection = this.editorUi.selection;
    let selectionLabel: string | null = null;
    if (leg && selection) {
      const from = Math.min(selection.from, selection.to ?? selection.from);
      const to = Math.max(selection.from, selection.to ?? selection.from);
      selectionLabel =
        selection.to !== null && to !== from
          ? this.i18n.t('editor.selectionSpan', {
              leg: legLabel,
              from: this.i18n.format.number(from + 1, { maximumFractionDigits: 0 }),
              to: this.i18n.format.number(to + 1, { maximumFractionDigits: 0 }),
            })
          : this.i18n.t('editor.selection', {
              leg: legLabel,
              from: this.i18n.format.number(selection.from + 1, { maximumFractionDigits: 0 }),
              total: this.i18n.format.number(leg.points.length, { maximumFractionDigits: 0 }),
            });
    }

    let snapIndicator = '';
    let snapState: 'off' | 'loading' | 'failed' | 'idle' | 'hit' | 'miss' | 'ready' = 'off';
    if (available) {
      if (!this.editorUi.snapping) {
        snapIndicator = this.i18n.t('editor.snapDisabled');
        snapState = 'off';
      } else if (this.snapService?.status === 'loading') {
        snapIndicator = this.i18n.t('editor.snapLoading');
        snapState = 'loading';
      } else if (this.snapService?.status === 'failed') {
        snapIndicator = this.i18n.t('editor.snapFailed');
        snapState = 'failed';
      } else if ((this.snapService?.lineCount ?? 0) === 0) {
        snapIndicator = this.i18n.t('editor.snapIdle');
        snapState = 'idle';
      } else if (this.snapIndicatorSnap) {
        snapIndicator = this.i18n.t('editor.snapOn', {
          route: snapRouteLabel(this.snapIndicatorSnap.attributes).label,
        });
        snapState = 'hit';
      } else if (this.snapHovering) {
        snapIndicator = this.i18n.t('editor.snapOff', {
          radius: this.i18n.format.number(this.editorUi.radiusM, { maximumFractionDigits: 0 }),
        });
        snapState = 'miss';
      } else {
        snapIndicator = this.i18n.t('editor.snapReady');
        snapState = 'ready';
      }
    }

    let offTrailLabel: string;
    if (!available) offTrailLabel = '';
    else if (!this.editorUi.snapping) offTrailLabel = this.i18n.t('editor.offTrailSnapOff');
    else if (!this.offTrailComputed) offTrailLabel = this.i18n.t('editor.offTrailUnknown');
    else if (this.offTrailLabels.length === 0) offTrailLabel = this.i18n.t('editor.offTrailNone');
    else {
      offTrailLabel = this.i18n.t('editor.offTrail', {
        count: this.i18n.format.number(this.offTrailLabels.length, {
          maximumFractionDigits: 0,
        }),
      });
    }

    const hint = !this.engines
      ? this.i18n.t('editor.engineMissing')
      : !trip
        ? this.i18n.t('editor.noTrip')
        : this.editorUi.mode === 'draw'
          ? this.i18n.t('editor.drawHint')
          : this.editorUi.mode === 'edit'
            ? this.i18n.t('editor.selectHint')
            : this.i18n.t('editor.viewHint');

    this.toolbar.render({
      available,
      mode: this.editorUi.mode,
      snapping: this.editorUi.snapping,
      radiusM: this.editorUi.radiusM,
      canUndo: this.session?.canUndo ?? false,
      canRedo: this.session?.canRedo ?? false,
      commands: availableCommands(this.editorUi, trip),
      selectionLabel,
      legName: leg?.name ?? '',
      snapIndicator,
      snapState,
      offTrailLabel,
      offTrailSpans: this.offTrailLabels,
      hint,
      vertexCount: trip ? flattenTrip(trip).points.length : 0,
      renameEnabled: leg !== undefined,
    });
  }

  // -------------------------------------------------------------------------
  // Route loading
  // -------------------------------------------------------------------------

  private async loadInitialRoute(): Promise<void> {
    const hash = window.location.hash;
    if (hasRouteHash(hash)) {
      const text = decodeRouteHash(hash);
      if (text !== null) {
        await this.loadGpxText(text, 'link', undefined, { updateHash: false });
        return;
      }
      this.banners.show({
        id: 'hash-invalid',
        kind: 'warning',
        message: this.i18n.t('banner.hashInvalid'),
        retext: () => ({ message: this.i18n.t('banner.hashInvalid') }),
      });
    }
    // No route in the link and nothing saved: the empty state is the honest
    // starting point. There is no bundled sample route (D26).
    if (this.state.route === null) this.showEmptyState(true);
  }

  private async loadGpxText(
    text: string,
    origin: RouteOrigin,
    fileName?: string,
    options: { updateHash?: boolean } = {},
  ): Promise<void> {
    let route: Route;
    let track: GpxTrack | null = null;
    try {
      const documentNode = parseGpx(text);
      track = pickTrack(documentNode);
      if (!track) {
        this.banners.show({
          id: 'gpx-error',
          kind: 'error',
          message: this.i18n.t('banner.noTrack'),
          retext: () => ({ message: this.i18n.t('banner.noTrack') }),
        });
        return;
      }
      if (track.points.length < 2) {
        this.banners.show({
          id: 'gpx-error',
          kind: 'error',
          message: this.i18n.t('banner.tooShort'),
          retext: () => ({ message: this.i18n.t('banner.tooShort') }),
        });
        return;
      }
      route = buildRoute({
        name: track.name,
        coords: track.points.map((point) => ({ lon: point.lon, lat: point.lat })),
        origin,
        fileName,
        gpxText: text,
      });
    } catch (error) {
      this.showGpxError(messageOf(error));
      return;
    }

    this.banners.dismiss('gpx-error');
    this.banners.dismiss('demo-failed');
    this.banners.dismiss('hash-invalid');
    this.banners.dismiss('dem-failed');
    this.banners.dismiss('hash-too-long');
    this.banners.dismiss('off-scope');

    this.job?.cancel();
    this.job = null;
    this.state.route = route;
    this.state.profile = null;
    this.state.profileStatus = 'loading';
    this.state.profileError = null;
    this.state.profileErrorMessage = '';
    this.state.progress = { done: 0, total: 0, phase: 'download' };
    this.state.cursorDistance = null;
    this.state.cursorSource = 'map';

    this.showEmptyState(false);
    this.updateRouteMeta();
    void this.showRouteOnMap(route);
    this.chart.setProfile(null);
    this.renderProfilePanel();
    this.renderStats();
    this.renderReadout(null);

    if (track) this.adoptTripFromTrack(track, origin);

    if (options.updateHash !== false && origin === 'file') {
      this.writeRouteHash(text);
    }

    const support = checkSupported(route.points);
    if (!support.ok) {
      this.setProfileError('scope');
      return;
    }
    this.sampleRoute(route);
  }

  private async showRouteOnMap(route: Route): Promise<void> {
    if (!this.map) return;
    await this.map.whenReady();
    if (this.state.route !== route) return;
    // Fit a route the user *arrived* at (an import, a saved trip, the demo), never
    // the one they are editing. Re-fitting on every committed edit meant the first
    // drawn point yanked the camera to a 2-point route — measured 11.56 -> 14.28 in
    // one click — so the next click landed somewhere else entirely and a 2 km leg
    // collapsed into 10 m.
    this.map.setRoute(route, { fit: this.editorUi.mode === 'view' });
  }

  private sampleRoute(route: Route): void {
    this.state.profileStatus = 'loading';
    this.state.progress = { done: 0, total: 0, phase: 'download' };
    this.renderProfilePanel();
    this.renderStats();
    // Route-level banners describe the previous route until this one answers.
    this.refreshBanners();

    const job = createElevationJob(route.points, {
      onProgress: (progress) => {
        if (this.job !== job) return;
        this.state.progress = progress;
        this.renderProfilePanel();
      },
    });
    this.job = job;

    job.promise
      .then(async (elevations) => {
        if (this.job !== job) return;
        this.job = null;
        // The download is over; the profile maths is next. Paint that once, so a
        // long route does not appear to hang on "downloading" after the last tile.
        this.state.progress = { done: this.state.progress.done, total: this.state.progress.total, phase: 'compute' };
        this.renderProfilePanel();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (this.job !== null) return;
        let profile: Profile;
        try {
          profile = buildProfile(route.points, Array.from(elevations));
        } catch (error) {
          this.setProfileError('dem', messageOf(error));
          return;
        }
        this.state.profile = profile;
        this.state.profileStatus = 'ready';
        this.state.profileError = null;
        this.chart.setProfile(profile);
        this.renderProfilePanel();
        this.renderStats();
        this.syncCursorToCamera();
        this.invalidateSupply();
        // A route-level fact just became known (a stretch at sea level, say).
        this.refreshBanners();
      })
      .catch((error: unknown) => {
        if (this.job !== job) return;
        this.job = null;
        this.setProfileError('dem', messageOf(error));
      });
  }

  private setProfileError(kind: ProfileErrorKind, message = ''): void {
    this.job?.cancel();
    this.job = null;
    this.state.profile = null;
    this.state.profileStatus = 'error';
    this.state.profileError = kind;
    this.state.profileErrorMessage = message;
    this.state.cursorDistance = null;
    this.chart.setProfile(null);
    this.map?.setCursor(null);
    this.renderProfilePanel();
    this.renderStats();
    this.renderReadout(null);
    this.refreshBanners();
    this.invalidateSupply();
  }

  private retryElevation(): void {
    const route = this.state.route;
    if (!route) return;
    if (!checkSupported(route.points).ok) {
      this.setProfileError('scope');
      return;
    }
    this.banners.dismiss('dem-failed');
    this.sampleRoute(route);
  }

  private writeRouteHash(text: string): void {
    const hash = encodeRouteHash(compactGpx(text));
    if (hash === null) {
      this.showHashTooLong();
      return;
    }
    const url = `${window.location.pathname}${window.location.search}${hash}`;
    window.history.replaceState(null, '', url);
    this.banners.dismiss('hash-too-long');
  }

  // -------------------------------------------------------------------------
  // Cursor + camera sync
  // -------------------------------------------------------------------------

  private handleChartCursor(distance: number | null, source: CursorSource): void {
    this.state.cursorDistance = distance;
    this.state.cursorSource = source;
    this.renderReadout(distance);

    if (source === 'map' || distance === null || this.state.route === null) {
      this.scheduleMarker(null);
      return;
    }
    this.scheduleMarker(pointAtDistance(this.state.route, distance));
  }

  private handleCamera(info: CameraInfo): void {
    // Editing needs trails for the viewport the user is looking at, not the one
    // they started in. Prefetch is debounced; the cache makes repeats free.
    if (this.editorUi.mode !== 'view' && this.editorUi.snapping) this.scheduleSnapPrefetch();
    // The shops and huts on screen follow the view, not the route.
    this.schedulePlaces();
    if (!this.state.route || this.state.profileStatus !== 'ready') return;
    const nearest = nearestRoutePoint(this.state.route, info.center, info.zoom);
    if (!nearest) return;
    this.chart.setExternalCursor(nearest.distanceM);
    // Do not fight the pointer or keyboard for the readout.
    if (this.state.cursorSource === 'map') {
      this.state.cursorDistance = nearest.distanceM;
      this.renderReadout(nearest.distanceM);
    }
  }

  private scheduleSnapPrefetch(): void {
    if (this.snapTimer !== null) window.clearTimeout(this.snapTimer);
    this.snapTimer = window.setTimeout(() => {
      this.snapTimer = null;
      this.ensureSnapNetwork();
    }, 600);
  }

  private syncCursorToCamera(): void {
    if (!this.map || !this.state.route || this.state.profileStatus !== 'ready') return;
    const camera = this.map.getCamera();
    const nearest = nearestRoutePoint(this.state.route, camera.center, camera.zoom);
    if (!nearest) return;
    this.state.cursorSource = 'map';
    this.state.cursorDistance = nearest.distanceM;
    this.chart.setExternalCursor(nearest.distanceM);
    this.renderReadout(nearest.distanceM);
  }

  private scheduleMarker(position: LonLat | null): void {
    this.pendingMarker = position;
    if (this.markerFrame !== 0) return;
    this.markerFrame = requestAnimationFrame(() => {
      this.markerFrame = 0;
      this.map?.setCursor(this.pendingMarker);
    });
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private renderStats(): void {
    const { route, profile, profileStatus, profileError } = this.state;
    this.stats.setProfileNotice(this.profileNotice());
    const ready = profileStatus === 'ready' && profile !== null;
    const range = ready ? minMaxElevation(profile) : null;
    const minutes = ready ? naismithMinutes(profile.distanceM, profile.ascentM, this.pace) : null;
    const disabledReason =
      profileStatus === 'error'
        ? this.i18n.t(profileError === 'scope' ? 'profile.outOfScope' : 'profile.unavailableDetail')
        : undefined;

    const paceHint = this.i18n.t('stats.timeHint', {
      speed: this.i18n.format.number(this.pace.speedKmh, { maximumFractionDigits: 1 }),
      ascent: this.i18n.format.number(this.pace.ascentMPerHour, { maximumFractionDigits: 0 }),
    });

    this.stats.render({
      values: {
        distanceM: route?.distanceM ?? null,
        ascentM: ready ? profile.ascentM : null,
        descentM: ready ? profile.descentM : null,
        minutes: ready ? minutes : null,
        minEle: range?.min ?? null,
        maxEle: range?.max ?? null,
      },
      source:
        route === null
          ? 'idle'
          : profileStatus === 'ready'
            ? 'ready'
            : profileStatus === 'loading'
              ? 'loading'
              : 'error',
      disabledReason,
      paceHint,
    });
  }

  private renderProfilePanel(): void {
    const { profileStatus, profile, profileError, progress } = this.state;
    const overlay = this.elements.profileOverlay;
    const title = this.elements.profileOverlayTitle;
    const detail = this.elements.profileOverlayDetail;
    const progressBar = this.elements.profileProgress;

    const setOverlay = (visible: boolean): void => {
      overlay.hidden = !visible;
    };

    this.elements.profileRetry.hidden = true;
    progressBar.hidden = true;

    if (profileStatus === 'empty') {
      // An empty trip in Draw mode is not "no route loaded": it is waiting for the
      // first click, and the overlay should say so.
      const drawing = this.editorUi.mode === 'draw';
      const message = drawing ? this.i18n.t('profile.drawStart') : this.i18n.t('profile.empty');
      this.elements.profileStatus.textContent = message;
      title.textContent = message;
      detail.textContent = drawing
        ? this.i18n.t('profile.drawStartHint')
        : this.i18n.t('profile.emptyHint');
      setOverlay(true);
      return;
    }

    if (profileStatus === 'loading') {
      const { done, total, phase } = progress;
      // Two different waits, and only one of them is on the network: say which.
      // "Downloading" names the source and counts the windows; "calculating" has
      // no progress to report, so it must not pretend to.
      if (phase === 'compute') {
        this.elements.profileStatus.textContent = this.i18n.t('profile.computing');
        title.textContent = this.i18n.t('profile.computing');
        detail.textContent = '';
        progressBar.hidden = true;
        setOverlay(true);
        return;
      }
      this.elements.profileStatus.textContent =
        total > 0
          ? this.i18n.t('profile.loading', {
              done: this.i18n.format.number(done, { maximumFractionDigits: 0 }),
              total: this.i18n.format.number(total, { maximumFractionDigits: 0 }),
            })
          : this.i18n.t('profile.loadingShort');
      title.textContent = this.i18n.t('profile.loadingShort');
      detail.textContent = '';
      progressBar.hidden = false;
      const span = progressBar.firstElementChild as HTMLElement | null;
      if (span) {
        span.classList.toggle('is-indeterminate', total === 0);
        span.style.width = total > 0 ? `${Math.round((done / total) * 100)}%` : '35%';
      }
      setOverlay(true);
      return;
    }

    if (profileStatus === 'error') {
      this.elements.profileStatus.textContent = this.i18n.t('profile.unavailable');
      title.textContent = this.i18n.t('profile.unavailable');
      detail.textContent = this.i18n.t(
        profileError === 'scope' ? 'profile.outOfScope' : 'profile.unavailableDetail',
      );
      this.elements.profileRetry.hidden = profileError !== 'dem';
      setOverlay(true);
      return;
    }

    // Ready. The source is named in the header badge; a clock time adds nothing
    // to a national terrain model, so only interpolation is worth saying.
    this.elements.profileStatus.textContent =
      profile && profile.filledSamples > 0
        ? this.i18n.t('profile.filled', {
            n: this.i18n.format.number(profile.filledSamples, { maximumFractionDigits: 0 }),
          })
        : '';
    setOverlay(false);
  }

  private renderReadout(distance: number | null): void {
    const el = this.elements.profileReadout;
    const profile = this.state.profile;
    if (!profile || this.state.profileStatus !== 'ready') {
      el.textContent = '';
      return;
    }
    if (distance === null || !Number.isFinite(distance)) {
      const range = minMaxElevation(profile);
      el.textContent = `${this.i18n.format.distance(profile.distanceM)} · ${this.i18n.format.elevationRange(range.min, range.max)}`;
      return;
    }
    const elevation = elevationAtDistance(profile.samples, distance);
    const grade = gradeAtDistance(profile.samples, distance);
    // 0 m here is the sea surface, not a measured hill: say which one it is.
    const elevationText =
      Number.isFinite(elevation) && Math.abs(elevation) <= 0.5
        ? this.i18n.t('readout.seaLevel')
        : this.i18n.format.elevation(elevation);
    // Labelled: unlabelled, "3,50 km · 1 178 moh · +2,7 %" sitting next to the source
    // badge reads as the route's length while the stats say 9,01 km.
    el.textContent = `${this.i18n.t('readout.at', { distance: this.i18n.format.distance(distance) })} · ${elevationText} · ${this.i18n.format.grade(grade)}`;
  }

  private updateRouteMeta(): void {
    const { route, fatal } = this.state;
    const trip = this.session?.trip ?? null;
    // There is nothing to download without a route, and a menu entry that does
    // nothing is worse than one that is visibly unavailable.
    this.elements.downloadGpxButton.disabled = route === null;
    if (!route) {
      // An empty trip still has a name worth showing — and no origin tag, because
      // nothing has been drawn or imported yet.
      const showName = trip !== null || fatal !== null;
      this.elements.routeMeta.hidden = !showName;
      this.elements.routeTag.hidden = true;
      if (!showName) return;
      this.elements.routeName.textContent = trip?.name ?? this.i18n.t('route.none');
      this.doc.title = `${trip?.name ?? this.i18n.t('route.none')} · ${this.i18n.t('app.name')}`;
      return;
    }
    this.elements.routeMeta.hidden = false;
    this.elements.routeName.textContent = route.name || this.i18n.t('route.unnamed');
    this.elements.routeTag.textContent = this.i18n.t(`route.${route.origin}`);
    this.elements.routeTag.dataset.origin = route.origin;

    this.doc.title = `${route.name || this.i18n.t('route.unnamed')} · ${this.i18n.t('app.name')}`;
  }

  /**
   * The popover is anchored to the badge on desktop. On narrow screens that
   * anchor can sit past the right edge, so it becomes a full-width fixed panel
   * just under the badge.
   */
  private showEmptyState(visible: boolean): void {
    this.elements.emptyState.hidden = !visible;
  }

  // -------------------------------------------------------------------------
  // Banner state
  // -------------------------------------------------------------------------

  private refreshBanners(): void {
    if (this.state.fatal !== null) {
      this.banners.show({
        id: 'map-fatal',
        kind: 'error',
        dismissible: false,
        message: this.i18n.t('banner.mapFailed', { message: this.state.fatal }),
      });
    }

    if (this.state.basemap.status === 'fallback') {
      this.banners.show({
        id: 'basemap-fallback',
        kind: 'warning',
        message: this.i18n.t('banner.basemapFallback'),
        action: {
          label: this.i18n.t('banner.basemapRetry'),
          onClick: () => this.retryBasemap(),
        },
      });
    } else if (this.state.basemap.status === 'failed') {
      this.banners.show({
        id: 'basemap-failed',
        kind: 'error',
        message: this.i18n.t('banner.basemapFailed'),
        action: {
          label: this.i18n.t('banner.basemapRetry'),
          onClick: () => this.retryBasemap(),
        },
      });
    } else if (this.state.basemap.status === 'aerial-failed') {
      this.banners.show({
        id: 'basemap-aerial-failed',
        kind: 'warning',
        message: this.i18n.t('banner.aerialFailed'),
      });
    } else {
      this.banners.dismiss('basemap-fallback');
      this.banners.dismiss('basemap-failed');
      this.banners.dismiss('basemap-aerial-failed');
    }

    if (this.state.terrain.status === 'failed') {
      this.banners.show({
        id: 'terrain-failed',
        kind: 'warning',
        message: this.i18n.t('banner.terrainFailed'),
        action: {
          label: this.i18n.t('action.retry'),
          onClick: () => this.map?.retryTerrain(),
        },
      });
    } else {
      this.banners.dismiss('terrain-failed');
    }

    if (this.state.profileStatus === 'error') {
      const scope = this.state.profileError === 'scope';
      this.banners.show({
        id: scope ? 'off-scope' : 'dem-failed',
        kind: scope ? 'warning' : 'error',
        message: scope
          ? this.i18n.t('banner.offScope')
          : this.i18n.t('banner.demFailed', {
              message: briefError(
                this.state.profileErrorMessage || this.i18n.t('profile.unavailable'),
              ),
            }),
        detail: scope ? undefined : this.state.profileErrorMessage,
        action: scope
          ? undefined
          : { label: this.i18n.t('action.retry'), onClick: () => this.retryElevation() },
      });
    } else {
      this.banners.dismiss('dem-failed');
      this.banners.dismiss('off-scope');
    }

    // The DTM is a bare-earth model: over the sea it returns exactly 0 m. A walk
    // that dips to 0 between high ground is a line across water, and the honest
    // thing to do is name it instead of drawing a silent 1,000 m cliff.
    const profile = this.state.profile;
    const seaLevel =
      this.state.profileStatus === 'ready' && profile !== null ? seaLevelWarning(profile) : null;
    if (seaLevel !== null && profile) {
      const text = (): string =>
        this.i18n.t('banner.seaLevel', {
          distance: this.i18n.format.distance(profile.seaLevelM),
        });
      this.banners.show({
        id: 'sea-level',
        kind: 'warning',
        message: text(),
        retext: () => ({ message: text() }),
      });
    } else {
      this.banners.dismiss('sea-level');
    }
  }

  /** A GPX that could not be read: the reason is kept, so it can be said again. */
  private showGpxError(reason: string): void {
    const text = (): string => this.i18n.t('banner.gpxError', { message: reason });
    this.banners.show({
      id: 'gpx-error',
      kind: 'error',
      message: text(),
      retext: () => ({ message: text() }),
    });
  }

  /** The route is too long to encode into a share link. */
  private showHashTooLong(): void {
    const text = (): string =>
      this.i18n.t('banner.hashTooLong', {
        max: this.i18n.format.number(MAX_HASH_CHARS, { maximumFractionDigits: 0 }),
      });
    this.banners.show({
      id: 'hash-too-long',
      kind: 'info',
      message: text(),
      retext: () => ({ message: text() }),
    });
  }

  private retryBasemap(): void {
    if (!this.map) return;
    this.map.retryBasemap();
    this.state.basemap = { status: 'ok' };
    this.updateBasemapButtons();
    this.refreshBanners();
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  private wireControls(): void {
    // On a phone the ⋯ sheet shows the "mer" menu's items inline, so that
    // disclosure has to be open there — a closed <details> lays its content out
    // but hides it from both paint and hit testing, which left About/Share/
    // Download GPX as invisible rows under the canvas. Desktop keeps its dropdown.
    const menu = document.querySelector<HTMLDetailsElement>('.tb-menu');
    const phone = window.matchMedia('(max-width: 760px)');
    const syncMenuOpenness = () => {
      if (menu) menu.open = phone.matches;
    };
    syncMenuOpenness();
    phone.addEventListener('change', syncMenuOpenness);

    const openButton = byId<HTMLButtonElement>('btn-open');
    openButton.addEventListener('click', () => this.openFilePicker());

    this.elements.editorPanelClose.addEventListener('click', () => this.switchMode('view'));
    this.elements.editorNew.addEventListener('click', () => this.startNewTrip());
    // The header's "New route" is the same action as the dock's, and it is the
    // entry point for someone who has not started editing yet.
    byId<HTMLButtonElement>('btn-new').addEventListener('click', () => this.startNewTrip());
    // The empty state's primary action is the same thing as the header's: an
    // empty screen should start a trip, not play a sample (D26).
    byId<HTMLButtonElement>('btn-empty-new').addEventListener('click', () => this.startNewTrip());
    this.elements.editorSave.addEventListener('click', () => void this.saveTrip());

    this.elements.fileInput.addEventListener('change', () => {
      const file = this.elements.fileInput.files?.[0];
      if (file) void this.loadFile(file);
      this.elements.fileInput.value = '';
    });

    for (const button of this.elements.basemapButtons) {
      button.addEventListener('click', () => {
        const kind = button.dataset.basemap;
        if (kind !== 'topo' && kind !== 'grey' && kind !== 'aerial') return;
        this.map?.setBasemap(kind);
        // Read the controller's verdict: a layer click retries the cache, and
        // the map may still be on the fallback while it does.
        this.state.basemap = this.map?.basemapState ?? { status: 'ok' };
        this.updateBasemapButtons();
        this.refreshBanners();
      });
    }

    for (const button of this.elements.langButtons) {
      button.addEventListener('click', () => {
        const lang = button.dataset.lang;
        if (lang === 'no' || lang === 'en') this.setLanguage(lang);
      });
    }

    this.elements.terrainButton.addEventListener('click', () => {
      if (!this.map) return;
      if (this.state.terrain.status !== 'ready') return;
      const next = !this.map.terrainOn;
      if (!this.map.setTerrainEnabled(next)) return;
      this.elements.terrainButton.setAttribute('aria-pressed', String(next));
      this.syncTerrainButton();
    });

    byId<HTMLButtonElement>('btn-share').addEventListener('click', () => {
      void this.copyShareLink();
    });

    this.elements.downloadGpxButton.addEventListener('click', () => {
      this.closeTopbarMenu();
      this.downloadCurrentGpx();
    });

    byId<HTMLButtonElement>('btn-about').addEventListener('click', () => {
      this.openDialog(this.elements.aboutDialog);
    });

    byId<HTMLButtonElement>('btn-pace').addEventListener('click', () => {
      this.openPaceDialog();
    });

    byId<HTMLButtonElement>('btn-zoom-in').addEventListener('click', () => this.map?.zoomBy(ZOOM_STEP));
    byId<HTMLButtonElement>('btn-zoom-out').addEventListener('click', () => this.map?.zoomBy(-ZOOM_STEP));
    byId<HTMLButtonElement>('btn-north').addEventListener('click', () => this.map?.resetNorth());
    byId<HTMLButtonElement>('btn-fit').addEventListener('click', () => {
      if (this.map && this.state.route) this.map.fitRoute(this.state.route);
    });

    this.elements.profileRetry.addEventListener('click', () => this.retryElevation());

    this.doc.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.routePick) return;
      event.preventDefault();
      this.cancelRoute();
    });

    // The mode has a keyboard contract, and it is stated in the hint line:
    // Escape leaves drawing/editing, Backspace takes back the last edit while
    // drawing, Delete removes the current selection while editing.
    this.doc.addEventListener('keydown', (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // A handler that already consumed this key (the route-pick Escape, a dialog)
      // has decided what it meant; do not act on the same press twice.
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;
      const action = editorKeyAction(this.editorUi.mode, event.key, {
        typing,
        routePick: this.routePick !== null,
        panelOpen: false,
      });
      if (action === null) return;
      event.preventDefault();
      if (action === 'leave-mode') this.switchMode('view');
      else if (action === 'undo') this.undoEdit();
      else this.deleteSelection();
    });

    // Ctrl/Cmd+S saves the open trip even when no editor field has focus.
    this.doc.addEventListener('keydown', (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key !== 's' && event.key !== 'S') return;
      event.preventDefault();
      void this.saveTrip();
    });

    // Leaving the page: flush a pending autosave. IndexedDB writes are async and
    // the browser may not wait for them — docs/12-storage.md says so plainly.
    window.addEventListener('pagehide', () => {
      void this.session?.flush();
    });
    this.doc.addEventListener('visibilitychange', () => {
      if (this.doc.visibilityState === 'hidden') void this.session?.flush();
    });

    window.addEventListener('resize', () => {
      this.map?.resize();
      this.chart.layout();
    });

    this.updateBasemapButtons();
    this.updateLangButtons();
    this.syncTerrainButton();
  }

  private openFilePicker(): void {
    this.elements.fileInput.click();
  }

  private async loadFile(file: File): Promise<void> {
    if (file.size > MAX_FILE_BYTES) {
      this.banners.show({
        id: 'file-too-large',
        kind: 'error',
        message: this.i18n.t('banner.fileTooLarge', {
          size: this.i18n.format.number(file.size / (1024 * 1024), { maximumFractionDigits: 1 }),
          max: this.i18n.format.number(MAX_FILE_BYTES / (1024 * 1024), { maximumFractionDigits: 0 }),
        }),
      });
      return;
    }
    try {
      const text = await file.text();
      await this.loadGpxText(text, 'file', file.name);
    } catch (error) {
      this.showGpxError(messageOf(error));
    }
  }

  private async copyShareLink(): Promise<void> {
    this.closeTopbarMenu();
    const route = this.state.route;
    const base = `${window.location.pathname}${window.location.search}`;
    let url = window.location.href;
    if (route && route.gpxText) {
      const hash = encodeRouteHash(compactGpx(route.gpxText));
      if (hash === null) {
        // Refusing is correct; refusing silently is not. Say it where the click
        // happened (a toast, over the menu) as well as in the banner, and name
        // the way out that always works.
        const text = (): string =>
          this.i18n.t('banner.hashTooLong', {
            max: this.i18n.format.number(MAX_HASH_CHARS, { maximumFractionDigits: 0 }),
          });
        this.showToast(text(), 'warning');
        this.banners.show({ id: 'hash-too-long', kind: 'info', message: text(), retext: () => ({ message: text() }) });
        return;
      }
      url = `${base}${hash}`;
    }

    const copied = await this.writeClipboard(url);
    this.showToast(
      this.i18n.t(copied ? 'banner.shareCopied' : 'banner.shareFailed'),
      copied ? 'info' : 'warning',
    );
  }

  /**
   * Copy through the Clipboard API, falling back to the selection path.
   *
   * `navigator.clipboard` only exists in a secure context, and a dev server
   * opened over a LAN address (`http://192.168.x.x:5173`) is not one — the
   * fallback keeps "Copy link" working there instead of failing with a message
   * about permissions the user cannot grant.
   */
  private async writeClipboard(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fall through: a denied permission is the same problem as a missing API.
    }
    try {
      const area = this.doc.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '0';
      area.style.opacity = '0';
      this.doc.body.append(area);
      area.select();
      const copied = this.doc.execCommand('copy');
      area.remove();
      return copied;
    } catch {
      return false;
    }
  }

  /** Close the header menu, so its own action's feedback is not hidden behind it. */
  private closeTopbarMenu(): void {
    const menu = this.doc.querySelector<HTMLDetailsElement>('.tb-menu');
    if (menu) menu.open = false;
    const more = this.doc.querySelector<HTMLInputElement>('#topbar-more');
    if (more) more.checked = false;
  }

  private showToast(message: string, kind: 'info' | 'warning' = 'info'): void {
    const toast = this.elements.toast;
    toast.textContent = message;
    toast.dataset.kind = kind;
    toast.hidden = false;
    window.setTimeout(() => {
      toast.hidden = true;
    }, 3200);
  }

  // -------------------------------------------------------------------------
  // Language
  // -------------------------------------------------------------------------

  private applyLanguageChrome(): void {
    this.doc.documentElement.lang = this.i18n.lang === 'no' ? 'no' : 'en';
    this.doc.title = this.i18n.t('app.name');
  }

  private setLanguage(lang: Lang): void {
    if (lang === this.i18n.lang) return;
    const previousCursor = this.state.cursorDistance;
    this.i18n.setLang(lang);
    storeLang(this.storage, lang);
    this.syncLangQuery(lang);
    this.applyLanguageChrome();
    this.i18n.apply(this.doc);
    this.updateLangButtons();
    // A language switch re-words the screen; it must not delete a banner the
    // user still has to act on (a quota error, a failed import). The derived
    // states come back from `refreshBanners()`; the event banners are re-worded
    // in place, and `lastSaveBanner` is cleared so the save banner can return.
    this.banners.setCloseLabel(this.i18n.t('action.close'));
    this.banners.refreshLanguage();
    this.lastSaveBanner = null;
    this.refreshBanners();
    this.chart.setLanguage();
    this.stats.refresh();
    this.renderProfilePanel();
    this.renderReadout(this.state.profileStatus === 'ready' ? previousCursor : null);
    this.updateRouteMeta();
    this.updateBasemapButtons();
    this.syncTerrainButton();
    this.updatePaceDialogText();
    this.renderEditor();
    this.renderSaveStatus();
    this.weatherPanel?.refreshLanguage();
    this.trips?.refreshLanguage();
    this.renderSupply();
  }

  /**
   * Keep `?lang=` in sync with an explicit choice. Otherwise a URL override
   * would win over the user's toggle on the next reload.
   */
  private syncLangQuery(lang: Lang): void {
    const url = new URL(window.location.href);
    url.searchParams.set('lang', lang);
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }

  private updateLangButtons(): void {
    for (const button of this.elements.langButtons) {
      const pressed = button.dataset.lang === this.i18n.lang;
      button.setAttribute('aria-pressed', String(pressed));
    }
  }

  private updateBasemapButtons(): void {
    const current = this.map?.basemapKind ?? 'topo';
    for (const button of this.elements.basemapButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.basemap === current));
    }
    // Attribution follows what is on the map: the aerial layer is CC BY, and a
    // licence line for a basemap that is not displayed is not attribution.
    const aerial = current === 'aerial';
    this.elements.attribBasemap.href = aerial
      ? 'https://kartkatalog.geonorge.no/metadata/38a52b73-2ffb-47cc-9ecd-147ee18f62be'
      : 'https://www.kartverket.no';
    this.elements.attribBasemap.textContent = this.i18n.t(
      aerial ? 'attrib.sentinel2' : 'attrib.kartverket',
    );
  }

  private syncTerrainButton(): void {
    const button = this.elements.terrainButton;
    const hint = this.elements.terrainHint;
    const status = this.state.terrain.status;
    if (status === 'ready') {
      button.disabled = false;
      const on = this.map?.terrainOn ?? false;
      button.setAttribute('aria-pressed', String(on));
      button.setAttribute('aria-label', this.i18n.t(on ? 'terrain.disable' : 'terrain.enable'));
      button.title = this.i18n.t(on ? 'terrain.disable' : 'terrain.enable');
      hint.textContent = '';
      return;
    }
    button.disabled = true;
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute(
      'aria-label',
      this.i18n.t(status === 'failed' ? 'terrain.unavailable' : 'terrain.loading'),
    );
    button.title =
      status === 'failed'
        ? `${this.i18n.t('terrain.unavailable')} — ${this.i18n.t('terrain.failedDetail')}`
        : this.i18n.t('terrain.loading');
    hint.textContent = status === 'failed' ? this.i18n.t('terrain.unavailable') : '';
  }

  // -------------------------------------------------------------------------
  // Dialogs
  // -------------------------------------------------------------------------

  private openDialog(dialog: HTMLDialogElement): void {
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  private closeDialog(dialog: HTMLDialogElement): void {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  private wireDialogs(): void {
    for (const dialog of [
      this.elements.aboutDialog,
      this.elements.paceDialog,
      this.elements.tripsDialog,
      this.elements.settingsDialog,
    ]) {
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) this.closeDialog(dialog);
      });
      for (const closer of dialog.querySelectorAll<HTMLElement>('[data-close]')) {
        closer.addEventListener('click', () => this.closeDialog(dialog));
      }
    }

    this.elements.paceForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const speed = Number.parseFloat(this.elements.paceSpeed.value.replace(',', '.'));
      const ascent = Number.parseFloat(this.elements.paceAscent.value.replace(',', '.'));
      if (
        !Number.isFinite(speed) ||
        !Number.isFinite(ascent) ||
        speed < PACE_LIMITS.speedKmh.min ||
        speed > PACE_LIMITS.speedKmh.max ||
        ascent < PACE_LIMITS.ascentMPerHour.min ||
        ascent > PACE_LIMITS.ascentMPerHour.max
      ) {
        this.elements.paceError.hidden = false;
        this.elements.paceError.textContent = this.i18n.t('pace.invalid', {
          min: this.i18n.format.number(PACE_LIMITS.speedKmh.min, { maximumFractionDigits: 0 }),
          max: this.i18n.format.number(PACE_LIMITS.speedKmh.max, { maximumFractionDigits: 0 }),
        });
        return;
      }
      this.pace = normalizePace({ speedKmh: speed, ascentMPerHour: ascent });
      savePace(this.storage, this.pace);
      this.elements.paceError.hidden = true;
      this.renderStats();
      this.updatePaceDialogText();
      this.showToast(
        this.i18n.t('pace.saved', {
          speed: this.i18n.format.number(this.pace.speedKmh, { maximumFractionDigits: 1 }),
          ascent: this.i18n.format.number(this.pace.ascentMPerHour, { maximumFractionDigits: 0 }),
        }),
      );
      this.closeDialog(this.elements.paceDialog);
    });

    byId<HTMLButtonElement>('pace-reset').addEventListener('click', () => {
      this.pace = { ...DEFAULT_PACE };
      savePace(this.storage, this.pace);
      this.elements.paceSpeed.value = String(this.pace.speedKmh);
      this.elements.paceAscent.value = String(this.pace.ascentMPerHour);
      this.renderStats();
      this.updatePaceDialogText();
    });
  }

  private openPaceDialog(): void {
    this.elements.paceSpeed.value = String(this.pace.speedKmh);
    this.elements.paceAscent.value = String(this.pace.ascentMPerHour);
    this.elements.paceError.hidden = true;
    this.updatePaceDialogText();
    this.openDialog(this.elements.paceDialog);
  }

  private updatePaceDialogText(): void {
    this.elements.paceHint.textContent = this.i18n.t('pace.formula', {
      speed: this.i18n.format.number(this.pace.speedKmh, { maximumFractionDigits: 1 }),
      ascent: this.i18n.format.number(this.pace.ascentMPerHour, { maximumFractionDigits: 0 }),
    });
  }

  // -------------------------------------------------------------------------
  // Profile collapse + drop zone + hash
  // -------------------------------------------------------------------------

  private wireProfileCollapse(): void {
    const panel = this.elements.profilePanel;
    const toggle = this.elements.profileToggle;
    const apply = (collapsed: boolean): void => {
      panel.classList.toggle('is-collapsed', collapsed);
      this.elements.profileBody.hidden = collapsed;
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.setAttribute('aria-label', this.i18n.t(collapsed ? 'action.expand' : 'action.collapse'));
      toggle.title = this.i18n.t(collapsed ? 'action.expand' : 'action.collapse');
      if (!collapsed) requestAnimationFrame(() => this.chart.layout());
    };
    const startCollapsed = window.matchMedia?.('(max-width: 760px)').matches ?? false;
    apply(startCollapsed);

    toggle.addEventListener('click', () => {
      const collapsed = !panel.classList.contains('is-collapsed');
      apply(collapsed);
    });

    // Re-apply the label on language change through the same path.
    this.i18n.onChange(() => {
      apply(panel.classList.contains('is-collapsed'));
    });
  }

  private wireDropzone(): void {
    let depth = 0;
    const zone = this.elements.dropzone;
    const show = (visible: boolean): void => {
      zone.hidden = !visible;
    };

    window.addEventListener('dragenter', (event) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      depth++;
      show(true);
      event.preventDefault();
    });
    window.addEventListener('dragover', (event) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) show(false);
    });
    window.addEventListener('drop', (event) => {
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) return;
      event.preventDefault();
      depth = 0;
      show(false);
      const file = files[0];
      // With a trip store available, an imported file goes through it so
      // provenance and elevation survive; otherwise the GPX pipeline runs.
      if (this.session) void this.importTripFile(file);
      else void this.loadFile(file);
    });
  }

  private wireHashChanges(): void {
    window.addEventListener('hashchange', () => {
      const hash = window.location.hash;
      if (!hasRouteHash(hash)) return;
      const text = decodeRouteHash(hash);
      if (text === null) {
        this.banners.show({
          id: 'hash-invalid',
          kind: 'warning',
          message: this.i18n.t('banner.hashInvalid'),
          retext: () => ({ message: this.i18n.t('banner.hashInvalid') }),
        });
        return;
      }
      if (text === this.state.route?.gpxText) return;
      void this.loadGpxText(text, 'link', undefined, { updateHash: false });
    });
  }
}
