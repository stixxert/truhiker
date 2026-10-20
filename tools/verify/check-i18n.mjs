#!/usr/bin/env node
/**
 * i18n gate: the two dictionaries must describe the same UI, the code must only
 * ask for keys that exist, and no Nynorsk may leak into a Bokmål product.
 *
 *   npm run i18n                       (through tsx)
 *   node tools/verify/check-i18n.mjs   (plain node re-execs itself through tsx
 *                                       when the runtime cannot import .ts)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
// `tsx` loads the .ts files through a loader, so `process.features.typescript`
// stays false inside it: the marker stops the re-exec from recursing.
if (!process.features.typescript && !process.env.TRUHIKER_I18N_TSX) {
  if (!existsSync(TSX)) {
    console.error('i18n: FAIL — this Node cannot import .ts files and tsx is not installed (npm install)');
    process.exit(1);
  }
  const result = spawnSync(TSX, [import.meta.filename], {
    stdio: 'inherit',
    env: { ...process.env, TRUHIKER_I18N_TSX: '1' },
  });
  process.exit(result.status ?? 1);
}
const { en } = await import('../../src/i18n/en.ts');
const { no } = await import('../../src/i18n/no.ts');
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
const NYNORSK =
  /\b(ikkje|punktar|berre|vere|noko|korleis|kva|hopp|gjer|vert|saman|frå|medan|òg|høgde|høgder|mykje|sjølv|difor|sidan|utan|fyrst|framleis|allereie|korkje|anten)\b/i;
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

// ---------------------------------------------------------------------------
// No user-visible string may be written outside the dictionaries.
//
// Two surfaces are checked because they fail differently:
//   - `index.html`: text nodes. An element carrying `data-i18n*` gets its text
//     from the dictionary at runtime, so only *unmarked* text can go stale.
//     Proper nouns and licence identifiers are language-neutral and allowed.
//   - `src/ui/**`: literals assigned to a visible sink (textContent, title,
//     aria-label, ...). Template literals may contain `${…}` but no bare words.
// ---------------------------------------------------------------------------

/** Words that are the same in both languages: names, URLs, units, symbols. */
const NEUTRAL = /^(?:TruHiker|Kartverket|Mapterhorn|Turrutebasen|MET Norway|OpenStreetMap|MapLibre GL JS|EOX Cloudless|Sentinel-2|CC BY 4\.0|ODbL 1\.0|m|km|°C)$/;
const URLISH = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?$/i;
const HAS_LETTERS = /[A-Za-zÆØÅæøå]/;

// 1. index.html text nodes.
{
  let html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  html = html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // The no-JS notice is deliberately bilingual and never shown with JS on.
    .replace(/<noscript[\s\S]*?<\/noscript>/g, '');
  for (const match of html.matchAll(/<([a-zA-Z][^>]*)>([^<]*)/g)) {
    const [, attrs, raw] = match;
    const text = raw.trim();
    if (!text || !HAS_LETTERS.test(text)) continue;
    if (/data-i18n/.test(attrs)) continue;
    // "©Kartverket" is attribution, not a sentence.
    const bareName = text.replace(/^[©®™\s]+/, '');
    if (NEUTRAL.test(bareName) || URLISH.test(text)) continue;
    problems.push(`index.html: unmarked visible text "${text.slice(0, 60)}" (add data-i18n or make it neutral)`);
  }
}

// 2. src/ui/** literal assignments to visible sinks.
{
  const SINKS = [
    { re: /\.(?:textContent|innerText|innerHTML)\s*=\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g },
    { re: /\.(?:title|placeholder)\s*=\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g },
    {
      re: /setAttribute\(\s*(['"])(?:aria-label|title|placeholder|alt)\1\s*,\s*(['"`])((?:\\.|(?!\2)[\s\S])*?)\2/g,
      literal: 3,
    },
    { re: /createTextNode\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g },
  ];
  for (const file of walk(join(ROOT, 'src', 'ui'))) {
    const body = readFileSync(file, 'utf8');
    for (const sink of SINKS) {
      for (const match of body.matchAll(sink.re)) {
        const literal = match[sink.literal ?? 2] ?? '';
        const bare = literal.replace(/\$\{[^}]*\}/g, '').trim();
        if (!bare || !HAS_LETTERS.test(bare)) continue;
        if (NEUTRAL.test(bare)) continue;
        const line = body.slice(0, match.index).split('\n').length;
        problems.push(
          `${file.slice(ROOT.length + 1)}:${line}: hardcoded visible text "${bare.slice(0, 60)}" — use i18n.t()`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error('i18n: FAIL');
  for (const problem of [...new Set(problems)]) console.error('  - ' + problem);
  process.exit(1);
}
console.log(`i18n: OK — ${keysNo.size} keys in both languages, placeholders match, no Nynorsk, all references resolve, no hardcoded UI text`);
