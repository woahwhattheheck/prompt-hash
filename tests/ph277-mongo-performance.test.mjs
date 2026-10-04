import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import mongoose from 'mongoose';
import {afterAll, beforeAll, it, vi} from 'vitest';
import {fixture, frozenTime, frozenUuid} from '../work/validation/ph277-mongo/fixtures.mjs';

const fixed = vi.hoisted(() => ({uuid: '00000000-0000-4000-8000-000000000001'}));
vi.mock('crypto', async importOriginal => ({
  ...(await importOriginal()),
  randomUUID: () => fixed.uuid,
}));

import * as before from '../server/src/services/payoutStatementService.before.generated.ts';
import * as after from '../server/src/services/payoutStatementService.ts';
import User from '../server/src/models/User.ts';
import Prompt from '../server/src/models/Prompt.ts';
import Purchase from '../server/src/models/Purchase.ts';
import FulfillmentRecord from '../server/src/models/FulfillmentRecord.ts';

const output = process.env.PH277_OUTPUT_DIR || 'artifacts/ph277-mongo';
const pins = JSON.parse(readFileSync('work/validation/ph277-mongo/source-pins.json', 'utf8'));
const RealDate = Date;
const models = [User, Prompt, Purchase, FulfillmentRecord];
const dbName = 'ph277_synthetic_performance';
const report = {
  validation_commit: process.env.GITHUB_SHA || null,
  run_id: process.env.GITHUB_RUN_ID || null,
  source_pins: pins,
  status: 'started',
  methodology: {
    database: 'Disposable MongoDB service, actual Mongoose models and original indexes',
    measured: 'Wall time of actual aggregateSellerStatementFromDb, including database reads and reconciliation',
    samples: '100/1000: one untimed warmup per variant, three paired samples with alternating order; controls: one pair',
    deterministic_boundary: 'Only crypto.randomUUID and no-argument Date construction; Date.now, performance.now, database, models and HMAC stay real',
    monitoring: 'Mongo driver commandStarted; historical Purchase find is distinguished from the period find; getMore counted separately',
    scope: 'Synthetic same-host Mongo timing, not production latency, throughput or concurrent-load evidence',
  },
  cases: [],
};
let active = null;

function persist() {
  mkdirSync(output, {recursive: true});
  writeFileSync(join(output, 'receipt.json'), `${JSON.stringify(report, null, 2)}\n`);
}

function monitor(event) {
  if (!active || event.databaseName !== dbName) return;
  active.commands[event.commandName] = (active.commands[event.commandName] || 0) + 1;
  if (event.commandName === 'getMore') active.getMore++;
  if (event.commandName !== 'find') return;
  active.find++;
  const collection = event.command.find;
  active.collections[collection] = (active.collections[collection] || 0) + 1;
  if (collection !== Purchase.collection.collectionName) return;
  const filter = event.command.filter || {};
  if (Object.hasOwn(filter, 'createdAt')) active.periodPurchaseFind++;
  else {
    active.historicalPurchaseFind++;
    if (Array.isArray(filter.$or)) active.batchSizes.push(filter.$or.length);
    else active.singlePurchaseFind++;
  }
}

beforeAll(async () => {
  assert.equal(frozenUuid, fixed.uuid);
  assert.equal(process.env.PH277_MONGODB_URI, 'mongodb://127.0.0.1:27017/?directConnection=true');
  assert.equal(process.env.PAYOUT_STATEMENT_SECRET, 'ph277-synthetic-only-no-production-use');
  await mongoose.connect(process.env.PH277_MONGODB_URI, {
    dbName, monitorCommands: true, maxPoolSize: 1, serverSelectionTimeoutMS: 10000,
  });
  mongoose.connection.getClient().on('commandStarted', monitor);
  await Promise.all(models.map(model => model.init()));
  const server = await mongoose.connection.db.admin().command({buildInfo: 1});
  report.runtime = {node: process.version, mongoose: mongoose.version, mongodb: server.version};
  report.indexes = {};
  for (const model of [Purchase, FulfillmentRecord]) {
    const indexes = await model.collection.indexes();
    assert.ok(indexes.some(index => index.unique && index.key.promptId === 1 && index.key.buyerWallet === 1));
    report.indexes[model.modelName] = indexes.map(({name, key, unique}) => ({name, key, unique: !!unique}));
  }
  persist();
});

afterAll(async () => {
  active = null;
  globalThis.Date = RealDate;
  if (mongoose.connection.readyState === 1) {
    await Promise.all(models.map(model => model.deleteMany({})));
  }
  await mongoose.disconnect();
  persist();
});

