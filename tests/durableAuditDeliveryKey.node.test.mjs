/** Run: node --experimental-strip-types --test tests/durableAuditDeliveryKey.node.test.mjs */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const source = process.env.DURABLE_AUDIT_SOURCE
  ? pathToFileURL(process.env.DURABLE_AUDIT_SOURCE)
  : new URL('../src/lib/audit/durableAudit.ts', import.meta.url);
const { DurableAuditQueue, createInMemoryOutboxStore, buildDeliveryKey,
  redactAcceptInput, AuditAcceptError } = await import(source.href);
const first = { action: 'unlock_success', result: 'success', promptId: 'prompt',
  requestId: 'a|b', reason: 'c' };
const second = { ...first, requestId: 'a', reason: 'b|c' };
const legacyKey = (p) => createHash('sha256').update([
  p.action, p.result, p.promptId ?? '', p.walletHash ?? '',
  p.requestId ?? '', p.reason ?? '',
].join('|')).digest('hex');
function setup(maxBacklog = 10) {
  const store = createInMemoryOutboxStore();
  let ids = 0;
  return { store, queue: new DurableAuditQueue(store, {
    maxBacklog, now: () => 1000, idFactory: () => `receipt-${++ids}`,
  }) };
}
async function seedLegacy(store, input = first) {
  const payload = redactAcceptInput(input);
  await store.insert({ acceptanceId: 'legacy-receipt', deliveryKey: legacyKey(payload),
    payload, status: 'accepted', attemptCount: 0, maxRetries: 5,
    createdAt: 1000, nextAttemptAt: 1000, lastError: null,
    leaseToken: null, leaseExpiresAt: null });
}

test('distinct delimiter-bearing events get separate receipts and both drain', async () => {
  const { store, queue } = setup();
  const a = await queue.accept(first);
  const b = await queue.accept(second);
  assert.notEqual(a.acceptanceId, b.acceptanceId);
  assert.equal(b.duplicate, false);
  assert.equal(await store.countOpen(), 2);
  const delivered = [];
  assert.deepEqual(await queue.drainAll(async (payload, id) => delivered.push({ payload, id })),
    { drained: 2, retried: 0, dlq: 0 });
  assert.deepEqual(delivered.map((r) => [r.payload.requestId, r.payload.reason]),
    [['a|b', 'c'], ['a', 'b|c']]);
});

test('exact concurrent retries retain one receipt', async () => {
  const { queue } = setup();
  const receipts = await Promise.all([queue.accept(first), queue.accept(first)]);
  assert.equal(receipts[0].acceptanceId, receipts[1].acceptanceId);
  assert.equal(receipts.filter((r) => !r.duplicate).length, 1);
});

test('ordinary keys and single-lookup acceptance remain unchanged', async () => {
  const { store, queue } = setup();
  const input = { ...first, requestId: 'ordinary', reason: null };
  const payload = redactAcceptInput(input);
  assert.equal(buildDeliveryKey(payload), legacyKey(payload));
  let lookups = 0;
  const find = store.findByDeliveryKey;
  store.findByDeliveryKey = async (...args) => { lookups++; return find(...args); };
  const receipt = await queue.accept(input);
  assert.equal(lookups, 1);
  assert.deepEqual(await queue.accept(input), { ...receipt, duplicate: true });
  assert.equal(lookups, 2);
});

test('a matching legacy delimiter-bearing event retains its original receipt', async () => {
  const { store, queue } = setup();
  await seedLegacy(store);
  assert.deepEqual(await queue.accept(first), { acceptanceId: 'legacy-receipt', duplicate: true });
  assert.equal(await store.countOpen(), 1);
});

test('a colliding legacy key cannot stand in for a different stored event', async () => {
  const { store, queue } = setup();
  await seedLegacy(store);
  const receipt = await queue.accept(second);
  assert.equal(receipt.duplicate, false);
  assert.notEqual(receipt.acceptanceId, 'legacy-receipt');
  assert.equal(await store.countOpen(), 2);
  assert.deepEqual((await store.getById('legacy-receipt')).payload, redactAcceptInput(first));
  assert.deepEqual(await queue.accept(second), { ...receipt, duplicate: true });
});

test('collision repair does not bypass a saturated backlog', async () => {
  const { store, queue } = setup(1);
  await seedLegacy(store);
  await assert.rejects(queue.accept(second), (error) =>
    error instanceof AuditAcceptError && error.causeDetail === 'backlog_saturated');
  assert.equal(await store.countOpen(), 1);
  assert.equal(queue.getMetrics().dropped, 1);
});

test('legacy lookup failure remains fail-closed', async () => {
  const { store, queue } = setup();
  const key = legacyKey(redactAcceptInput(first));
  store.findByDeliveryKey = async (candidate) => {
    if (candidate === key) throw new Error('offline');
    return null;
  };
  await assert.rejects(queue.accept(first), AuditAcceptError);
  assert.equal(await store.countOpen(), 0);
});
