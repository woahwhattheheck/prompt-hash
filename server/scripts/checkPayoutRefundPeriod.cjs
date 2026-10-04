/** Focused integration check against a disposable loopback MongoDB. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const mongoose = require('mongoose');
const server = path.resolve(__dirname, '..');
const uri = process.env.PAYOUT_REFUND_MONGO_URI;
if (!uri || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(uri).hostname)) {
  throw new Error('PAYOUT_REFUND_MONGO_URI must identify a disposable loopback MongoDB');
}
if (!process.env.PAYOUT_REFUND_BEFORE) throw new Error('Set PAYOUT_REFUND_BEFORE to the preceding complete service source');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ph277-refund-'));
const sourcePath = 'src/services/payoutStatementService.ts';
const beforeText = fs.readFileSync(process.env.PAYOUT_REFUND_BEFORE, 'utf8');
const afterText = fs.readFileSync(path.join(server, sourcePath), 'utf8');
const blob = (text) => crypto.createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
const compile = (relative, text) => {
  const target = path.join(temporary, relative.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, ts.transpileModule(text, {compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  }}).outputText);
  return target;
};
fs.symlinkSync(path.dirname(path.dirname(require.resolve('mongoose/package.json'))), path.join(temporary, 'node_modules'), 'dir');
for (const relative of ['src/constants/platformFee.ts', 'src/models/User.ts', 'src/models/Prompt.ts', 'src/models/Purchase.ts', 'src/models/FulfillmentRecord.ts']) {
  compile(relative, fs.readFileSync(path.join(server, relative), 'utf8'));
}
const before = require(compile('src/services/before.ts', beforeText));
const after = require(compile(sourcePath, afterText));
const User = require(path.join(temporary, 'src/models/User.js')).default;
const Prompt = require(path.join(temporary, 'src/models/Prompt.js')).default;
const Purchase = require(path.join(temporary, 'src/models/Purchase.js')).default;
const Fulfillment = require(path.join(temporary, 'src/models/FulfillmentRecord.js')).default;
const dbName = `ph277_refund_${crypto.randomBytes(8).toString('hex')}`;
const jan = ['2026-01-01T00:00:00.000Z', '2026-01-31T23:59:59.999Z'];
const feb = ['2026-02-01T00:00:00.000Z', '2026-02-28T23:59:59.999Z'];
const historical = new Date('2025-12-15T12:00:00.000Z');
const janRefund = new Date('2026-01-20T12:00:00.000Z');
const febEdit = new Date('2026-02-10T12:00:00.000Z');
const rows = [];
let queries = [];
mongoose.set('debug', (collection, method, query) => { if (method === 'find' || method === 'findOne') queries.push({collection, method, query}); });
async function seed(auditLog, updatedAt, count = 1, status = 'refunded') {
  await Purchase.deleteMany({});
  await Fulfillment.deleteMany({});
  await Purchase.collection.insertMany(Array.from({length: count}, (_, i) => ({
    promptId: 'Prompt-A', buyerWallet: `buyer-${i}`, versionIndex: 1,
    createdAt: historical, updatedAt: historical,
  })));
  await Fulfillment.collection.insertMany(Array.from({length: count}, (_, i) => ({
    promptId: 'Prompt-A', buyerWallet: `buyer-${i}`, status,
    createdAt: historical, updatedAt, ...(auditLog === undefined ? {} : {auditLog}),
  })));
}
const normalized = (statement) => ({...statement, statementId: 'fixed', generatedAt: 'fixed', signature: 'fixed'});
async function compare(name, period, oldCount, newCount, expectedAt, expectedQueries) {
  const options = {sellerWallet: 'GSELLER', periodStart: period[0], periodEnd: period[1], priorSettledPeriodEnd: '2025-12-31T23:59:59.999Z'};
  queries = [];
  const previous = await before.aggregateSellerStatementFromDb(options);
  const oldQueries = queries.length;
  queries = [];
  const current = await after.aggregateSellerStatementFromDb(options);
  const newQueries = queries.length;
  assert.equal(previous.refunds.length, oldCount, `${name}: original count`);
  assert.equal(current.refunds.length, newCount, `${name}: repaired count`);
  assert.equal(current.refundSellerDebitStroops, newCount * 95_000_000, `${name}: seller debit`);
  assert.equal(current.netSettlementStroops, -newCount * 95_000_000 || 0, `${name}: settlement`);
  for (const refund of current.refunds) {
    assert.equal(refund.isClawback, true);
    if (expectedAt) assert.equal(refund.refundedAt, expectedAt);
  }
  if (oldCount === newCount) assert.deepEqual(normalized(current), normalized(previous), `${name}: full control statement`);
  if (expectedQueries !== undefined) assert.equal(newQueries, expectedQueries, `${name}: query count`);
  rows.push({name, original_refunds: oldCount, repaired_refunds: newCount, original_queries: oldQueries, repaired_queries: newQueries});
}
(async () => {
  try {
    await mongoose.connect(uri, {dbName});
    await Promise.all([User.init(), Prompt.init(), Purchase.init(), Fulfillment.init()]);
    const owner = new mongoose.Types.ObjectId();
    await User.collection.insertOne({_id: owner, walletAddress: 'gseller', payoutSettings: {payoutAddress: 'gdest'}});
    await Prompt.collection.insertOne({owner, onChainId: 'Prompt-A', price: 10});
    await seed([{status: 'refunded', at: janRefund}], janRefund);
    await compare('ordinary January refund', jan, 1, 1, janRefund.toISOString(), 5);
    await seed([{status: 'refunded', at: janRefund}], febEdit);
    await compare('later edit does not remove January refund', jan, 0, 1, janRefund.toISOString(), 5);
    await compare('later edit does not debit February again', feb, 1, 0, undefined, 4);
    await seed([{status: 'refunded', at: febEdit}, {status: 'refunded', at: janRefund}], febEdit);
    await compare('earliest transition despite reordered repeated writes', jan, 0, 1, janRefund.toISOString());
    await compare('later repeated transition is not another refund', feb, 1, 0);
    await seed(undefined, febEdit);
    await compare('legacy missing audit keeps previous behavior', feb, 1, 1, febEdit.toISOString());
    await seed([{status: 'delivered', at: janRefund}, {status: 'refunded', at: null}], febEdit);
    await compare('no usable refund audit keeps legacy fallback', feb, 1, 1, febEdit.toISOString());
    for (const boundary of jan) {
      await seed([{status: 'refunded', at: new Date(boundary)}], febEdit);
      await compare(`inclusive boundary ${boundary}`, jan, 0, 1, boundary);
    }
    await seed([{status: 'refunded', at: new Date('2026-03-01T00:00:00.000Z')}], febEdit);
    await compare('record edit cannot pull a March refund into February', feb, 1, 0);
    await seed([{status: 'refunded', at: janRefund}], febEdit, 1, 'delivered');
    await compare('current non-refunded state remains excluded', jan, 0, 0);
    await seed([{status: 'refunded', at: janRefund}], febEdit, 101);
    await compare('101 refunds preserve bounded purchase lookup', jan, 0, 101, janRefund.toISOString(), 6);
    await compare('filtered old refunds need no historical purchase lookup', feb, 101, 0, undefined, 4);
    await seed([{status: 'refunded', at: janRefund}], janRefund);
    const now = new Date();
    await Fulfillment.findOneAndUpdate({promptId: 'Prompt-A', buyerWallet: 'buyer-0'}, {
      $set: {status: 'refunded', failureReason: 'later metadata correction'},
      $push: {auditLog: {status: 'refunded', note: 'later metadata correction', at: now}},
    });
    await compare('real model status write retains first refund period', jan, 0, 1, janRefund.toISOString());
    const day = now.toISOString().slice(0, 10);
    await compare('real model status write is not a new current-day refund', [`${day}T00:00:00.000Z`, `${day}T23:59:59.999Z`], 1, 0);
    const mongo = await mongoose.connection.db.admin().command({buildInfo: 1});
    console.log(JSON.stringify({runtime: process.version, mongoose: mongoose.version, mongodb: mongo.version,
      before_blob: blob(beforeText), after_blob: blob(afterText), comparisons: rows.length, rows,
      limits: 'Real disposable MongoDB queries and production models; controlled records, no HTTP route or blockchain execution.'}, null, 2));
  } finally {
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    fs.rmSync(temporary, {recursive: true, force: true});
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
