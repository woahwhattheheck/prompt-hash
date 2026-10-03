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

It passes 80 tests: the 54 existing cases plus 23 period-rejection regressions
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
