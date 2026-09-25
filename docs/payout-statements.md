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

## Tests

```bash
cd server && npm test -- --testPathPattern=payoutStatement
```

Frontend:

```bash
npx vitest run src/components/profile/PayoutStatementsCard.test.tsx
```
