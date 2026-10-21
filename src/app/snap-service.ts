/**
 * The trail network used for snapping and reroute.
 *
 * This wraps the Phase 2 snapping engine (`SnapIndex` + `Prefetcher`): the
 * prefetcher fills one index for the current viewport, the index answers
 * `snap()`, and the UI gets an explicit status (`idle|loading|ready|failed`)
 * plus a line count. Nothing here silently returns "no trail" for "not loaded":
 * the toolbar distinguishes the two.
 *
 * Prefetching is triggered by an explicit action (entering draw/edit mode), not
 * by a timer, and repeated viewport loads reuse the persistent SnapCache.
 */

import { SnapIndex, type SnapResult } from '../snap';
import { Prefetcher, type FetchBox, type LonLatBBox, type PrefetchReport } from '../snap/prefetch';
import { getDefaultTurruteClient } from '../snap/wfs';

type SnapNetworkStatus = 'idle' | 'loading' | 'ready' | 'failed';

/**
 * Ceiling on indexed lines before the index is pruned back to the loaded view.
 *
 * A viewport holds hundreds of lines, a city viewport a few thousand; 20 000 is
 * several screens of panning in every direction. Crossing it is the signal that
 * the page has been wandering, and the index is rebuilt around the current view
 * plus its own size again as margin — not cleared, which would make a pan back
 * look like the trail network had disappeared.
 */
const MAX_INDEX_LINES = 20_000;

/**
 * How long one viewport prefetch may take before it is called failed.
 *
 * The WFS client retries a hung request (3 attempts, 30 s each, with backoff), and
 * a viewport plans up to six boxes — so "Load trails…" could sit there for minutes
 * while the service accepted connections and never answered. Measured today:
 * `wfs.geonorge.no` answered `200` on `/` in 0.12 s and never answered
 * `/skwms1/wfs.turogfriluftsruter` at all. An interactive snap layer is worth a
 * dozen seconds, not a coffee break: the deadline turns a hang into a visible
 * failure the user can retry.
 */
export const PREFETCH_DEADLINE_MS = 12_000;

