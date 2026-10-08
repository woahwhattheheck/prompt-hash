# Reconciliation API service authorization

The settlement reconciliation routes at `/api/reconciliation` are privileged
operations. A user's signed wallet session does **not** authorize a service to
read purchase, delivery and webhook audit reports or change reconciliation
results. Never expose backend bearer values in browser configuration.

This service reuses the existing constant-time `serviceBearer` middleware,
with two independent environment credentials:

- `RECONCILIATION_SERVICE_TOKEN`: permits `POST /run`, `GET /reports`
  and `GET /reports/:reportId`. The request may choose an explicit boolean
  `isDryRun` (default `true`); the audit creator is derived on the server.
- `RECONCILIATION_APPROVER_TOKEN`: permits only
  `POST /repair/:reportId`. It cannot read reports or run reconciliation.
  Repair audit attribution comes from the authenticated server role, not the
  request body.

Provision **different server-only, high-entropy token strings of at least 32
UTF-8 bytes**. The service refuses requests with HTTP 503 while a relevant
credential is missing or too short, 401 when no Bearer credential is supplied,
and 403 when a different role or an invalid bearer is presented. These values
are distinct from `FULFILLMENT_SERVICE_TOKEN`,
`REPORT_ADMIN_TOKEN` and end-user wallet sessions. Rotate them through normal
server secret management. The middleware sets `Cache-Control: no-store`.

**Report signatures require one more distinct server-side secret**:
`RECONCILIATION_SECRET` must be provisioned with at least 32 UTF-8 bytes.
There is no embedded signing key, empty-string fallback, or weak sample key in
production. If a deployment omits this value, generating the reconciliation
report fails closed instead of producing a forgeable HMAC signature. The key is
resolved at signing time, so deployment-level key rotation takes effect without
rebuilding the server. Operators must retain authorized key-rotation evidence
for older signatures rather than treating them as newly signed under a new key.
Never send the signing secret to the browser or reuse either bearer token as
an HMAC key. Focused key handling cases:
`server/src/services/reconciliationSigning.test.ts`.

Reconciliation `POST /run` can write a report even in dry-run mode and may
perform operational scans. Treat it as a backend-only action. The separate
approval credential is needed for repair, and approval does not guarantee
ledger settlement; verify actual on-chain outcome independently. The
service's existing report-status and audit-log behavior is otherwise unchanged.

Focused offline route cases: `server/src/routes/reconciliationAuth.test.ts`.
No live payments, actual provider credentials, or admin browser sessions are
used by those fixtures.
