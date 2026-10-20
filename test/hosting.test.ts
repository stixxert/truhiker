import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * The deployment is static-only: a Worker script would add a runtime, a cold
 * start and a dynamic-request budget for no benefit. These tests pin that
 * contract down so it cannot drift silently.
 */

const headersFile = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
const csp = /Content-Security-Policy:\s*(.+)/.exec(headersFile)?.[1]?.trim() ?? '';
const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

describe('static hosting contract', () => {
  it('deploys with no Worker script and allows the live data origins the app actually uses', () => {
    expect(wrangler).not.toMatch(/"main"\s*:/);
    expect(wrangler).toMatch(/"assets"\s*:/);
    expect(wrangler).toMatch(/"directory"\s*:\s*"\.\/dist"/);
    expect(existsSync(new URL('../public/404.html', import.meta.url))).toBe(true);

    const connect = /connect-src ([^;]+)/.exec(csp)?.[1] ?? '';
    const img = /img-src ([^;]+)/.exec(csp)?.[1] ?? '';
    for (const host of [
      'https://cache.kartverket.no',
      'https://wfs.geonorge.no',
      'https://hoydedata.no',
      'https://api.met.no',
    ]) {
      expect(connect).toContain(host);
    }
    for (const host of [
      'https://cache.kartverket.no',
      'https://wms.geonorge.no',
      'https://tiles.mapterhorn.com',
    ]) {
      expect(img).toContain(host);
    }
  });

  it('keeps a strict CSP: no eval, no wildcard, no inline script and no CDN in script-src', () => {
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('*');
    const script = /(?<![\w-])script-src ([^;]+)/.exec(csp)?.[1] ?? '';
    expect(script).not.toContain('unsafe-inline');

    // Regression guard for a real experiment: loading MapLibre from jsDelivr
    // works, but its cross-origin worker fails ("Worker failed to load"), so the
    // CDN path is not a drop-in replacement. Adding a CDN must be justified.
    expect(script.includes('cdn.jsdelivr.net')).toBe(false);
  });

  it('stays under the 100-rule limit, serves hashed assets immutably and never caches index.html that way', () => {
    const rules = headersFile
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#') && !/^\s/.test(line));
    expect(rules.length).toBeLessThanOrEqual(100);

    expect(headersFile).toMatch(
      /\/index\.html\s*\n\s+Cache-Control: public, max-age=0, must-revalidate/,
    );
    // The rule bodies that set `immutable` must not also apply to index.html.
    const immutableBlocks = headersFile.split(/\n(?=\S)/).filter((block) => block.includes('immutable'));
    expect(immutableBlocks.length).toBeGreaterThan(0);
    for (const block of immutableBlocks) expect(block).not.toContain('/index.html');
  });
});