interface SnapServiceOptions {
  index?: SnapIndex;
  prefetcher?: Prefetcher;
  /** Injected fetcher for tests; wins over the WFS client. */
  fetchBox?: FetchBox;
  onChange?: (service: SnapService) => void;
  /** Override the viewport-prefetch deadline. Tests set a small one. */
  prefetchDeadlineMs?: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SnapService {
  readonly index: SnapIndex;
  private readonly prefetcher: Prefetcher;
  private readonly onChange: ((service: SnapService) => void) | undefined;
  private readonly deadlineMs: number;
  private state: SnapNetworkStatus = 'idle';
  private error: string | null = null;
  /** Why the last load failed, in a form the UI can translate. */
  private errorKind: 'timeout' | 'failed' | null = null;
  private report: PrefetchReport | null = null;
  private inFlight = false;
  /** The newest viewport that arrived while a prefetch was running. */
  private queued: LonLatBBox | null = null;

  constructor(options: SnapServiceOptions = {}) {
    this.index = options.index ?? new SnapIndex();
    this.onChange = options.onChange;
    this.deadlineMs = options.prefetchDeadlineMs ?? PREFETCH_DEADLINE_MS;
    this.prefetcher =
      options.prefetcher ??
      new Prefetcher({
        index: this.index,
        ...(options.fetchBox
          ? { fetchBox: options.fetchBox }
          : { client: getDefaultTurruteClient() }),
      });
  }

  get status(): SnapNetworkStatus {
    return this.state;
  }

  get errorMessage(): string | null {
    return this.error;
  }

  /** `timeout` when the service accepted the request and never answered. */
  get failureKind(): 'timeout' | 'failed' | null {
    return this.errorKind;
  }

  get lastReport(): PrefetchReport | null {
    return this.report;
  }

  /** Number of indexed trail lines — one honest measure of "is it loaded". */
  get lineCount(): number {
    return this.index.lineCount;
  }

  get isReady(): boolean {
    return this.state === 'ready';
  }

  /**
   * Load the trail network for one viewport bbox. Never rejects.
   *
   * A viewport asked for while another is loading is **queued, not dropped**:
   * panning mid-load used to leave the new view unindexed until the next settle,
   * which looked exactly like "snapping found nothing". Only the newest queued
   * bbox is kept — an older one would be work for a view the user already left.
   */
  async loadViewport(bbox: LonLatBBox): Promise<void> {
    if (bbox.maxLon <= bbox.minLon || bbox.maxLat <= bbox.minLat) return;
    if (this.inFlight) {
      this.queued = bbox;
      return;
    }
    this.inFlight = true;
    try {
      let next: LonLatBBox | null = bbox;
      while (next) {
        this.queued = null;
        await this.loadOne(next);
        next = this.queued;
      }
    } finally {
      this.inFlight = false;
      this.notify();
    }
  }

  /** One prefetch run: status in, report out. */
  private async loadOne(bbox: LonLatBBox): Promise<void> {
    this.state = 'loading';
    this.error = null;
    this.errorKind = null;
    this.notify();
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const deadline = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), this.deadlineMs);
      });
      const report = await Promise.race([
        this.prefetcher.prefetchViewport(bbox, {
          debounceMs: 120,
          maxRequests: 6,
          concurrency: 2,
        }),
        deadline,
      ]);
      if (report === null) {
        // Stop the requests still in flight: a late answer would otherwise land in
        // the index after the user has been told the network is unavailable.
        this.prefetcher.cancel();
        this.state = 'failed';
        this.errorKind = 'timeout';
        this.error = `the trail service did not answer within ${Math.round(this.deadlineMs / 1000)} s`;
        return;
      }
      this.report = report;
      if (report.aborted) {
        this.state = 'idle';
        return;
      }
      this.pruneTo(bbox);
      // "Ready" means *usable*, not *finished*. With the queue, a camera that keeps
      // settling (an animated fit, a slow drag) would otherwise hold the service in
      // `loading` indefinitely — and snapping is disabled while loading, so the user
      // could not snap at all during a moving map. Later viewports are follow-up
      // work; the index is already usable after the first one.
      if (report.failed > 0 && report.lines === 0 && this.index.lineCount === 0) {
        this.state = 'failed';
        this.errorKind = 'failed';
        this.error = report.failures[0]?.error ?? 'trail network unavailable';
      } else {
        this.state = 'ready';
      }
    } catch (error) {
      this.state = 'failed';
      this.errorKind = 'failed';
      this.error = messageOf(error);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /**
   * Rebuild the index around `bbox` once it has grown past the ceiling.
   *
   * Pure housekeeping: it reports what it dropped so the caller can log it, and
   * it keeps a generous margin (the view again, on every side) because snapping
   * and "Follow trails" act on geometry that is near the view but not inside it.
   */
  private pruneTo(bbox: LonLatBBox): void {
    if (this.index.lineCount <= MAX_INDEX_LINES) return;
    const padLon = (bbox.maxLon - bbox.minLon) / 2;
    const padLat = (bbox.maxLat - bbox.minLat) / 2;
    const west = bbox.minLon - padLon;
    const east = bbox.maxLon + padLon;
    const south = bbox.minLat - padLat;
    const north = bbox.maxLat + padLat;
    this.index.prune((line) =>
      line.coords.some(
        (point) => point.lon >= west && point.lon <= east && point.lat >= south && point.lat <= north,
      ),
    );
  }

  /** Nearest indexed trail within `radiusM`, or `null`. */
  snap(point: { lon: number; lat: number }, radiusM: number, currentLineId?: string | null): SnapResult | null {
    if (this.index.lineCount === 0) return null;
    return this.index.snap(point, { radiusM, currentLineId: currentLineId ?? null });
  }

  cancel(): void {
    // Drop a queued viewport too: "cancel" must not mean "then fetch one more
    // view the user has already left".
    this.queued = null;
    this.prefetcher.cancel();
  }

  private notify(): void {
    this.onChange?.(this);
  }
}
