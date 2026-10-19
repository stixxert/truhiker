/**
 * Start the built app through `wrangler dev` (workerd) in a throwaway copy of
 * `dist/`, with the production `wrangler.jsonc` — so a gate exercises the real
 * runtime and the headers Cloudflare actually applies, not a stand-in server.
 *
 * Shared by every browser gate (visual-check --runtime, e2e, a11y, perf,
 * failure-paths) so the startup, readiness check and cleanup cannot drift.
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler');
const HOST = '127.0.0.1';

/**
 * @param {object} options
 * @param {number} options.port free port to listen on
 * @param {string} [options.label] prefix for the temp directory (debugging aid)
 * @param {number} [options.readyTimeoutMs]
 * @returns {Promise<{origin: string, stop: () => void}>}
 */
export async function startRuntime({ port, label = 'runtime', readyTimeoutMs = 40_000 }) {
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html is missing — run `npm run build` first');
  }
  if (!existsSync(WRANGLER)) {
    throw new Error('wrangler is not installed — run `npm install`');
  }

  // wrangler resolves assets relative to its config, so build the copy it reads.
  const directory = mkdtempSync(join(tmpdir(), `truhiker-${label}-`));
  cpSync(join(ROOT, 'dist'), join(directory, 'dist'), { recursive: true });
  for (const file of ['wrangler.jsonc', 'package.json']) cpSync(join(ROOT, file), join(directory, file));

  const child = spawn(WRANGLER, ['dev', '--port', String(port), '--ip', HOST], {
    cwd: directory,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr?.on('data', (chunk) => { output += chunk.toString(); });

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    child.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  };

  const origin = `http://${HOST}:${port}`;
  const started = Date.now();
  for (;;) {
    if (child.exitCode !== null) {
      stop();
      throw new Error(`wrangler dev exited with ${child.exitCode}\n${output.slice(-1500)}`);
    }
    try {
      const response = await fetch(`${origin}/`, { redirect: 'manual' });
      if (response.ok) return { origin, stop };
    } catch {
      /* not listening yet */
    }
    if (Date.now() - started > readyTimeoutMs) {
      stop();
      throw new Error(`wrangler dev did not answer within ${readyTimeoutMs / 1000} s\n${output.slice(-1500)}`);
    }
    await new Promise((done) => setTimeout(done, 250));
  }
}
