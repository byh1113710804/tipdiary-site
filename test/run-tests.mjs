// Golden test runner: loads rules-v1.json + golden-deduction-cases.json, runs every case
// through assets/engine.js, and asserts all 9 numeric fields (exact string-decimal, no epsilon)
// plus warnings as a set (null == absent). Exits non-zero on any mismatch.
//
// engine.js has no module syntax (it attaches to globalThis), so we read + indirect-eval it.
// That keeps the exact same file runnable in the browser and here.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = join(__dirname, '..');

const rules = JSON.parse(readFileSync(join(repo, 'rules-v1.json'), 'utf8'));
const fixture = JSON.parse(readFileSync(join(repo, 'golden-deduction-cases.json'), 'utf8'));

const engineSrc = readFileSync(join(repo, 'assets', 'engine.js'), 'utf8');
(0, eval)(engineSrc); // indirect eval -> runs in global scope; engine attaches to globalThis
const engine = globalThis.TipDiaryEngine;
if (!engine || typeof engine.evaluate !== 'function') {
  console.error('FAIL: engine did not load (globalThis.TipDiaryEngine.evaluate missing)');
  process.exit(1);
}

// Map fixture "expected" keys -> engine result keys (savings* use DeductionResult field names).
const NUMERIC = [
  ['deductibleNow', 'deductibleNow'],
  ['projectedDeductible', 'projectedDeductible'],
  ['capTotal', 'capTotal'],
  ['capRemaining', 'capRemaining'],
  ['phaseOutReduction', 'phaseOutReduction'],
  ['savingsLow', 'estimatedSavingsLow'],
  ['savingsHigh', 'estimatedSavingsHigh'],
  ['projectedSavingsLow', 'projectedSavingsLow'],
  ['projectedSavingsHigh', 'projectedSavingsHigh']
];

function eqNullableString(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  return String(a) === String(b);
}

function sameWarningSet(expected, actual) {
  const e = [...(expected || [])].sort();
  const a = [...(actual || [])].sort();
  if (e.length !== a.length) return false;
  for (let i = 0; i < e.length; i++) if (e[i] !== a[i]) return false;
  return true;
}

const refDate = fixture.referenceDate;
let passed = 0;
const failures = [];

for (const c of fixture.cases) {
  const r = engine.evaluate(rules, c.input, refDate);
  const problems = [];

  for (const [expKey, resKey] of NUMERIC) {
    if (!eqNullableString(c.expected[expKey], r[resKey])) {
      problems.push(`${expKey}: expected ${JSON.stringify(c.expected[expKey])}, got ${JSON.stringify(r[resKey])}`);
    }
  }
  if (!sameWarningSet(c.expected.warnings, r.warnings)) {
    problems.push(`warnings: expected ${JSON.stringify(c.expected.warnings)}, got ${JSON.stringify(r.warnings)}`);
  }

  if (problems.length === 0) {
    passed++;
    console.log(`PASS  ${c.name}`);
  } else {
    failures.push({ name: c.name, problems });
    console.log(`FAIL  ${c.name}`);
    for (const p of problems) console.log(`        - ${p}`);
  }
}

const total = fixture.cases.length;
console.log(`\n${passed}/${total} passing`);

if (failures.length > 0) {
  console.error(`\n${failures.length} case(s) failed.`);
  process.exit(1);
}
console.log('All golden cases match the TaxEngine.');
