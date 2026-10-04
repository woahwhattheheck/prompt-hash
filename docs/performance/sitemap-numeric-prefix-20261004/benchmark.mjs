// Run with Node 22.16+ native type stripping. Imports the complete source modules.
// No fixtures are installed, no provider is contacted, and no app-wide claim is made.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';

const [beforePath, afterPath, outputPath = 'results.json'] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  throw new Error('Usage: node --experimental-strip-types benchmark.mjs BEFORE.ts AFTER.ts [results.json]');
}
const before = await import(pathToFileURL(resolve(beforePath)).href);
const after = await import(pathToFileURL(resolve(afterPath)).href);
const modules = { before, after };
const pin = (path) => {
  const bytes = readFileSync(path);
  return {
    git_blob: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
};
const freeze = (input) => Object.freeze({
  ...input, prompts: Object.freeze(input.prompts.map(row => Object.freeze(row))),
});
const defaults = { origin: 'https://example.test:8443', lastmod: '2026-10-04' };

// One compatibility fixture exercises both paths and filtering/order in one output.
// Terminal newlines must not qualify as decimal IDs (JavaScript $ is not absolute EOF).
const boundary = freeze({
  ...defaults,
  prompts: ['0', '001', '18446744073709551616', 1n, -2n, '.', '..', '',
    'a/b', 'A&B<"\'', '%2F', 'δ 😀', 'id?query', 'id#fragment', 'foo\\bar',
    '123\n', '123\r', '123\u2028', '123\u2029']
    .map(id => ({ id, active: true }))
    .concat([{ id: 'inactive', active: false }, { id: 'absent' }]),
});
assert.equal(after.buildSitemapXml(boundary), before.buildSitemapXml(boundary));
// Separate malformed-Unicode control retains the original exception behavior.
const malformed = { ...defaults, prompts: [{ id: '\ud800', active: true }] };
assert.throws(() => before.buildSitemapXml(malformed), URIError);
assert.throws(() => after.buildSitemapXml(malformed), URIError);
// The complete origin validator, cache policy and general URL builder stay byte-identical.
const beforeBytes = readFileSync(beforePath, 'utf8');
const afterBytes = readFileSync(afterPath, 'utf8');
const prefix = 'export function buildSitemapXml(';
assert.equal(beforeBytes.split(prefix)[0], afterBytes.split(prefix)[0]);

const workloads = [
  ['empty', 0, 'numeric', 1000],
  ['100-numeric-strings', 100, 'numeric', 10],
  ['10000-numeric-bigints', 10000, 'bigint', 1],
  ['10000-nonnumeric-control', 10000, 'other', 1],
  ['10000-inactive-control', 10000, 'inactive', 10],
];
let consumed = 0;
const samples = [];
const OriginalURL = globalThis.URL;
const urlCalls = (fn, input) => {
  let count = 0;
  globalThis.URL = class extends OriginalURL {
    constructor(...args) { super(...args); count++; }
  };
  try { fn(input); return count; }
  finally { globalThis.URL = OriginalURL; }
};
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
for (const [name, rows, kind, iterations] of workloads) {
  const input = freeze({ ...defaults, prompts: Array.from({ length: rows }, (_, i) => ({
    id: kind === 'bigint' ? BigInt(i) + 9007199254740993n
      : kind === 'other' ? `item-${i}/δ&` : String(i),
    active: kind !== 'inactive',
  })) });
  const expected = before.buildSitemapXml(input);
  assert.equal(after.buildSitemapXml(input), expected);
  const calls = { before: urlCalls(before.buildSitemapXml, input), after: urlCalls(after.buildSitemapXml, input) };
  const measure = (fn) => {
    const start = performance.now();
    for (let n = 0; n < iterations; n++) consumed += fn(input).length;
    return (performance.now() - start) / iterations;
  };
  for (let warmup = 0; warmup < 3; warmup++) {
    measure(before.buildSitemapXml); measure(after.buildSitemapXml);
  }
  const paired = [];
  for (let round = 0; round < 9; round++) {
    const record = {};
    const order = round % 2 ? ['after', 'before'] : ['before', 'after'];
    for (const name of order) record[name] = measure(modules[name].buildSitemapXml);
    paired.push(record);
  }
  samples.push({ name, rows, iterations_per_sample: iterations,
    median_ms: { before: median(paired.map(x => x.before)), after: median(paired.map(x => x.after)) },
    url_constructions_untimed: calls, output_chars: expected.length,
    output_sha256: createHash('sha256').update(expected).digest('hex'),
    samples_ms: paired,
  });
}
const report = {
  recorded_at: new Date().toISOString(),
  runtime: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
  source: { before: pin(beforePath), after: pin(afterPath) },
  comparison: 'Complete buildSitemapXml; native TypeScript stripping, no rewritten implementation',
  correctness: { boundary_fixture_equal: true, malformed_unicode_same_error: true,
    origin_and_general_url_helpers_byte_identical: true, all_workload_outputs_equal: true,
    frozen_inputs: true },
  methodology: { warmups_per_version: 3, alternating_pairs: 9, unit: 'milliseconds per full builder call',
    timings_exclude: ['input construction', 'equality/hash checks', 'URL instrumentation', 'network', 'database', 'HTTP/CDN'] },
  workloads: samples, consumed_chars: consumed,
};
writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
