# Seller Payout Statements

Issue: [#245](https://github.com/Prompt-Hash-Stellar/prompt-hash/issues/245)

Creators can generate period payout statements that reconcile purchases,
platform fees, refunds (including post-payout clawbacks), and net settlement.
Statements export as CSV or JSON from the profile **Payout Settings** page.

## Fee source (do not invent rates)

Platform fees use the Prompt Hash contract default:

| Constant | Value | Source |
| --- | --- | --- |
| `DEFAULT_FEE_BPS` | `500` (5.00%) | `contracts/prompt-hash/src/contract.rs` |
| `MAX_BPS` | `10_000` | same file |

Server mirror: `server/src/constants/platformFee.ts`.

On-chain arithmetic (`bps_amount`):

```text
platformFeeStroops = floor(grossStroops * feeBps / 10_000)
```

All statement amounts are integers in **stroops** (1 XLM = 10_000_000 stroops).
Inputs and totals must remain within JavaScript's safe integer range. Carryover
may be negative; sale, refund, and payout-attempt amounts must be nonnegative.
JSON numeric strings, fractional amounts, nonfinite values, and totals outside
that range are rejected with HTTP 400 before a statement is signed or persisted.
Live-preview carryover is validated before database reads. JSON monetary fields
remain numbers, and CSV retains their exact integer text, including signed
carryover boundaries.

When aggregating from Mongo, `Prompt.price` (XLM) is converted with
`xlmToStroops` in the same constants module. Gross amounts come from stored
prompt prices / purchase events — never from invented USD figures.

Payout routing uses the seller’s existing `User.payoutSettings.payoutAddress`
(falling back to the creator wallet). This feature does **not** introduce new
crypto payout addresses.

## Reconciliation formula

For a statement period `[start, end]` (inclusive):

```text
grossStroops              = Σ purchase.grossStroops in period
platformFeeStroops        = Σ floor(gross * feeBps / 10_000)
refundSellerDebitStroops  = Σ (originalGross − fee) for refunds in period
previousBalanceCarryoverStroops = closing carry from prior statement (may be negative)

netSettlementStroops =
    grossStroops
  − platformFeeStroops
  − refundSellerDebitStroops
  + previousBalanceCarryoverStroops

payableStroops                    = max(netSettlementStroops, 0)
closingBalanceCarryoverStroops    = min(netSettlementStroops, 0)
```

### Period validation

Both period boundaries must be strings that `Date.parse` can resolve to finite
instants, with `start <= end`. Reconciliation validates the complete period
before filtering any events, including when purchases and refunds are empty.
Database aggregation applies the same check before reading seller or prompt
records. Invalid or reversed periods return HTTP 400 from generation and live
preview, without signing or persisting a statement.

Equal instants remain valid for the inclusive interval. Boundaries with timezone
offsets are ordered by their parsed instants, and date-only values retain their
existing UTC-midnight interpretation. The original boundary strings remain in
the signed statement and exports. A date-only end does not automatically expand
to the end of that day; the profile period picker performs its existing explicit
end-of-day conversion. This guard preserves the existing parser's accepted
formats and does not change per-event timestamp or prior-settlement handling.

### Same-period refund

A purchase and its refund both fall in the period. Seller debit equals the
original seller net (`gross − fee`), so the sale’s contribution to net is `0`.

### Refund after a settled payout (clawback)

If a refund’s `originalPurchasedAt` is at or before `priorSettledPeriodEnd`,
the refund is flagged `isClawback: true`. With no offsetting sales, net goes
negative and `closingBalanceCarryoverStroops` pushes the deficit into the next
period.

### Pending / failed / settled

Statement `status` is derived from `payoutAttempts`:

- no attempts → `pending`
- any `failed` → `failed` (with `failureReason`)
- else any `pending` → `pending`
- else → `settled`

Pending and failed attempts are first-class line items; they do not change the
gross / fee / refund / net identity above.

## API

Mounted at `/api/payouts` (see `server/src/routes/payoutRoutes.ts`).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/payouts/statements/:wallet` | List saved statements |
| `GET` | `/api/payouts/statements/:wallet?from=&to=` | Live period preview |
| `GET` | `/api/payouts/statements/:wallet/:id` | Single statement |
| `GET` | `/api/payouts/statements/:wallet/:id/export?format=csv\|json` | Download |
| `POST` | `/api/payouts/statements/generate` | Aggregate (+ optional persist) |
| `PATCH` | `/api/payouts/statements/:id/status` | Set `pending` / `settled` / `failed` |

## UI

`src/components/profile/PayoutStatementsCard.tsx` on
`src/pages/profile/PayoutSettingsPage.tsx` — period picker, preview, status
badges, CSV/JSON export.

The card formats admitted safe integer stroop amounts with integer quotient and
remainder, preserving all seven XLM decimal places without floating-point
division. For example, `9007199254740991` stroops displays as
`900719925.4740991 XLM`; negative carryover preserves the same exact magnitude.
Whole XLM amounts retain their integer presentation, while fractional values
retain seven decimal places. The existing handling of invalid numeric values is
unchanged; the server still rejects those values before statement generation.
JSON and CSV monetary fields remain integer stroops.

## Refund aggregation query budget

Historical purchases for refunds are loaded in batches of at most 100 distinct
`(promptId, buyerWallet)` pairs. This uses the existing unique compound purchase
index. Buyer wallets are lowercased as in the purchase schema; prompt ID case is
preserved. These historical lookups deliberately have no purchase-date bound,
so a refund can still claw back a sale from an earlier statement period. Missing
purchases retain the fulfillment record's fallback ID and date. Repeated refund
records remain separate line items in their original order.

For a seller with an owned prompt catalog, the aggregator makes four fixed model
queries plus `ceil(distinct refund pairs / 100)` historical purchase queries.
With no refunds, it makes no historical lookup. Previously it issued one serial
historical purchase query per refund record.

| Refund records / distinct pairs | Previous model calls | Batched model calls |
| --- | ---: | ---: |
| 0 / 0 | 4 | 4 |
| 100 / 100 | 104 | 5 |
| 101 / 101 | 105 | 6 |
| 1,000 / 1,000 | 1,004 | 14 |
| 5 / 4, mixed pair controls | 9 | 5 |

These counts were observed by running the complete preceding and updated
production aggregation, reconciliation, signing, and export code on Node
24.19.0 with recorded model boundaries. Holding clock and UUID metadata fixed
with a synthetic signing secret produced equal complete statements, signatures,
CSV, and JSON in every case. Mixed controls cover different buyers of one
prompt, prompt ID case, wallet case normalization, historical purchases, a
missing purchase, repeated refunds, and reversed batch-result order. This
replay measures model-call reduction, not live MongoDB latency. Five focused
regressions were added to the existing Jest file; that extended Jest suite was
not run for this batching continuation because its retained dependencies were
unavailable.

### Native MongoDB measurement (2026-10-04)

[Run 37190015734](https://github.com/woahwhattheheck/prompt-hash/actions/runs/37190015734)
compared baseline `a9c7d579` with published candidate `6b0b8f70`, using the
complete service and unchanged real Mongoose models against a disposable
MongoDB 7.0.14 service. The existing compound indexes remained enabled.
[The complete receipt, raw samples, source pins, and reproduction](https://github.com/woahwhattheheck/prompt-hash/blob/c69d346ab314cd8e7cab9d36c41546288371581e/work/validation/ph277-mongo/RESULTS.md)
are retained with the executed harness.

| Refund rows | All `find` commands, before → after | Median aggregation, before → after | Ratio of medians |
| --- | ---: | ---: | ---: |
| 100 | 104 → 5 | 74.36 ms → 10.63 ms | 7.00× |
| 1,000 | 1,004 → 14 | 535.70 ms → 58.44 ms | 9.17× |

Historical purchase lookups fell from 100 to 1 and from 1,000 to 10.
Both 1,000-row variants also issued two `getMore` commands; those cursor reads
are separate from the table's `find` counts. Mongo driver command monitoring
recorded the actual wire operations.

Each representative size used one untimed warmup per variant and three paired
measurements with alternating execution order. Complete statement objects,
real HMAC signatures, CSV, and JSON matched on every pair. Only UUID and
no-argument Date construction were controlled for generated metadata;
`Date.now`, monotonic timing, database operations, and model casting remained
real. Empty and mixed controls also preserved historical clawbacks, missing
purchases, prompt/wallet casing, and repeated refund rows.

The single public Ubuntu 24.04 job used Node 24.19.0, Mongoose 9.9.2, and
Vitest 4.1.10. It completed successfully in 38 seconds including setup; the
one native benchmark test passed. These warmed, synthetic measurements cover
the aggregation call in that environment, including reads and reconciliation.
They do not establish production latency or concurrent server throughput,
and do not replace the separately documented maintained Jest suite.

## Tests

```bash
cd server && npm test -- --testPathPatterns=payoutStatement
```

Frontend:

```bash
npx vitest run src/components/profile/PayoutStatementsCard.test.tsx
```

### Period boundary verification

The period-validation continuation was exercised through the actual Express
router, reconciliation, fee calculation, and signing code on Node 24.19.0 with
Express 5.2.1. Seventeen HTTP requests ran against the preceding source and the
repair. Mongo model boundaries were recorded stubs with an empty seller catalog;
the persistence call was observed, without writing to a live database.

| Requests                                                                                                                                                                                                        | Preceding behavior                        | Repaired behavior                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| Six invalid generation requests: empty invalid bounds, reversed bounds with a purchase, an invalid end hidden by an earlier purchase, a non-string bound, an invalid DB-backed period, and an out-of-range date | Signed HTTP 201; persistence called       | HTTP 400; no signature, model reads, or persistence              |
| Two invalid/reversed live previews                                                                                                                                                                              | Signed HTTP 200 after seller/prompt reads | HTTP 400 before model reads                                      |
| One invalid start with a purchase                                                                                                                                                                               | HTTP 500                                  | HTTP 400                                                         |
| Six valid controls: equal instants, equivalent offsets, date-only bounds, ordinary populated/empty periods, and ordered offsets                                                                                 | Signed HTTP 201                           | Same statuses, periods, sale counts, and 950/0-stroop net totals |
| Two existing required-field/carryover rejection controls                                                                                                                                                        | HTTP 400                                  | HTTP 400                                                         |

The finite-date and ordering guard does not depend on finding an event in the
period. These observations establish the mounted route behavior and the call
boundary before database access; they do not establish native Mongo persistence,
on-chain settlement, full-server startup, or a new frontend run. Package manifests
and lockfiles are unchanged.

The maintained backend command is:

```bash
cd server
npm test -- --testPathPatterns=payoutStatement --runInBand --no-cache
```

That period-validation run passed 80 tests: the 54 existing cases plus 23 period-rejection regressions
and three valid inclusive-boundary controls. Applying the same extended test file
to the preceding implementation produces 23 failures and 57 passes. Retained
Jest 30.2.0, ts-jest 29.4.12, and Supertest 7.2.2 were used; the existing model
mocks remain the database boundary.

ESLint 10.8.1 passes over the service, routes, and test file. The strict
TypeScript 6.0.3 check follows their imports and exits 2 with five TS2307
diagnostics because Mongoose is unavailable in the retained runtime. The same
production check on the exact preceding source yields identical diagnostics;
the final three-file check adds none. This is a dependency limitation, not a
claim of a complete type-check or repository build.


## Formula-like text in CSV exports

CSV export prefixes formula-like text with an apostrophe and quotes the complete
cell, including formula markers after leading whitespace and their full-width
variants. Text beginning with tab, carriage return or line feed is also marked.
Embedded delimiters, quotes and newlines remain RFC-style escaped. Monetary
columns remain numeric, including negative carryover and net settlement values.
This transformation applies only to the CSV presentation: stored statements,
JSON exports and signed data are unchanged. Consumers requiring exact original
text should use the JSON export.

The initial-import text marker is not a universal spreadsheet security guarantee.
Spreadsheet applications differ, and saving/reopening a CSV can remove escape
characters. See OWASP's [CSV Injection guidance](https://owasp.org/www-community/attacks/CSV_Injection).
The maintained tests exercise actual exporter bytes and the Express download
route with the existing model mock; they do not execute Excel or LibreOffice.
