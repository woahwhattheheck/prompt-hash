# API adapter consolidation (#184)

Prompt Hash serves overlapping domain capabilities from two deployment
adapters:

| Capability                      | Serverless (Vercel `api/`)      | Express (`server/src`)                                            |
| ------------------------------- | ------------------------------- | ----------------------------------------------------------------- |
| Buyer version / publish version | `GET/POST /api/prompts/version` | `GET /api/versions/buyer-version`, `POST /api/versions/update`, … |
| Webhook CRUD                    | `GET/POST/DELETE /api/webhooks` | `GET/POST/DELETE /api/webhooks`                                   |

Before #184 these adapters duplicated validation, auth, and entitlement
checks. Security fixes could land in one path while production kept serving
the other.

## Authoritative services

| Capability                | Shared module                              |
| ------------------------- | ------------------------------------------ |
| Prompt versioning         | `src/lib/domain/promptVersioningDomain.ts` |
| Webhooks                  | `src/lib/domain/webhookDomain.ts`          |
| Admin / signed-owner auth | `src/lib/domain/adapterAuth.ts`            |
| HTTP result shape         | `src/lib/domain/domainResult.ts`           |

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
- **Webhook signing secrets** are generated on registration and rotated on
  update. The POST response returns the key saved for delivery signatures;
  clients updating a subscription must replace their stored key. GET responses
  exclude the secret.

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

## Signed ownership and Stellar key encoding

Webhook owners and signed-message addresses remain normalized to lowercase.
Stellar public keys must use canonical uppercase StrKey encoding when passed
to the signature verifier. The shared auth helper now converts only that
verification key; it preserves the existing
`prompt-hash webhooks:{lowercase-owner}:{timestamp}` message bytes, stored owner,
and returned normalized identity.

At source `e9b48b27d8977491cfb6cf9b349e56453bbf3dc8`, a real keypair's signature
verified with its canonical public key but failed after lowercasing that key.
The actual shared domain functions and HTTP dispatcher returned 401 for all
three signed-owner methods (GET, POST, DELETE), while admin controls returned
201/200/200. The existing signed-owner fixtures mocked the auth helper and
therefore did not exercise this key parsing.

The maintained contract fixtures now use real signatures for uppercase and
lowercase request addresses, verify normalized persistence and GET secret
exclusion, and cover wrong-key, tampered-message, missing-signature and
malformed-key rejection without subscription access or mutation.

Native validation uses retained Stellar SDK 12.3.0 / stellar-base 12.1.1 on
Node 24.19.0 without installation or network calls. The source requirement is
also confirmed in pinned upstream dependencies: [SDK 14.6.1 reexports
stellar-base](https://github.com/stellar/js-stellar-sdk/blob/v14.6.1/src/index.ts),
[its package declares base ^14.1.0](https://github.com/stellar/js-stellar-sdk/blob/v14.6.1/package.json),
and [base 14.1.0 rejects noncanonical StrKey encoding](https://github.com/stellar/js-stellar-base/blob/v14.1.0/src/strkey.js).
This is retained-runtime execution plus pinned-source confirmation; an exact
SDK 14.6.1 runtime was not installed or executed for this follow-through.

## Tests

```bash
npm run test:api-domain-contract
npm run guard:api-domain-drift
```

Cross-adapter fixtures cover purchase entitlement, publish ownership,
idempotent purchase recording, webhook auth/SSRF, persisted signing-secret
rotation, and auth/error parity.

### Canonical-key follow-through results

- The configured API-domain selection passes **19 tests**, including six new
  real-signature cases. The four success cases cover both adapter paths and
  uppercase/lowercase request addresses; the two rejection cases exercise all
  three methods with wrong-key, tampered, missing and malformed proofs.
- The corrected native domain/dispatcher flow returns GET 200, POST 201 and
  DELETE 200. Normalized identity and signed-message bytes are preserved;
  admin controls and invalid-signature rejection remain intact.
- Strict TypeScript 6.0.3 checking of the production and maintained-test import
  graph passes with dependency declaration checking skipped (`skipLibCheck`).
- Scoped ESLint 10.8.1 reports zero errors and two existing warnings for the
  unused `_s` secret-omission binding. The drift guard passes.
- Prettier 3.8.1 formats the three changed files. The test runtime uses Vitest
  4.1.10 and Vite 8.3.2; retained Node definitions are 25.3.0. No package or
  lockfile changes or installations are part of this follow-through.

The new cases use actual auth and SDK signature verification with in-memory
subscription and URL-validation dependencies. They do not exercise deployed
HTTP adapters, MongoDB, destination DNS checks, browser wallets or chain RPC.
The full frontend/server suites, application builds and prior adapter smoke
checks were not repeated for this narrow change. Earlier validation at the
signing-secret repair recorded unrelated frontend parse/LRUCache and server
ESM/rootDir failures; these are not claimed as fresh results for this change.

## Non-goals

Hosting-platform migration and unrelated frontend rewrites are out of scope.
