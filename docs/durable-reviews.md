# Durable reviews (#179)

Review submission, reports, and moderation no longer use a process-local seeded `Map`. Persistence goes through a durable repository so data survives restart and stays consistent across replicas.

## Backends

| Backend | When | Notes |
|---------|------|--------|
| Mongo (`Review` model) | `MONGODB_URI` set | Unique index on `(promptId, userAddress)`; atomic report/moderate updates |
| File store | otherwise / tests | JSON file at `REVIEW_STORE_PATH` (default: OS temp `prompt-hash-reviews/reviews.json`); path lock + atomic rename |

## Guarantees

- **Durability:** reviews reload after process restart.
- **Uniqueness:** concurrent duplicate `(promptId, wallet)` submits create **exactly one** review (`DuplicateReviewError` / HTTP 409 / Mongo `E11000`).
- **Atomic transitions:** report appends only if the reporter is new; moderation applies in one update.
- **No production seed:** fictional `review_1`…`review_3` rows are never inserted on boot. Migration `003_durable_reviews_remove_seeds.ts` deletes leftovers and backfills `status` / `reports` / `reviewId`.

## Public API

`api/reviews/{submit,list,report,moderate}` await the repository. Public list excludes `hidden` and strips report payloads.

## Env

| Variable | Default | Meaning |
|----------|---------|---------|
| `MONGODB_URI` | unset | Prefer Mongo repository when set |
| `REVIEW_STORE_PATH` | temp dir | File-store path when Mongo is unset |

## Migration

```bash
MONGODB_URI=... npx ts-node server/src/db/migrations/003_durable_reviews_remove_seeds.ts
```

## Non-goals

Reputation weighting changes.
