# Report review access policy (#146)

## Problem

`GET /api/prompts/reports` previously treated any non-empty
`Authorization: Bearer …` value as authenticated and returned raw `Report`
documents (including reporter wallets and allegation text).

## Verified admin principal

Privileged callers present an HMAC-SHA256-signed admin principal token:

```
Authorization: Bearer <base64url(claims)>.<base64url(hmac)>
```

Claims (trusted only after signature verification):

| Claim | Meaning |
| --- | --- |
| `sub` | Actor id (operator id or wallet) — **only** source of actor identity |
| `roles` | Granted roles (`report_reviewer`, `admin`, …) |
| `jti` | Token id (revocation key) |
| `iat` / `exp` | Issued-at / expiry (ms since epoch) |
| `aud` | Audience binding (`prompt-hash:report-review` for this endpoint) |

### Roles

| Role | Can list/filter abuse reports? |
| --- | --- |
| `report_reviewer` | Yes |
| `admin` | Yes |
| any other | No → `403 forbidden` |

Random, expired, revoked, wrong-audience, or unsigned tokens → `401`.
The expiry instant is exclusive: credentials are valid only while `now < exp`.

### Revocation

- In-process denylist via `revokeAdminPrincipalToken(jti)`
- Boot-time seed: `ADMIN_PRINCIPAL_REVOKED_JTIS=jti-1,jti-2`

### Environment

| Variable | Purpose |
| --- | --- |
| `ADMIN_PRINCIPAL_SECRET` | HMAC secret (≥ 32 characters). Required by the HTTP report-review gate in every environment, including local development. |
| `ADMIN_PRINCIPAL_REVOKED_JTIS` | Optional comma-separated revoked `jti` values |

Configure the same `ADMIN_PRINCIPAL_SECRET` in the trusted token issuer and the
Express report server before minting or using reviewer credentials, including
during local development. The example below reads this environment variable, and
the [mounted report-review gate](../server/src/auth/reportReviewAuth.ts) uses it
without a `secret` override.

The [shared signer/verifier](../server/src/auth/adminPrincipal.ts) has no
development fallback: a missing secret or one shorter than 32 characters causes
`invalid_token`. When verification fails for this reason, the report service
returns `401` before querying reports. Lower-level signer/verifier calls may pass
an explicit `secret` option for isolated tests; that override does not configure
the HTTP server. Keep the signing secret in trusted server/operator environments
and send only the issued bearer token to the endpoint.

Minting (operators / tests only — not a public endpoint):

```ts
import { signAdminPrincipalToken, REPORT_REVIEWER_ROLE } from "../auth/adminPrincipal";
import { REPORT_REVIEW_AUDIENCE } from "../auth/reportReviewAuth";

const token = signAdminPrincipalToken({
  sub: "ops-reviewer-1",
  roles: [REPORT_REVIEWER_ROLE],
  aud: REPORT_REVIEW_AUDIENCE,
});
```

## Allowlisted response DTO

Authorized reviewers receive `{ reports: ReportReviewDto[] }` where each item
contains **only**:

`id`, `promptId`, `reporterAddress`, `reason`, `description`, `status`,
`adminNotes`, `resolvedAt`, `createdAt`, `updatedAt`.

- `reporterAddress` is included for triage (duplicate follow-up). Access is
  audited; the address is never returned to unauthenticated callers.
- Mongoose internals (`__v`, raw ObjectId) are never exposed.

## Access audit

Every allow or deny emits a structured `report_access_audit` log line with:

- hashed actor (`sha256(sub)` truncated), role, filters, result, request id
- **never** the bearer token or report bodies

## Non-goals

- Review-rating moderation
- Changing report reason enums
