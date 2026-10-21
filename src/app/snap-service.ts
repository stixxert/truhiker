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

interface SnapServiceOptions {
  index?: SnapIndex;
  prefetcher?: Prefetcher;
  /** Injected fetcher for tests; wins over the WFS client. */
  fetchBox?: FetchBox;
  onChange?: (service: SnapService) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SnapService {
  readonly index: SnapIndex;
  private readonly prefetcher: Prefetcher;
  private readonly onChange: ((service: SnapService) => void) | undefined;
  private state: SnapNetworkStatus = 'idle';
  private error: string | null = null;
  private report: PrefetchReport | null = null;
  private inFlight = false;
  /** The newest viewport that arrived while a prefetch was running. */
  private queued: LonLatBBox | null = null;

  constructor(options: SnapServiceOptions = {}) {
    this.index = options.index ?? new SnapIndex();
    this.onChange = options.onChange;
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
    this.notify();
    try {
      const report = await this.prefetcher.prefetchViewport(bbox, {
        debounceMs: 120,
        maxRequests: 6,
        concurrency: 2,
      });
      this.report = report;
      if (report.aborted) {
        this.state = 'idle';
        return;
      }
      if (report.failed > 0 && report.lines === 0) {
        this.state = 'failed';
        this.error = report.failures[0]?.error ?? 'trail network unavailable';
      } else {
        this.state = 'ready';
      }
    } catch (error) {
      this.state = 'failed';
      this.error = messageOf(error);
    }
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
