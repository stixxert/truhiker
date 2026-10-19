/**
 * Bundle budget check.
 *
 *   node scripts/bundle-size.mjs [distDir] [budgetKiB]
 *
 * Reports both gzip and brotli sizes for every emitted JS file and enforces the
 * product budget on the total JS payload (default 500 KiB). CSS is reported for
 * context but is not part of the JS budget.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const dir = process.argv[2] ?? 'dist';
const budget = Math.round(Number(process.argv[3] ?? 500) * 1024);

function files(extension) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(extension))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .sort();
}

function measure(path) {
  const bytes = readFileSync(path);
  return {
    raw: bytes.byteLength,
    gzip: gzipSync(bytes, { level: 9 }).byteLength,
    brotli: brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength,
  };
}

function row(label, size) {
  const kb = (value) => (value / 1024).toFixed(1).padStart(8);
  console.log(`${label.padEnd(44)}${kb(size.raw)}${kb(size.gzip)}${kb(size.brotli)}`);
}

console.log(`${'file'.padEnd(44)}${'raw KB'.padStart(8)}${'gzip KB'.padStart(9)}${'br KB'.padStart(9)}`);

const jsTotals = { raw: 0, gzip: 0, brotli: 0 };
for (const path of [...files('.js'), ...files('.mjs')]) {
  const size = measure(path);
  jsTotals.raw += size.raw;
  jsTotals.gzip += size.gzip;
  jsTotals.brotli += size.brotli;
  row(path.replace(`${dir}/`, ''), size);
}
row('JS total', jsTotals);

const cssTotals = { raw: 0, gzip: 0, brotli: 0 };
for (const path of files('.css')) {
  const size = measure(path);
  cssTotals.raw += size.raw;
  cssTotals.gzip += size.gzip;
  cssTotals.brotli += size.brotli;
  row(path.replace(`${dir}/`, ''), size);
}
row('CSS total', cssTotals);

const status = jsTotals.gzip <= budget ? 'PASS' : 'FAIL';
console.log(
  `\nJS budget: ${status} — ${(jsTotals.gzip / 1024).toFixed(1)} KiB gzip ` +
    `/ ${(jsTotals.brotli / 1024).toFixed(1)} KiB brotli of ${(budget / 1024).toFixed(0)} KiB`,
);
process.exitCode = jsTotals.gzip <= budget ? 0 : 1;
