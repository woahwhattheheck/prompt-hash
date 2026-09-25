# API adapter consolidation (#184)

Prompt Hash serves overlapping domain capabilities from two deployment
adapters:

| Capability | Serverless (Vercel `api/`) | Express (`server/src`) |
| --- | --- | --- |
| Buyer version / publish version | `GET/POST /api/prompts/version` | `GET /api/versions/buyer-version`, `POST /api/versions/update`, … |
| Webhook CRUD | `GET/POST/DELETE /api/webhooks` | `GET/POST/DELETE /api/webhooks` |

Before #184 these adapters duplicated validation, auth, and entitlement
checks. Security fixes could land in one path while production kept serving
the other.

## Authoritative services

| Capability | Shared module |
| --- | --- |
| Prompt versioning | `src/lib/domain/promptVersioningDomain.ts` |
| Webhooks | `src/lib/domain/webhookDomain.ts` |
| Admin / signed-owner auth | `src/lib/domain/adapterAuth.ts` |
| HTTP result shape | `src/lib/domain/domainResult.ts` |

Adapters (`api/prompts/version.ts`, `api/webhooks/index.ts`,
`server/src/controllers/versioningControllers.ts`,
`server/src/controllers/webhookControllers.ts`) are **thin HTTP shims**:
parse request → call domain → `sendDomainResult`.

`server/src/utils/challengeSignature.ts` re-exports
`verifyChallengeSignature` from `src/lib/auth/challenge` so signature
verification cannot fork.

## Authoritative security choices

- **Buyer version requires a purchase record.** Silent fallback to v1 content
  without entitlement (previous serverless behavior) is removed.
- **Webhook mutations** require admin bearer token (`ADMIN_ROTATION_TOKEN`) or
  a signed ownership proof over `prompt-hash webhooks:{addr}:{timestamp}`.
- **Webhook destinations** pass the shared SSRF check
  (`validateWebhookUrl`) before persistence.

## Supported dual mounts (not deprecated)

These path aliases remain supported and **must** share domain logic:

- `GET/POST /api/prompts/version` ↔ `GET /api/versions/buyer-version` +
  `POST /api/versions/update`
- `GET/POST/DELETE /api/webhooks` (both adapters)

Express-only helpers that also use the domain:

- `GET /api/versions/:promptId/history`
- `POST /api/versions/purchase`

## Deprecated / forbidden

**Deprecated:** any new route that reimplements versioning or webhook
validation/auth inline inside an adapter.

**Forbidden in CI:** the drift guard
(`scripts/guard-api-domain-drift.mjs`, `npm run guard:api-domain-drift`) fails
when adapters:

- stop importing the shared domain modules, or
- redefine `isAdminRequest` / signed-owner helpers, or
- call mongoose models / `publishPromptVersion` / `validateWebhookUrl`
  directly, or
- reintroduce a forked challenge verifier under
  `server/src/utils/challengeSignature.ts`

Silently deploying a duplicate handler that bypasses the domain layer is not
allowed.

## Migration

1. Keep calling the dual-mounted URLs you already use — response contracts are
   unified through the domain layer.
2. Point any custom fork of buyer-version or webhook logic at
   `src/lib/domain/*` instead of copying adapter code.
3. Add new capabilities as domain functions first, then add thin adapters.

## Tests

```bash
npm run test:api-domain-contract
npm run guard:api-domain-drift
```

Cross-adapter fixtures cover purchase entitlement, publish ownership,
idempotent purchase recording, webhook auth/SSRF, and auth/error parity.

## Non-goals

Hosting-platform migration and unrelated frontend rewrites are out of scope.
