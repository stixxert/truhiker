#!/usr/bin/env node
/**
 * Guard for docs/DECISIONS.md.
 *
 * The point of that document is that no ambiguity is left for a user to discover
 * in the field. This script makes the promise checkable: every required decision
 * must still be present, and the source must not accumulate TODO/FIXME markers
 * (an unresolved decision hiding as a comment).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.cwd();
const DECISIONS = join(ROOT, 'docs/DECISIONS.md');

/** Each entry: the heading that must exist and what it governs. */
const REQUIRED = [
  ['D1', 'hut food availability'],
  ['D2', 'opening hours, Sundays and holidays'],
  ['D3', 'mail drops and parcel windows'],
  ['D4', 'weather horizon'],
  ['D5', 'snapping radius and off-trail behaviour'],
  ['D6', 'storage limits'],
  ['D7', 'when a live source is down'],
  ['D8', 'units, language, time'],
  ['D9', 'elevation provenance'],
  ['D10', 'energy model and food weight'],
  ['D11', 'data freshness'],
  ['D12', 'what the app refuses to claim'],
];

const problems = [];

let text;
try {
  text = readFileSync(DECISIONS, 'utf8');
} catch {
  console.error('check-decisions: docs/DECISIONS.md is missing');
  process.exit(1);
}

for (const [id, subject] of REQUIRED) {
  if (!new RegExp(`^## ${id}\\.`, 'm').test(text)) {
    problems.push(`DECISIONS.md is missing section ${id} (${subject})`);
  }
}

// A decision must state a default, not just discuss the topic.
const defaults = (text.match(/\*\*Default/g) ?? []).length;
if (defaults < REQUIRED.length) {
  problems.push(
    `only ${defaults} of ${REQUIRED.length} sections state a **Default** — ` +
      'a section without a default is still an open question',
  );
}

/** Walk source files looking for unresolved markers. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (['.ts', '.mjs', '.css'].includes(extname(path))) out.push(path);
  }
  return out;
}

const MARKER = /\b(TODO|FIXME|XXX|HACK)\b/;
for (const file of walk(join(ROOT, 'src'))) {
  const body = readFileSync(file, 'utf8');
  body.split('\n').forEach((line, index) => {
    if (MARKER.test(line)) {
      problems.push(`${file.slice(ROOT.length + 1)}:${index + 1} has an unresolved marker: ${line.trim()}`);
    }
  });
}

if (problems.length > 0) {
  console.error('check-decisions: FAIL');
  for (const problem of problems) console.error('  - ' + problem);
  process.exit(1);
}

console.log(
  `check-decisions: OK — ${REQUIRED.length}/${REQUIRED.length} decisions documented, ` +
    `${defaults} defaults stated, no TODO/FIXME in src/`,
);
