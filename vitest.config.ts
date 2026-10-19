import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Files share no mutable state; skipping per-file isolation reuses workers
    // and cuts the suite from ~14 s to ~5 s, which keeps the gate under budget.
    isolate: false,
    // Live DEM tests hit hoydedata.no; allow for slow responses.
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Network tests are OPT-IN and excluded from `npm test` by name (*.live.test.ts).
    // Use `npm run test:live` to run them. Keep the default run hermetic so it is
    // safe in CI and on a day when Kartverket or MET is unreachable.
  },
});
