# Refund period stability

The fulfillment resolution route records an `auditLog` entry with status
`refunded` and a timestamp. A subsequent status/metadata write can change
`updatedAt` and append another audit entry without creating another
purchase entitlement. Previously, statement aggregation selected only
`updatedAt` and also used it as the refund date, so one completed refund
could disappear from its original period and reappear as a later debit.

Aggregation now considers either an in-period refund audit entry or the
legacy updatedAt window. It resolves the earliest usable recorded
`refunded` transition and filters by that date before historical purchase
lookups. Reordered or repeated status entries therefore do not move the
completed refund. Rows without a usable refund transition retain the old
updatedAt fallback; their missing history is not reconstructed or claimed
stable. This does not add on-chain verification or change refund authority.

Seller/prompt scope, current refunded status, inclusive period boundaries,
refund amounts, fees, clawback classification, and the existing 100-pair
purchase lookup batches are retained. The separate CSV text protection and
wallet-state isolation changes remain. The existing use of current stored
Prompt.price for gross amounts is unchanged; this repair does not supply
missing historical purchase prices.

## Focused integration reproduction

`server/scripts/checkPayoutRefundPeriod.cjs` compiles only the complete
service, its existing constants and four model modules, then executes both
the preceding and repaired services against a unique disposable loopback
MongoDB database. It removes only its own database and temporary files.
Install the server's existing mongoose and typescript dependencies first.

```bash
git show 668d0a50cf921537ce1ad78311b6432b8e8c3a9c:server/src/services/payoutStatementService.ts > /tmp/ph277-payout-before.ts
PAYOUT_REFUND_BEFORE=/tmp/ph277-payout-before.ts \
  PAYOUT_REFUND_MONGO_URI=mongodb://127.0.0.1:27017 \
  node server/scripts/checkPayoutRefundPeriod.cjs
```

Fifteen controlled comparisons cover the original and later months,
ordinary/legacy records, repeated/reordered transitions, inclusive
boundaries, current-status filtering, 101-refund batching, and an actual
Mongoose metadata/status update. The script prints both source blob hashes,
runtime/database versions, observed refund counts and model-query counts.
It also checks full control statements after normalizing only their
generated ID, generation timestamp and signature. This is not a full app
build, HTTP authorization test, blockchain settlement, or payment receipt.

Completed validation: https://github.com/woahwhattheheck/prompt-hash/actions/runs/37193205919

Preceding source: `668d0a50cf921537ce1ad78311b6432b8e8c3a9c`. The single focused job passed all 15 comparisons on a disposable MongoDB 7.0.14 service. No full repository suite was run.
