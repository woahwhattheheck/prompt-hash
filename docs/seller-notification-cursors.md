# Seller notification cursors (#181)

In-app seller alerts are driven from **indexed contract events** with a
wallet-scoped durable cursor. Browser `localStorage` snapshots are no longer
the source of truth.

## Why

The previous path (`sellerNotifications.ts`) diffed listing snapshots stored in
`localStorage`. Clearing storage, switching devices, missing a poll, or seeing a
sales-count correction could lose or duplicate alerts.

## Model

| Piece | Role |
|-------|------|
| Indexed seller event | Append-only row for `PromptPurchased`, `PromptSaleStatusUpdated`, `PromptPriceUpdated` |
| Event id | `network:contract:ledger:tx:eventIndex:schema` (same scheme as `indexerPipeline.eventId`) |
| Notification id | `notif:{eventId}` — stable across devices |
| Wallet cursor | `cursorEventId`, `lastLedger`, `readIds[]` — durable, server-side |
| Reorg / correction | Newer event with the same `logicalKey` (or `correctionOf`) supersedes the prior row |

## API

`GET /api/seller-notifications?wallet=G…&advance=1`

Returns the deterministic feed for that wallet and optionally advances the cursor
to the tip of the reconciled log.

`POST /api/seller-notifications`

```json
{ "wallet": "G…", "action": "mark-read" | "mark-all-read" | "advance", "ids": ["notif:…"] }
```

## Backends

| Backend | When |
|---------|------|
| Mongo (`SellerNotificationEvent` + `SellerNotificationCursor`) | `MONGODB_URI` set |
| File store | otherwise / tests (`SELLER_NOTIFICATION_STORE_PATH`) |

## Guarantees

- Events are neither lost nor duplicated across devices and restarts.
- Backfill from a cursor (including `null` / wiped cursor) produces the same feed.
- Duplicate indexer delivery is idempotent on `eventId`.
- Email notification delivery is **unchanged** (out of scope).

## Ingest

`server/src/services/indexer.ts` calls `ingestSellerNotificationEvent` after
projecting seller-relevant topics. Failures are logged and do not block indexing.

## Tests

```bash
npm run test:seller-notif-cursors
```

Covers missed polls, storage clearing / cursor recovery, two devices, duplicate
events, reorg/correction, and file-store restart.
