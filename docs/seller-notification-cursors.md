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

## Wallet changes in the browser

The hook owns its local notifications and unread count by wallet address. A
wallet switch or disconnect hides the previous wallet's values immediately,
including the render before effects run. A feed waiting on the network carries
the address that started its request; a late result cannot be installed as
another wallet's local state. While the selected wallet has no matching feed,
the displayed notification list and unread badge are empty.

Mark-all-read and local dismiss operate on the selected wallet. Their existing
server acknowledgement and next-poll reconciliation behavior is retained.

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

The existing `sellerNotifications.test.ts` also mounts the hook to exercise a
wallet switch while the next feed is loading, a late response from the old
wallet, mark-all-read, dismiss and disconnect. Wallet, query and notification
client boundaries are controlled; React effects and rendering are real.

### Exact published hook execution

Published source `f962fa3afb71b5f2c5b5b67359abf4790b892c1e` passed all
seven cases in this file on a standard Ubuntu GitHub Actions runner. With the
same test file and the previous hook from
`1ecee476f69cb49b969ba57dafd595afc6fcf544`, the six helper cases passed and
the interaction case failed at the wallet-switch assertion. The candidate
passed seven cases with no failures or skips.

The job checked the Git blobs of the hook, test and four notification modules
against the published revision before execution, then confirmed that the final
files were unchanged. The hook blob is
`4eb9c946513cad5a550297afcf418ce2ab63843a`; the test blob is
`7c4ac138df20944078bea9c0f27cc121c21b018b`.

- [Execution and logs](https://github.com/woahwhattheheck/prompt-hash/actions/runs/37203591223)
- [Reports, dependency inventory and source hashes](https://github.com/woahwhattheheck/prompt-hash/actions/runs/37203591223/artifacts/11303742106)
- [Isolated execution configuration](https://github.com/woahwhattheheck/prompt-hash/tree/7e280dd7e64a75f2f22a22d2365cf1afaf5c6a12)

Runtime: Node 24.21.0, Vitest 4.1.10, Vite 8.1.5, React and React DOM 19.2.5,
Testing Library React 16.3.2 / DOM 10.4.1, and jsdom 29.1.1. The two child
commands took 890 ms for the previous hook and 744 ms for the published hook,
including test-runner startup. These timings describe this focused execution,
not application throughput.

Wallet, query and notification-client boundaries use the existing test mocks;
React rendering and effects are real. The resolver supplies module identities
for those mocks and throws if a mock factory is missing. This focused runtime
does not install the full application dependency graph. Current lint,
formatting, live-provider integration, live-wallet services and the complete
application build were not run.

The isolated execution closes the earlier local runner outage's final-source
validation gap. Workflow scaffolding remains on the separate execution branch;
the original contribution branch receives only this guide update.
