/**
 * Reproduce the period-parsing optimization against the complete service.
 * From the repository root, after installing existing server dependencies:
 *   git show 4ca1a18d6f761628918480e77e99e59e6f0dca47:server/src/services/payoutStatementService.ts > /tmp/payout-before.ts
 *   node --expose-gc server/scripts/benchmarkPayoutPeriod.cjs /tmp/payout-before.ts /tmp/payout-period.json
 * No network, live database, new dependency, or application write is used.
 * The model boundary is a recorded fixture, not a MongoDB measurement.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const ts = require('typescript');

if (!process.argv[2]) throw new Error('Expected baseline source path; see this file header.');
const servicePath = path.resolve(__dirname, '../src/services/payoutStatementService.ts');
const feePath = path.resolve(__dirname, '../src/constants/platformFee.ts');
const source = [fs.readFileSync(process.argv[2], 'utf8'), fs.readFileSync(servicePath, 'utf8')];
const feeSource = fs.readFileSync(feePath, 'utf8');
const blob = (text) => crypto.createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
assert.equal(blob(source[0]), '8ea9c8cbaae9a91cb8fec10bea3d45e3eb32d04f', 'Baseline must be the recorded original source');
assert.equal(blob(feeSource), 'e9001bbe60250837b171b95fb01a4fc9f5e8196c', 'Fee implementation must be unchanged');
const fixedTime = '2026-10-04T12:00:00.000Z';
class MetadataDate extends Date {
  static [Symbol.hasInstance](value) { return value instanceof Date; }
  constructor(...args) { super(...(args.length ? args : [fixedTime])); }
}
function compile(text, dependencies, DateImpl = Date) {
  const output = ts.transpileModule(text, {
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  });
  assert.equal(output.diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error).length, 0);
  const module = { exports: {} };
  vm.runInNewContext(output.outputText, {
    module, exports: module.exports, require: dependencies, Date: DateImpl, Error, RangeError,
    process: { env: { PAYOUT_STATEMENT_SECRET: 'synthetic-period-benchmark' } },
  });
  return module.exports;
}
const fee = compile(feeSource, require);
function load(text, models = {}, DateImpl = Date) {
  return compile(text, (name) => {
    if (name === 'crypto') return { ...crypto, randomUUID: () => 'period-benchmark' };
    if (name === '../constants/platformFee') return fee;
    if (name.startsWith('../models/')) return models[name.split('/').pop()] || {};
    throw new Error(`Unexpected dependency: ${name}`);
  }, DateImpl);
}
const services = source.map((text) => load(text));
const period = { start: '2026-09-01T00:00:00.000Z', end: '2026-09-30T23:59:59.999Z' };
const base = { statementId: 'stmt_period_benchmark', generatedAt: fixedTime, sellerWallet: 'GSELLER', payoutAddress: 'GPAYOUT', period, purchases: [], refunds: [] };
const purchase = (i, at = '2026-09-15T12:34:56.789Z') => ({ purchaseId: `p${i}`, promptId: `id${i % 7}`, buyerWallet: `buyer${i}`, grossStroops: 1234567 + (i % 200), purchasedAt: at });
const refund = (i, at = '2026-09-20T09:00:00.000Z') => ({ purchaseId: `p${i}`, promptId: `id${i % 7}`, originalGrossStroops: 1234567 + (i % 200), refundedAt: at, originalPurchasedAt: '2026-08-20T00:00:00.000Z' });
const input = (n) => ({ ...base, purchases: Array.from({ length: n }, (_, i) => purchase(i)), refunds: Array.from({ length: Math.floor(n / 10) }, (_, i) => refund(i)) });
function outcome(service, data) {
  try {
    const statement = service.reconcilePayoutStatement(data);
    return { json: service.exportStatementToJson(statement), csv: service.exportStatementToCsv(statement) };
  } catch (error) { return { error: `${error.name}: ${error.message}` }; }
}
const controls = [
  base,
  { ...base, purchases: [purchase(0, period.start), purchase(1, period.end), purchase(2, '2026-08-31T23:59:59.999Z'), purchase(3, '2026-10-01T00:00:00.000Z')], refunds: [refund(0, period.start), refund(1, period.end), refund(2, '2026-08-31T23:59:59.999Z')], priorSettledPeriodEnd: '2026-08-31T23:59:59.999Z', previousBalanceCarryoverStroops: -99 },
  { ...base, period: { start: '2026-09-15T08:34:56.789-04:00', end: '2026-09-15T14:34:56.789+02:00' }, purchases: [purchase(0)] },
  { ...base, period: { start: '2026-09-15', end: '2026-09-15' }, purchases: [purchase(0, '2026-09-15T00:00:00Z'), purchase(1)] },
  ...[undefined, { start: null, end: period.end }, { start: 'bad', end: period.end }, { start: period.end, end: period.start }].map((invalid) => ({ ...base, period: invalid })),
  { ...base, purchases: [purchase(0, 'bad-event-time')] },
  { ...base, refunds: [refund(0, 'bad-refund-time')] },
  { ...base, purchases: [purchase(0)], feeBps: -1 },
];
for (const data of controls) assert.deepEqual(outcome(services[0], data), outcome(services[1], data));
assert.equal(JSON.parse(outcome(services[1], controls[1]).json).saleCount, 2);
assert.equal(JSON.parse(outcome(services[1], controls[2]).json).saleCount, 1);
assert.equal(JSON.parse(outcome(services[1], controls[3]).json).saleCount, 1);
function countParses(service, data) {
  const original = Date.parse;
  let total = 0, boundaries = 0;
  try {
    Date.parse = (value) => { total++; if (value === period.start || value === period.end) boundaries++; return original(value); };
    service.reconcilePayoutStatement(data);
  } finally { Date.parse = original; }
  return { total, boundaries };
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function main() {
  // Run the complete aggregator too, observing the model/query boundary.
  const aggregations = [];
  for (const text of source) {
    const queries = [];
    const result = (name, data) => (query) => { queries.push([name, query]); return { select() { return this; }, async lean() { return data; } }; };
    const service = load(text, {
      User: { findOne: result('User', { _id: 'seller', payoutSettings: { payoutAddress: 'GPAYOUT' } }) },
      Prompt: { find: result('Prompt', [{ onChainId: 'id0', price: 2 }]) },
      Purchase: { find: result('Purchase', [{ _id: 'p0', promptId: 'id0', buyerWallet: 'buyer0', createdAt: new Date(period.start) }]) },
      FulfillmentRecord: { find: result('FulfillmentRecord', [{ promptId: 'id0', buyerWallet: 'buyer0', createdAt: new Date(period.start), updatedAt: new Date('2026-10-03'), auditLog: [{ status: 'refunded', at: new Date(period.end) }] }]) },
    }, MetadataDate);
    const statement = await service.aggregateSellerStatementFromDb({ sellerWallet: base.sellerWallet, periodStart: period.start, periodEnd: period.end });
    aggregations.push(JSON.stringify({ statement, queries, csv: service.exportStatementToCsv(statement) }));
  }
  assert.equal(aggregations[0], aggregations[1]);
  assert.equal(JSON.parse(aggregations[1]).statement.refunds.length, 1);
  const rows = [];
  for (const n of [1000, 10000, 50000]) {
    const data = input(n), before = JSON.stringify(data);
    const expected = outcome(services[0], data);
    assert.deepEqual(outcome(services[1], data), expected);
    for (let warmup = 0; warmup < 3; warmup++) for (const service of services) service.reconcilePayoutStatement(data);
    const samples = [[], []];
    for (let repeat = 0; repeat < 7; repeat++) for (const index of repeat % 2 ? [1, 0] : [0, 1]) {
      global.gc?.();
      const start = performance.now();
      const statement = services[index].reconcilePayoutStatement(data);
      samples[index].push(performance.now() - start);
      assert.equal(services[index].exportStatementToJson(statement), expected.json);
    }
    assert.equal(JSON.stringify(data), before);
    rows.push({ purchases: n, refunds: data.refunds.length, input_sha256: crypto.createHash('sha256').update(before).digest('hex'), parse_calls: services.map((service) => countParses(service, data)), samples_ms: samples, median_ms: samples.map(median), speedup: median(samples[0]) / median(samples[1]) });
  }
  const report = {
    measured_at: new Date().toISOString(), baseline_commit: '4ca1a18d6f761628918480e77e99e59e6f0dca47', source_blobs: source.map(blob), fee_blob: blob(feeSource),
    node: process.version, typescript: ts.version, platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0].model, explicit_gc: Boolean(global.gc),
    method: 'Complete reconciliation including real fee arithmetic and HMAC; three warmups, seven paired samples with alternating order. Export checks and input-preservation checks are outside the timed region. Metadata is fixed.',
    controls: { reconciliation_comparisons: controls.length, recorded_model_aggregation_comparisons: 1, all_passed: true },
    limits: 'Synthetic warmed in-process workloads; not production latency, live MongoDB, HTTP, a semantic typecheck, or the maintained Jest suite. Models are recorded fixtures and Date/UUID metadata is controlled in the aggregation comparison.', rows,
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (process.argv[3]) fs.writeFileSync(process.argv[3], json);
  console.log(json);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
