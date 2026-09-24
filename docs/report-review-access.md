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

### Revocation

- In-process denylist via `revokeAdminPrincipalToken(jti)`
- Boot-time seed: `ADMIN_PRINCIPAL_REVOKED_JTIS=jti-1,jti-2`

### Environment

| Variable | Purpose |
| --- | --- |
| `ADMIN_PRINCIPAL_SECRET` | HMAC secret (≥ 32 characters). Required in production. |
| `ADMIN_PRINCIPAL_REVOKED_JTIS` | Optional comma-separated revoked `jti` values |

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
