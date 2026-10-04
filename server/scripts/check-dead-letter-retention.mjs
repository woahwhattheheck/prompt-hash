#!/usr/bin/env node
/** Run with Node >=22: node --experimental-strip-types server/scripts/check-dead-letter-retention.mjs */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  assert(['--source', '--baseline', '--json'].includes(args[i]), `Unknown argument ${args[i]}`);
  assert(args[i + 1] && !args[i + 1].startsWith('--'), `Missing value for ${args[i]}`);
  options[args[i]] = resolve(args[i + 1]);
}
const source = options['--source'] ?? fileURLToPath(new URL('../src/services/eventDeadLetter.ts', import.meta.url));
const module = await import(pathToFileURL(source).href);
const reasons = ['UNSUPPORTED_VERSION', 'UNKNOWN_EVENT_TYPE', 'SCHEMA_VALIDATION_FAILED', 'CORRUPT_PAYLOAD'];
const record = (id) => ({
  reason: reasons[id % reasons.length], message: String(id), schemaVersion: 99,
  contractEvent: null, lifecycle: null, raw: { schemaVersion: 99 },
  receivedAt: '2026-10-04T00:00:00.000Z',
});
const records = Array.from({ length: 200000 }, (_, id) => record(id));
const checks = [];
async function check(name, fn) {
  await fn();
  checks.push(name);
}
function equivalentQueue(Type) {
  for (const capacity of [0, 1, 3, 31, 1000]) {
    const sink = new Type(capacity);
    let expected = [];
    for (let i = 0; i < 4100; i++) {
      if (i === 1009 || i === 3021) {
        sink.clear();
        expected = [];
      } else {
        sink.push(records[i]);
        expected.push(records[i]);
        if (expected.length > capacity) expected.splice(0, expected.length - capacity);
      }
      assert.equal(sink.size(), expected.length);
      if (i % 97 === 0 || i === 4099) {
        assert.deepEqual(sink.list(), expected);
        for (const reason of reasons) {
          assert.deepEqual(sink.byReason(reason), expected.filter((entry) => entry.reason === reason));
        }
      }
    }
  }
}
await check('FIFO, reason filtering, wraparound and clear/refill match reference at five capacities', () => {
  equivalentQueue(module.InMemoryEventDeadLetter);
});
await check('returned arrays are snapshots; record identity is preserved', () => {
  const sink = new module.InMemoryEventDeadLetter(3);
  for (let i = 0; i < 5; i++) sink.push(records[i]);
  const snapshot = sink.list();
  assert.equal(snapshot[0], records[2]);
  sink.push(records[5]);
  assert.deepEqual(snapshot, records.slice(2, 5));
  snapshot.length = 0;
  const filtered = sink.byReason(records[4].reason);
  filtered.length = 0;
  assert.deepEqual(sink.list(), records.slice(3, 6));
});
await check('default capacity retains the latest 1000 records', () => {
  const sink = new module.InMemoryEventDeadLetter();
  records.slice(0, 2501).forEach((entry) => sink.push(entry));
  assert.equal(sink.size(), 1000);
  assert.deepEqual(sink.list(), records.slice(1501, 2501));
});
await check('invalid capacities fail explicitly instead of losing the retention bound', () => {
  for (const capacity of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new module.InMemoryEventDeadLetter(capacity), RangeError);
  }
});
await check('successful synchronous and asynchronous routing preserve records', async () => {
  const sink = new module.InMemoryEventDeadLetter(2);
  assert.equal(module.routeToDeadLetter(records[0], sink), undefined);
  const asyncSink = { push: async (entry) => sink.push(entry) };
  assert.equal(module.routeToDeadLetter(records[1], asyncSink), undefined);
  await new Promise(setImmediate);
  assert.deepEqual(sink.list(), records.slice(0, 2));
});
await check('synchronous and asynchronous sink failures remain contained', async () => {
  const saved = console.error;
  const logs = [];
  const failure = new Error('controlled unavailable sink');
  console.error = (...values) => logs.push(values);
  try {
    assert.equal(module.routeToDeadLetter(records[0], { push() { throw failure; } }), undefined);
    assert.equal(module.routeToDeadLetter(records[0], { push: () => Promise.reject(failure) }), undefined);
    await new Promise(setImmediate);
    assert.equal(logs.length, 2);
    for (const values of logs) assert.deepEqual(values, ['[event-dlq] failed to persist dead-letter record', failure]);
  } finally {
    console.error = saved;
  }
});
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const summary = {
  environment: { node: process.version, platform: process.platform, arch: process.arch, hostname: hostname() },
  source_sha256: hash(source), checks_passed: checks.length, checks, benchmarks: [],
};
if (options['--baseline']) {
  const baseline = await import(pathToFileURL(options['--baseline']).href);
  summary.baseline_sha256 = hash(options['--baseline']);
  // The old module must preserve the same valid-capacity behavior too.
  equivalentQueue(baseline.InMemoryEventDeadLetter);
  summary.baseline_equivalence_passed = true;
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  function measure(Type, capacity) {
    const sink = new Type(capacity);
    for (let i = 0; i < capacity; i++) sink.push(records[i]);
    let observed = 0;
    const cpu = process.cpuUsage();
    const start = performance.now();
    for (let i = 0; i < records.length; i++) {
      sink.push(records[i]);
      // Include the existing public read APIs during a rejection-heavy stream.
      if ((i + 1) % 10000 === 0) {
        observed += sink.list().length + sink.byReason('UNSUPPORTED_VERSION').length;
      }
    }
    const wall_ms = performance.now() - start;
    const used = process.cpuUsage(cpu);
    const retained = sink.list();
    assert.deepEqual(retained, records.slice(-capacity));
    const retained_sha256 = createHash('sha256').update(JSON.stringify(retained)).digest('hex');
    return { wall_ms, cpu_ms: (used.user + used.system) / 1000, observed, retained_sha256 };
  }
  for (const capacity of [1000, 10000]) {
    // Warm each implementation once, then alternate measured order to reduce bias.
    measure(baseline.InMemoryEventDeadLetter, capacity);
    measure(module.InMemoryEventDeadLetter, capacity);
    const samples = [];
    for (let pair = 0; pair < 5; pair++) {
      const entry = { order: pair % 2 === 0 ? ['before', 'after'] : ['after', 'before'] };
      for (const name of entry.order) {
        entry[name] = measure((name === 'before' ? baseline : module).InMemoryEventDeadLetter, capacity);
      }
      assert.equal(entry.before.observed, entry.after.observed);
      assert.equal(entry.before.retained_sha256, entry.after.retained_sha256);
      samples.push(entry);
    }
    const before_ms = median(samples.map((entry) => entry.before.wall_ms));
    const after_ms = median(samples.map((entry) => entry.after.wall_ms));
    summary.benchmarks.push({ capacity, pushes: records.length, read_every: 10000, before_median_ms: before_ms,
      after_median_ms: after_ms, median_ratio: before_ms / after_ms, samples });
  }
}
const output = JSON.stringify(summary, null, 2) + '\n';
if (options['--json']) writeFileSync(options['--json'], output);
process.stdout.write(output);