async function seed(data) {
  await Promise.all(models.map(model => model.deleteMany({})));
  await User.create(data.user);
  await Prompt.insertMany(data.prompts.map((prompt, index) => ({
    ...prompt, image: 'https://example.invalid/ph277.png', title: `Synthetic prompt ${index}`,
    content: 'Synthetic performance fixture content.', category: 'Other',
  })));
  if (data.purchases.length) {
    await Purchase.insertMany(data.purchases.map(purchase => ({
      ...purchase, createdAt: new RealDate(purchase.createdAt), updatedAt: new RealDate(purchase.createdAt),
    })), {timestamps: false});
  }
  const ordinaryRefunds = [];
  const legacyRefunds = [];
  for (const refund of data.refunds) {
    const values = {
      ...refund, createdAt: new RealDate(refund.createdAt), updatedAt: new RealDate(refund.updatedAt),
    };
    if (refund.buyerWallet !== refund.buyerWallet.toLowerCase()) {
      // Preserve valid historical mixed-case storage without removing the unique index.
      const document = new FulfillmentRecord(values);
      await document.validate();
      const legacy = document.toObject();
      legacy.buyerWallet = refund.buyerWallet;
      legacyRefunds.push(legacy);
    } else {
      ordinaryRefunds.push(values);
    }
  }
  if (ordinaryRefunds.length) await FulfillmentRecord.insertMany(ordinaryRefunds, {timestamps: false});
  if (legacyRefunds.length) await FulfillmentRecord.collection.insertMany(legacyRefunds);
  assert.equal(await Purchase.countDocuments({}), data.purchases.length);
  assert.equal(await FulfillmentRecord.countDocuments({}), data.refunds.length);
}

async function measure(module, options) {
  const counters = {commands: {}, collections: {}, find: 0, getMore: 0, periodPurchaseFind: 0,
    historicalPurchaseFind: 0, singlePurchaseFind: 0, batchSizes: []};
  // Keep actual driver clocks/timers and monotonic measurement. The service's
  // generatedAt alone needs a deterministic no-argument Date constructor.
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [frozenTime])); }
  };
  active = counters;
  const start = performance.now();
  let statement;
  let milliseconds;
  try {
    statement = await module.aggregateSellerStatementFromDb(options);
    milliseconds = performance.now() - start;
  } finally {
    active = null;
    globalThis.Date = RealDate;
  }
  const {signature, ...unsigned} = statement;
  assert.equal(signature, module.signPayoutStatement(unsigned));
  assert.equal(statement.statementId, `stmt_${frozenUuid}`);
  assert.equal(statement.generatedAt, frozenTime);
  return {statement, milliseconds, counters, csv: module.exportStatementToCsv(statement), json: module.exportStatementToJson(statement)};
}

function compare(a, b, data) {
  assert.deepEqual(b.statement, a.statement);
  assert.equal(b.csv, a.csv);
  assert.equal(b.json, a.json);
  const uniquePairs = new Set(data.refunds.map(row => JSON.stringify([row.promptId, row.buyerWallet.toLowerCase()]))).size;
  assert.equal(a.counters.historicalPurchaseFind, data.refunds.length);
  assert.equal(a.counters.singlePurchaseFind, data.refunds.length);
  assert.equal(b.counters.historicalPurchaseFind, Math.ceil(uniquePairs / 100));
  assert.equal(b.counters.singlePurchaseFind, 0);
  assert.equal(a.counters.find, 4 + data.refunds.length);
  assert.equal(b.counters.find, 4 + Math.ceil(uniquePairs / 100));
  assert.ok(b.counters.batchSizes.every(size => size > 0 && size <= 100));
  return uniquePairs;
}

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

it('measures actual original and batched Mongo aggregation on the same synthetic data', async () => {
  try {
    for (const [name, data, samples] of [
      ['empty', fixture(0), 1], ['100', fixture(100), 3],
      ['1000', fixture(1000), 3], ['mixed', fixture(0, true), 1],
    ]) {
      await seed(data);
      if (samples > 1) compare(await measure(before, data.options), await measure(after, data.options), data);
      const measurements = [];
      let last;
      for (let index = 0; index < samples; index++) {
        const order = index % 2 === 0 ? ['before', 'after'] : ['after', 'before'];
        const pair = {};
        for (const side of order) pair[side] = await measure(side === 'before' ? before : after, data.options);
        const uniquePairs = compare(pair.before, pair.after, data);
        measurements.push({order, before_ms: pair.before.milliseconds, after_ms: pair.after.milliseconds,
          before_commands: pair.before.counters, after_commands: pair.after.counters});
        last = {...pair, uniquePairs};
      }
      if (name === 'mixed') {
        assert.deepEqual(last.after.statement.refunds.map(row => row.purchaseId).sort(), [
          data.purchases[0]._id, data.purchases[1]._id, data.purchases[2]._id,
          data.purchases[0]._id, 'Prompt-A:MISSING-BUYER',
        ].sort());
        assert.equal(last.after.statement.refunds.filter(row => row.isClawback).length, 3);
      }
      const beforeMedian = median(measurements.map(row => row.before_ms));
      const afterMedian = median(measurements.map(row => row.after_ms));
      const result = {case: name, refund_rows: data.refunds.length, unique_pairs: last.uniquePairs,
        complete_statement_equal: true, csv_equal: true, json_equal: true, signatures_valid: true,
        before_median_ms: beforeMedian, after_median_ms: afterMedian,
        observed_median_ratio: beforeMedian / afterMedian, measurements,
        statement_sha256: createHash('sha256').update(last.after.json).digest('hex')};
      report.cases.push(result);
      writeFileSync(join(output, `statement-${name}.json`), `${last.after.json}\n`);
      persist();
      console.log('PH277_CASE_RESULT', JSON.stringify(result));
    }
    report.status = 'passed';
    report.peak_rss_bytes = process.resourceUsage().maxRSS * 1024;
    persist();
    console.log('PH277_RESULT', JSON.stringify(report));
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.stack : String(error);
    persist();
    throw error;
  }
});
