# Seller notification cursors (#181)

In-app seller alerts are driven from **indexed contract events** with a
wallet-scoped durable cursor. Browser `localStorage` snapshots are no longer
the source of truth.

## Why

The previous path (`sellerNotifications.ts`) diffed listing snapshots stored in
`localStorage`. Clearing storage, switching devices, missing a poll, or seeing a
sales-count correction could lose or duplicate alerts.

## Model

| Piece                | Role                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------- |
| Indexed seller event | Append-only row for `PromptPurchased`, `PromptSaleStatusUpdated`, `PromptPriceUpdated`    |
| Event id             | `network:contract:ledger:tx:eventIndex:schema` (same scheme as `indexerPipeline.eventId`) |
| Notification id      | `notif:{eventId}` — stable across devices                                                 |
| Wallet cursor        | `cursorEventId`, `lastLedger`, `readIds[]` — durable, server-side                         |
| Reorg / correction   | Newer event with the same `logicalKey` (or `correctionOf`) supersedes the prior row       |

## API

`GET /api/seller-notifications?wallet=G…&advance=1`

Returns the deterministic feed for that wallet and optionally advances the cursor
to the tip of the reconciled log.

`POST /api/seller-notifications`

```json
{ "wallet": "G…", "action": "mark-read" | "mark-all-read" | "advance", "ids": ["notif:…"] }
```

## Backends

| Backend                                                        | When                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------- |
| Mongo (`SellerNotificationEvent` + `SellerNotificationCursor`) | `MONGODB_URI` set                                    |
| File store                                                     | otherwise / tests (`SELLER_NOTIFICATION_STORE_PATH`) |

The file store expects a JSON object with `events` and `cursors` dictionaries.
Missing or `null` sections retain their empty-dictionary defaults. Arrays and
other incompatible containers are rejected before reads or updates can silently
discard events or read state; the original file bytes remain intact. Restore a
compatible file to resume use, or explicitly clear the repository to reset it.

Read acknowledgements are additive until an explicit repository clear. A cursor
save retains IDs already stored, including acknowledgements completed by another
device after that cursor snapshot was read. Advancing a stale cursor therefore
keeps existing read state. Memory and file repositories merge IDs at the write
boundary; the file merge runs under its existing lock. Mongo uses
[`$addToSet` with `$each`](https://www.mongodb.com/docs/manual/reference/operator/update/addtoset/)
in the cursor update. Read IDs represent set membership; feed ordering and
cursor metadata retain their existing behavior.

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
events, reorg/correction, file-store restart, incompatible-file preservation,
recovery after restoring a compatible file, concurrent acknowledgements, and
stale cursor advances that preserve read state until an explicit clear.
