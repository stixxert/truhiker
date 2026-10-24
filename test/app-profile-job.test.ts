/**
 * A route cleared or replaced during the compute frame must not be repainted by
 * the job that route cancelled.
 *
 * `App.sampleRoute` releases the job handle before the compute-phase
 * `requestAnimationFrame`, so `this.job === null` cannot tell "nobody took over"
 * from "the user cleared the route during this one frame" — the old profile was
 * written into `state.profile`, the chart and the stats for a route that no
 * longer existed. The guard compares the route's identity as well, and the
 * profile it writes carries `route.distances`, so the length on the stats bar is
 * the length on the chart.
 *
 * The harness drives the shipped body of `sampleRoute()` on a
 * prototype-created instance: the element lookups in the constructor need a full
 * document and there is no DOM in this suite, so the job, the chart and the
 * renderers are stubs. That is the whole point of the two cases below — the
 * second proves the first is not vacuous: with no replacement in the gap, the
 * same call really does write a profile.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cumulativeDistances, type LonLat } from '../src/core/geo';
import type { Profile } from '../src/core/profile';
import { App } from '../src/app/app';
import { buildRoute, type Route } from '../src/lib/route';

/**
 * The one elevation job the app can hold. `cancel()` resolves nothing, which is
 * exactly how the real client behaves: a cancelled job never settles.
 */
const job = vi.hoisted(() => ({
  resolve: null as ((elevations: Float64Array) => void) | null,
  cancelled: 0,
  created: 0,
}));

vi.mock('../src/lib/elevation-client', () => ({
  createElevationJob: () => {
    job.created += 1;
    return {
      promise: new Promise<Float64Array>((resolve) => {
        job.resolve = resolve;
      }),
      cancel: () => {
        job.cancelled += 1;
      },
    };
  },
}));

interface HarnessState {
  route: Route | null;
  profile: Profile | null;
  profileStatus: string;
  profileError: string | null;
  profileErrorMessage: string;
  progress: { done: number; total: number; phase: 'download' | 'compute' };
  cursorDistance: number | null;
  cursorSource: string;
}

/** The slice of `App` that `sampleRoute()` touches. */
interface AppInternals {
  state: HarnessState;
  job: unknown;
  chart: { setProfile(profile: Profile | null): void };
  sampleRoute(route: Route): void;
  renderProfilePanel(): void;
  renderStats(): void;
  refreshBanners(): void;
  syncCursorToCamera(): void;
  invalidateSupply(): void;
  setProfileError(kind: string, message?: string): void;
}

/** A zig-zag dense enough that 25 m resampling is measurably shorter than it. */
function zigZag(): LonLat[] {
  return Array.from({ length: 12 }, (_, index) => ({
    lon: 8.3 + index * 0.0006,
    lat: 61.6 + (index % 2 === 0 ? 0.0003 : -0.0003),
  }));
}

function routeNamed(name: string, coords: LonLat[] = zigZag()): Route {
  return buildRoute({ name, coords, origin: 'file' });
}

function elevationsFor(route: Route): Float64Array {
  return Float64Array.from(route.points, (_, index) => 400 + (index % 5) * 20);
}

function harness(route: Route | null): {
  app: AppInternals;
  painted: (Profile | null)[];
  errors: string[];
} {
  const painted: (Profile | null)[] = [];
  const errors: string[] = [];
  const app = Object.create(App.prototype) as unknown as AppInternals;
  app.state = {
    route,
    profile: null,
    profileStatus: route === null ? 'empty' : 'loading',
    profileError: null,
    profileErrorMessage: '',
    progress: { done: 0, total: 0, phase: 'download' },
    cursorDistance: null,
    cursorSource: 'map',
  };
  app.job = null;
  app.chart = { setProfile: (profile) => painted.push(profile) };
  app.renderProfilePanel = () => {};
  app.renderStats = () => {};
  app.refreshBanners = () => {};
  app.syncCursorToCamera = () => {};
  app.invalidateSupply = () => {};
  app.setProfileError = (kind, message) => errors.push(`${kind}: ${message ?? ''}`);
  return { app, painted, errors };
}

/** The animation frames the code under test is parked on. */
const frames: FrameRequestCallback[] = [];

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Start a job and run it to the compute-phase frame, which stays un-fired. */
async function runToComputeFrame(app: AppInternals, route: Route): Promise<void> {
  app.sampleRoute(route);
  expect(job.created).toBe(1);
  job.resolve?.(elevationsFor(route));
  await settle();
  expect(frames).toHaveLength(1);
}

beforeEach(() => {
  frames.length = 0;
  job.resolve = null;
  job.cancelled = 0;
  job.created = 0;
  // Node has no animation frames; the compute phase waits on exactly one.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    frames.push(callback);
    return frames.length;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App.sampleRoute — the compute frame', () => {
  it('writes nothing when the route was replaced in the gap, and nothing into the new route', async () => {
    const routeA = routeNamed('a');
    const routeB = routeNamed('b');
    const { app, painted, errors } = harness(routeA);

    await runToComputeFrame(app, routeA);

    // The gap: the user imports another route. The old job is cancelled and its
    // handle released, so `this.job` is null — the job check alone cannot see this.
    app.job = null;
    app.state.route = routeB;
    app.state.profile = null;
    app.state.profileStatus = 'loading';

    frames.shift()?.(0);
    await settle();

    expect(app.state.profile).toBeNull();
    expect(app.state.profileStatus).toBe('loading');
    expect(painted).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('writes nothing when the route was cleared in the gap', async () => {
    const routeA = routeNamed('a');
    const { app, painted } = harness(routeA);

    await runToComputeFrame(app, routeA);

    // `clearRoute`: no route, no job, nothing to paint a profile onto.
    app.job = null;
    app.state.route = null;
    app.state.profile = null;
    app.state.profileStatus = 'empty';

    frames.shift()?.(0);
    await settle();

    expect(app.state.profile).toBeNull();
    expect(app.state.profileStatus).toBe('empty');
    expect(painted).toEqual([]);
  });

  it('still writes the profile for the route the job was started for, at the route’s own length', async () => {
    const route = routeNamed('kept');
    const { app, painted, errors } = harness(route);

    // The resampled line is shorter than the drawn one: that gap is why the
    // profile must be handed the route's canonical distances.
    const sampledLength = cumulativeDistances(route.points).at(-1) ?? 0;
    expect(sampledLength).toBeLessThan(route.distanceM - 1);

    await runToComputeFrame(app, route);
    frames.shift()?.(0);
    await settle();

    expect(errors).toEqual([]);
    expect(app.state.profileStatus).toBe('ready');
    expect(painted).toHaveLength(1);
    expect(app.state.profile).not.toBeNull();
    // One route, one length: the stats bar's `route.distanceM` and the chart's
    // `profile.distanceM` are the same number.
    expect(app.state.profile?.distanceM).toBe(route.distanceM);
    expect(app.state.profile?.samples.at(-1)?.d).toBe(route.distanceM);
  });
});
