# Payout-attempt status admission

Seller statement generation accepts only `pending`, `settled`, or `failed` for
every supplied payout attempt. Unknown, missing, null, differently cased and
non-string statuses raise `PayoutStatementStatusError`; generation returns HTTP
400 instead of signing or saving a statement that incorrectly says `settled`.
An invalid later attempt is rejected even when another row is failed or pending.

For valid input, existing precedence remains failed, then pending, then settled.
An empty attempt list remains pending. The first failure and pending transaction
and the last settled transaction retain their existing selection rules. Amounts,
fees, period parsing, refund aggregation and CSV/JSON representation are unchanged.

## Focused validation (2026-10-04)

The preceding source is `63c0a273f2c64c34a586693b5b92aca20d79fe98`, including the
period-parsing optimization. A local comparison executed the complete production
service and registered generation handler after TypeScript transpilation, with
real fee arithmetic and Node HMAC and recorded Router/model import boundaries.
Node 22.16.0 and TypeScript 5.8.3 produced 19 passing outcome groups:

- Seven invalid status values formerly produced a settled statement; each now
  raises the typed error. Three mixed-status cases reject invalid later rows.
- Four valid controls preserve complete signed statements, CSV and JSON exactly.
- Both supplied-event and recorded-model generation paths change from HTTP-like
  response 201, one signature and one persistence call to response 400, no
  signature and no persistence call. The model path still performs its existing
  two reads; this is not a claim of rejection before database access.
- All three valid generation statuses retain response 201 and one persistence call.

This execution used a Router registration adapter and model fixtures, not Express,
HTTP transport or MongoDB. It does not establish live settlement, full application
startup, a semantic typecheck or hosted CI. No dependencies were installed.

The maintained regression is `server/src/tests/payoutStatementStatus.test.ts`:

```sh
cd server
npm test -- --testPathPatterns=payoutStatementStatus --runInBand --no-cache
```

That Jest/Supertest selection was added but not executed in this environment.
It retains the actual Express route and the repository's existing model-mock
boundary. Existing payout suites and performance measurements were not rerun.
