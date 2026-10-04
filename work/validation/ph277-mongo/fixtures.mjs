const id = (value) => value.toString(16).padStart(24, '0');
export const frozenTime = '2026-02-01T12:00:00.000Z';
export const frozenUuid = '00000000-0000-4000-8000-000000000001';

export function fixture(size, mixed = false) {
  const user = {_id: id(1), walletAddress: 'gseller', payoutSettings: {payoutAddress: 'GDEST'}};
  const prompts = [
    {_id: id(10), owner: user._id, onChainId: 'Prompt-A', price: 10},
    {_id: id(11), owner: user._id, onChainId: 'prompt-a', price: 20},
  ];
  let purchases = Array.from({length: size}, (_, index) => ({
    _id: id(100 + index), promptId: prompts[index % 2].onChainId,
    buyerWallet: `buyer-${index}`, versionIndex: 1, txHash: `tx-${index}`,
    createdAt: index % 3 === 0 ? '2025-12-15T12:00:00.000Z' : '2026-01-10T12:00:00.000Z',
  }));
  let refunds = purchases.map((purchase, index) => ({
    _id: id(100000 + index), promptId: purchase.promptId, buyerWallet: purchase.buyerWallet,
    status: 'refunded', createdAt: purchase.createdAt, updatedAt: '2026-01-20T12:00:00.000Z',
  }));
  if (mixed) {
    purchases = [
      {_id: id(100), promptId: 'Prompt-A', buyerWallet: 'buyer-a', versionIndex: 1, createdAt: '2025-12-15T12:00:00.000Z'},
      {_id: id(101), promptId: 'Prompt-A', buyerWallet: 'buyer-b', versionIndex: 1, createdAt: '2026-01-10T12:00:00.000Z'},
      {_id: id(102), promptId: 'prompt-a', buyerWallet: 'buyer-a', versionIndex: 1, createdAt: '2025-12-20T12:00:00.000Z'},
    ];
    refunds = [
      {promptId: 'Prompt-A', buyerWallet: 'BUYER-A'},
      {promptId: 'Prompt-A', buyerWallet: 'buyer-b'},
      {promptId: 'prompt-a', buyerWallet: 'buyer-a'},
      {promptId: 'Prompt-A', buyerWallet: 'buyer-a'},
      {promptId: 'Prompt-A', buyerWallet: 'MISSING-BUYER'},
    ].map((pair, index) => ({...pair, _id: id(100000 + index), status: 'refunded',
      createdAt: '2026-01-03T12:00:00.000Z', updatedAt: '2026-01-20T12:00:00.000Z'}));
  }
  return {user, prompts, purchases, refunds, options: {
    sellerWallet: 'GSELLER', periodStart: '2026-01-01T00:00:00.000Z',
    periodEnd: '2026-01-31T23:59:59.999Z', previousBalanceCarryoverStroops: -17,
    priorSettledPeriodEnd: '2025-12-31T23:59:59.999Z',
    payoutAttempts: [{attemptId: 'pending-1', amountStroops: 0, status: 'pending', attemptedAt: '2026-01-31T00:00:00.000Z'}],
  }};
}
