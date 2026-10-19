#!/usr/bin/env node
/**
 * Accessibility gate: axe-core against the built app, served by the real workerd
 * runtime (`wrangler dev`) with the production headers, at both breakpoints —
 * plus a keyboard-only journey that uses nothing but Tab / Space / Enter / arrow
 * keys / Escape.
 *
 *   npm run a11y
 *
 * Fails (exit 1) if:
 *   - axe reports any *critical* or *serious* violation (moderate/minor are
 *     reported in the log but do not block),
 *   - the menu cannot be reached or opened from the keyboard,
 *   - a panel cannot be opened, does not take focus, or does not close on Escape,
 *   - the elevation profile cannot be reached by Tab or ignores ArrowRight,
 *   - any page error fires during the run.
 *
 * The journey is deliberately mouse-free: `locator.focus()` would prove the
 * widget *can* take focus, not that a keyboard user can *reach* it, so every step
 * is driven by Tab from the document body.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startRuntime } from './runtime.mjs';

const ROOT = process.cwd();
const PORT = 4195;
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];
const TAB_LIMIT = 60;

function fail(message, detail) {
  console.error(`a11y: FAIL — ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

if (!existsSync(join(ROOT, 'dist', 'index.html'))) fail('dist/index.html is missing — run `npm run build` first');

let chromium;
let AxeBuilder;
try {
  ({ chromium } = await import('playwright'));
  ({ default: AxeBuilder } = await import('@axe-core/playwright'));
} catch {
  fail('Playwright or @axe-core/playwright is not installed — run `npm install`');
}

const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const launchArgs = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-certificate-errors'];
if (proxy) launchArgs.push(`--proxy-server=${proxy}`);

let runtime;
let browser;
const scans = [];
const problems = [];
const pageErrors = [];

/** The app is ready when the map shell has mounted and a stat holds a number. */
async function waitForApp(page) {
  await page
    .waitForFunction(
      () => {
        const chart = document.querySelector('#profile-chart');
        const stat = [...document.querySelectorAll('.stat-value')].some((el) => /\d/.test(el.textContent ?? ''));
        return !!chart && chart.getAttribute('aria-valuenow') !== null && stat;
      },
      { timeout: 25_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(500);
}

function describeActive() {
  return document.activeElement
    ? `${document.activeElement.tagName.toLowerCase()}#${document.activeElement.id || ''}`
    : 'none';
}

/** Press Tab until `selector` holds focus; returns true if it does. Keyboard only. */
async function tabTo(page, selector) {
  for (let presses = 0; presses <= TAB_LIMIT; presses += 1) {
    const focused = await page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, selector);
    if (focused) return presses;
    await page.keyboard.press('Tab');
  }
  return -1;
}

async function scan(page, label) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = result.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  scans.push({ label, violations: result.violations.length, blocking: blocking.length });
  for (const violation of blocking) {
    const nodes = violation.nodes.slice(0, 3).map((node) => node.target.join(' ')).join(' | ');
    problems.push(`${label}: ${violation.impact} ${violation.id} — ${violation.help} [${nodes}]`);
  }
  // Moderate/minor are logged for the record; they do not fail the gate.
  for (const violation of result.violations.filter((v) => v.impact !== 'critical' && v.impact !== 'serious')) {
    console.log(`a11y: ${label}: noted ${violation.impact} ${violation.id} (${violation.nodes.length} node(s))`);
  }
}

