#!/usr/bin/env node
/**
 * i18n gate: the two dictionaries must describe the same UI, the code must only
 * ask for keys that exist, and no Nynorsk may leak into a Bokmål product.
 *
 *   npm run i18n
 *
 * Run through tsx so the TypeScript dictionaries can be imported directly.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { en } from '../../src/i18n/en.ts';
import { no } from '../../src/i18n/no.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const problems = [];

const keysNo = new Set(Object.keys(no));
const keysEn = new Set(Object.keys(en));

for (const key of keysNo) if (!keysEn.has(key)) problems.push(`missing in EN: ${key}`);
for (const key of keysEn) if (!keysNo.has(key)) problems.push(`missing in NO: ${key}`);

const placeholders = (value) =>
  [...String(value).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

for (const key of keysNo) {
  if (!keysEn.has(key)) continue;
  const a = placeholders(no[key]);
  const b = placeholders(en[key]);
  if (a !== b) problems.push(`placeholder mismatch for ${key}: NO {${a}} vs EN {${b}}`);
}

// Nynorsk and Danish/Swedish forms that do not belong in a Bokmål UI.
const NYNORSK = /\b(ikkje|punktar|berre|vere|noko|korleis|kva|hopp|gjer|vert|saman|frå|medan|òg)\b/i;
for (const [key, value] of Object.entries(no)) {
  if (typeof value === 'string' && NYNORSK.test(value)) {
    problems.push(`Nynorsk form in NO.${key}: "${value}"`);
  }
}

// Every t('…') / data-i18n="…" in the app must name a defined key.
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (/\.(ts|html)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const USED = /\bt\(\s*'([a-zA-Z0-9_.]+)'|\bt\(\s*"([a-zA-Z0-9_.]+)"|data-i18n(?:-aria-label|-title|-placeholder)?="([a-zA-Z0-9_.]+)"/g;
for (const file of [...walk(join(ROOT, 'src')), join(ROOT, 'index.html')]) {
  if (file.includes(join('src', 'i18n'))) continue;
  const body = readFileSync(file, 'utf8');
  for (const match of body.matchAll(USED)) {
    const key = match[1] ?? match[2] ?? match[3];
    if (!key || key.includes('${')) continue;
    if (!keysNo.has(key)) problems.push(`${file.slice(ROOT.length + 1)}: unknown key "${key}"`);
  }
}

if (problems.length > 0) {
  console.error('i18n: FAIL');
  for (const problem of [...new Set(problems)]) console.error('  - ' + problem);
  process.exit(1);
}
console.log(`i18n: OK — ${keysNo.size} keys in both languages, placeholders match, no Nynorsk, all references resolve`);