try {
  runtime = await startRuntime({ port: PORT, label: 'a11y' });
  browser = await chromium.launch({ args: launchArgs });

  // --- axe: default state at both breakpoints --------------------------------
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(`[${viewport.name}] ${error.message}`));
    await page.goto(`${runtime.origin}/`, { waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    await scan(page, viewport.name);
    await context.close();
  }

  // --- keyboard-only journey: mobile, where the menu is a disclosure ---------
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(`[keyboard] ${error.message}`));
    await page.goto(`${runtime.origin}/`, { waitUntil: 'domcontentloaded' });
    await waitForApp(page);

    // 1. Reach the menu toggle with Tab alone.
    const toMenu = await tabTo(page, '#topbar-more');
    if (toMenu < 0) {
      problems.push(`keyboard: the menu toggle cannot be reached with Tab (${TAB_LIMIT} presses)`);
    } else {
      console.log(`a11y: keyboard: menu toggle reached after ${toMenu} Tab press(es)`);
      // 2. Open it with Space.
      await page.keyboard.press('Space');
      const menuOpen = await page.evaluate(() => {
        const body = document.querySelector('.topbar-more-body');
        return !!body && body.getBoundingClientRect().height > 0;
      });
      if (!menuOpen) problems.push('keyboard: Space on the menu toggle does not reveal the menu');
    }

    // 3. Reach Forsyning with Tab and open it with Enter.
    const toSupply = await tabTo(page, '#btn-supply');
    if (toSupply < 0) {
      problems.push(`keyboard: Forsyning cannot be reached with Tab after opening the menu (${TAB_LIMIT} presses)`);
    } else {
      await page.keyboard.press('Enter');
      const opened = await page
        .waitForFunction(
          () => {
            const panel = document.querySelector('#supply-panel');
            return !!panel && !panel.hasAttribute('hidden');
          },
          { timeout: 10_000 },
        )
        .then(() => true)
        .catch(() => false);
      if (!opened) {
        problems.push('keyboard: Enter on Forsyning does not open the panel');
      } else {
        // Focus must move into the panel, otherwise a keyboard user is stranded
        // behind it (the trigger now sits under an open drawer).
        const focusInside = await page.evaluate(
          () => !!document.activeElement?.closest('#supply-panel'),
        );
        if (!focusInside) {
          problems.push(`keyboard: focus does not move into the opened panel (still on ${await page.evaluate(describeActive)})`);
        }
        // 4. Escape closes it and returns focus to the trigger.
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        const state = await page.evaluate(() => ({
          hidden: document.querySelector('#supply-panel')?.hasAttribute('hidden') ?? false,
          focus: document.activeElement?.id ?? '',
        }));
        if (!state.hidden) problems.push('keyboard: Escape does not close the panel');
        if (state.focus !== 'btn-supply') {
          problems.push(`keyboard: Escape leaves focus on "${state.focus || 'nothing'}", not the Forsyning trigger`);
        }
        // The panel is a second rendering surface; audit it too.
        await page.keyboard.press('Enter');
        await page
          .waitForFunction(() => !document.querySelector('#supply-panel')?.hasAttribute('hidden'), { timeout: 10_000 })
          .catch(() => {});
        await scan(page, 'mobile-panel-open');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);

        // 5. The weather panel is the other disclosure; audit it open, and keep
        // using the keyboard to get there (Forsyning -> Vær are adjacent).
        if ((await tabTo(page, '#btn-weather')) >= 0) {
          await page.keyboard.press('Enter');
          const weatherOpen = await page
            .waitForFunction(() => !document.querySelector('#weather-panel')?.hasAttribute('hidden'), { timeout: 15_000 })
            .then(() => true)
            .catch(() => false);
          if (!weatherOpen) {
            problems.push('keyboard: Enter on Vær does not open the weather panel');
          } else {
            await scan(page, 'mobile-weather-open');
            await page.keyboard.press('Escape');
            await page.waitForTimeout(300);
            const weatherClosed = await page.evaluate(
              () => document.querySelector('#weather-panel')?.hasAttribute('hidden') ?? false,
            );
            if (!weatherClosed) problems.push('keyboard: Escape does not close the weather panel');
          }
        } else {
          problems.push('keyboard: Vær cannot be reached with Tab after closing Forsyning');
        }
      }
    }
    await context.close();
  }

  // --- keyboard-only journey: the elevation profile (desktop) ----------------
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(`[profile] ${error.message}`));
    await page.goto(`${runtime.origin}/`, { waitUntil: 'domcontentloaded' });
    await waitForApp(page);

    const toProfile = await tabTo(page, '#profile-chart');
    if (toProfile < 0) {
      problems.push(`keyboard: the elevation profile cannot be reached with Tab (${TAB_LIMIT} presses)`);
    } else {
      console.log(`a11y: keyboard: profile reached after ${toProfile} Tab press(es)`);
      const before = await page.evaluate(() => document.querySelector('#profile-chart')?.getAttribute('aria-valuenow'));
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(250);
      const after = await page.evaluate(() => document.querySelector('#profile-chart')?.getAttribute('aria-valuenow'));
      if (!before || before === after) {
        problems.push(`keyboard: ArrowRight does not move the profile cursor (aria-valuenow ${before} -> ${after})`);
      } else {
        const step = Number(after) - Number(before);
        console.log(`a11y: keyboard: profile cursor ${before} -> ${after} (Δ${step})`);
      }
      const backBefore = after;
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(250);
      const backAfter = await page.evaluate(() => document.querySelector('#profile-chart')?.getAttribute('aria-valuenow'));
      if (backBefore === backAfter) problems.push('keyboard: ArrowLeft does not move the profile cursor back');
    }
    await context.close();
  }
} finally {
  await browser?.close().catch(() => {});
  runtime?.stop();
}

for (const row of scans) console.log(`a11y: ${row.label}: ${row.violations} violation(s), ${row.blocking} critical/serious`);
if (pageErrors.length > 0) problems.push(...pageErrors.map((error) => `page error: ${error}`));
if (problems.length > 0) fail(`${problems.length} problem(s)`, problems.map((problem) => `  - ${problem}`).join('\n'));
console.log('a11y: OK — no critical or serious violations, keyboard journey passes');
process.exit(0);
