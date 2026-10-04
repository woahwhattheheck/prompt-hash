# Similarity publish gate

Issue: [#242](https://github.com/Prompt-Hash-Stellar/prompt-hash/issues/242)

## Purpose

The current `/sell` form checks the draft against indexed prompts and maps the similarity score to a **pre-submission decision**. These are form decisions; the persistence and live-submission limits below are part of the current workflow:

| Score | Detection flag | Decision | Behavior |
| --- | --- | --- | --- |
| `< 0.70` | `clean` | **allow** | The form can continue to the listing helper |
| `0.70 ≤ score < 0.90` | `suspicious` | **review** | First submission stops for acknowledgment; an acknowledged review can continue to the same listing helper |
| `≥ 0.90` | `highly_similar` | **block** | This form stops and disables submission for the current blocked result |

## API

- `POST /api/fingerprint/publish-check` — body `{ title, content, excludeOnChainId? }` → `{ decision, score, similarTo, flag, feedback }`
- `POST /api/fingerprint/scan` — administrator-only rescan of an existing indexed prompt; body `{ promptId, text }` requires non-empty strings. This endpoint persists moderation evidence.
- `POST /api/fingerprint/override` — authenticated maintainer override; body `{ promptId, newDecision, reason, appealId? }`, response `{ override, result, replayed, appealSync? }`
- Appeals remain on `/api/appeals*` for creator false-positive requests

## Creator feedback

`feedback` includes a title, summary, and concrete actions (rewrite guidance, appeal path). The sell form renders this via `SimilarityPublishFeedback`.

## Current publication and privacy boundary

The form sends the title and **full prompt text** as JSON to `/api/fingerprint/publish-check` before calling `encryptPromptPlaintext`. The backend receives readable draft text for comparison. HTTPS can protect transport, but the similarity request is not encrypted with the prompt's content key and the full prompt does not remain solely in the browser. Use this flow only with a backend trusted to receive that draft.

The publish-check endpoint reads indexed candidates and returns the calculated decision and feedback. It does not persist a pending listing or review hold. After an acknowledged `review`, the form encrypts the draft and calls the same `createPrompt` helper used for `allow`, without passing a review decision, approval or hold marker. Existing feedback saying a listing is held or sent to review describes intended moderation behavior; that durable hold is not implemented by this path.

The current `PromptHashClient.createPrompt` is still a stub returning `{ success: true, txHash: "tx_mock", promptId: "123" }`. It does not invoke the supplied wallet signer or submit a contract transaction. A form success message is therefore not evidence of on-chain publication on this branch.

The authenticated override below updates an **existing indexed Prompt** and its audit. A later new-draft publish-check recomputes similarity from candidate text; it does not consume that override as an admission decision for the draft. Persisted review enforcement, binding a pending draft to a maintainer decision, and live contract submission remain integration work. The existing override authorization and audit guarantees remain separate.

## Stored scan authorization

The stored-prompt scan endpoint also requires a verified bearer principal with the `admin` role, bound to audience `prompt-hash:similarity-scan`. Authorization runs before input validation or storage access. Missing, invalid or incorrectly scoped credentials return 401; a verified principal without the required role receives 403. Request-body identities and roles cannot authorize the scan. A similarity-override credential is intentionally scoped to its own operation and cannot authorize a rescan.

This closes an alternate write path: anonymous callers could previously submit arbitrary text to `/api/fingerprint/scan` and overwrite an indexed prompt's similarity score and flag despite the protected override route. Trusted internal indexer calls keep using the existing service directly. The creator's public `/api/fingerprint/publish-check` remains read-only and requires no administrator credential. Provision scan credentials server-side through the existing principal issuer; never place the signing secret or an administrator credential in the public creator client.

### Stored scan authorization validation (2026-10-04)

The selected regression against parent `447f6069a5b0682784a61e1a1285304cdbaf0486` returned HTTP 200 for missing credentials, failing the expected 401. After the handler repair, the ten stored-scan cases and one existing audited-override control passed: **11 passed, 36 unselected**, with 89 ms reported for the tests (770 ms for the Vitest process). No unselected case was executed or counted as passing.

This execution used Node 24.19.0, Vitest 4.1.10, Express 5.2.1, Supertest 7.2.2, and Mongoose 9.9.2. It exercised the actual registered router, signed-principal verifier, moderation service and Mongoose query casting. Only the MongoDB collection boundary used the existing in-memory adapter. Missing or invalid credentials, wrong audience, and insufficient role caused no candidate read or prompt write; the scoped administrator persisted the real service result. Malformed input caused no storage access, and public draft comparison remained available without a credential and did not write. This does not establish live MongoDB, indexer deployment, wallet or contract behavior, or performance beyond this local execution.

Reproduce the focused selection with the existing installed dependencies:

```bash
node node_modules/vitest/vitest.mjs run --config vitest.similarity.config.mjs src/test/similarityOverride.test.ts -t 'authenticated stored similarity scan|uses the exact verified subject' --reporter=dot
```

## Override audit

The override route requires `Authorization: Bearer <credential>` verified by the existing shared `server/src/auth/adminPrincipal.ts` implementation from [PR #264](https://github.com/Prompt-Hash-Stellar/prompt-hash/pull/264). This contribution reuses that file unchanged. The existing `admin` role is required, with audience `prompt-hash:similarity-override`. A `report_reviewer` credential alone cannot override a decision. Credentials use the existing operator-managed `ADMIN_PRINCIPAL_SECRET` and revocation mechanism; this endpoint does not issue credentials or grant roles. Missing, malformed, expired, revoked, incorrectly signed, or incorrectly scoped credentials fail before prompt/appeal lookup. Authentication failures return 401; an authenticated principal without the role receives 403.

`actorAddress` in the audit is the exact verified principal subject, including case. The route ignores caller-supplied actor, roles, score, similar prompt, previous decision, and version. It derives the decision evidence from the stored prompt. A missing prompt returns 404; absent scan evidence or a concurrent state change returns 409. A supplied appeal must exist and refer to the same prompt before any decision write.

Each decision change appends an audit record to `Prompt.similarityOverrides` in the **same conditional document update** that changes the flag and advances `similarityDecisionVersion`. Existing records are retained. New prompts start at version 1; an older document without the field is guarded as missing and receives its first stored override version without a separate migration. When an appeal already has a higher version, the new version advances beyond both stored counters. The audit includes verified actor, stored prior decision/score/source, requested new decision/reason, timestamp, and version. Caller-provided actor, score, source, prior decision, timestamp, or version never replaces these verified or stored values. Mongoose validates the update, including audit evidence, before writing.

The update also guards the observed score, source, flag, scan timestamp, scan job/status, and document timestamp. This matters because scans do not currently advance the override counter: a scan that completes between the read and write must produce a conflict instead of being silently overwritten. Reload the current evidence before making a new decision after a 409.

### Optional appeal copy

The required audit lives on the Prompt even when no `appealId` is supplied. If one is supplied, the route also attempts the existing `Appeal.previousDecisions`/status update, using the recorded appeal version and timestamp as preconditions. This is a secondary copy, not a cross-document transaction. It does not require a new MongoDB replica-set topology.

A successful HTTP response means the Prompt decision and its audit are committed. Inspect `appealSync.status` separately:

| Status | Meaning and next step |
| --- | --- |
| `synced` | The corresponding audit was copied to the matching appeal, or an exact copy was already present. |
| `pending` | The appeal write/read failed. The Prompt decision and audit remain committed. The same authorized principal can retry the same prompt, decision, trimmed reason, and appeal id to repair the copy. No background retry is scheduled. |
| `conflict` | The appeal changed or disappeared before its guarded update. The route preserves that newer appeal state. Review the current appeal and the stored Prompt audit; blindly retrying does not overwrite the intervening review. |

An exact replay of the latest stored override returns `replayed: true` and can retry only the appeal copy, without another Prompt decision update or audit append. A different actor, reason, or intervening scan cannot use that replay. The stored appeal preconditions are retained in the required audit for recovery. This route does not change the authority or behavior of other appeal endpoints.

### Appeal status history

The existing appeal status handler keeps the `reviewerDecisions` history append beside the status/timestamp `$set` in one database update. A new review retains earlier entries and appends the server-timestamped decision with `$push`. This history is separate from the authenticated Prompt override audit above; the endpoint's existing authority and the on-chain listing boundary are unchanged.

The focused regression runs the real Appeal schema, query casting and update validators, replacing only the collection call with an adapter that applies the resulting operators. On the original handler, Mongoose 9.9.2 rejected the nested operator with `Invalid update: Unexpected modifier "$push" as a key in operator "$set"`, which the controller returned as a 500 error. The repaired handler returned the reviewed record with both the previous and newly appended entries in one update. The `updateAppealStatus` selection passed three cases, with six unrelated cases skipped, in 663 ms on Node 24.19.0/Vitest 5.0.1.

The local cached Mongoose client was 9.9.2, within the declared `^9.5.0` range; `server/package-lock.json` pins 9.5.0, which was not rerun. Dependency files are unchanged. This checks controller and Mongoose behavior with a collection adapter, not a live MongoDB write or HTTP deployment.

## Scoring cost

Each scan now prepares the unchanged draft once and reuses its term-frequency vector across candidates. The vector is built lazily: when either normalized text is shorter than 50 characters, the existing Levenshtein calculation is still used. Candidate normalization, Unicode tokenization, cosine arithmetic, thresholds and first-match tie selection are unchanged. The cache belongs to one scan and is never shared between requests.

A local measurement on Node 24.19.0/Linux compared the complete production evaluator before and after this change, using 1,000 in-memory candidates cycling the existing marketing-email, bedtime-story, Russian and Arabic sample texts. The longer draft repeats the existing 138-character marketing sample 24 times with spaces. After five warmups per version, seven alternating pairs each measured three evaluations; the table reports median milliseconds per evaluation.

| Draft | Characters | Before | After | Ratio |
| --- | --- | --- | --- | --- |
| Marketing sample | 138 | 7.70 ms | 4.71 ms | 1.64× |
| Repeated marketing sample | 3,335 | 57.18 ms | 4.61 ms | 12.41× |

The long-draft baseline included one 209.95 ms sample; the reported value is the seven-sample median. Complete evaluation results remained identical for the measured workloads and for short text, Unicode, combining marks, an empty candidate set, allow/review decisions and first-match ties. The existing focused selection `evaluatePublishSimilarity|scanForSimilarity|computeSimilarityScore` passed 15 maintained cases on Vitest 5.0.1. Its scan cases use the existing mocked model boundary; this is not a live database result.

These are deterministic scaled sample workloads, not a deployed catalog or an end-to-end request benchmark. Candidate retrieval still loads the existing collection, and database/network time and remaining publication integration work are unchanged.

## Code map

- `server/src/services/similarityDetection.ts` — thresholds, decide/feedback/override
- `server/src/controllers/fingerprintController.ts` — publish-check + authenticated override handlers
- `server/src/services/similarityOverride.ts` — stored decision binding, atomic required audit, guarded appeal copy
- `server/src/models/Prompt.ts` — typed override audit and decision version
- `src/pages/sell/CreatePromptForm.tsx` — pre-submit gate
- `src/test/similarityDetection.test.ts` — allow / review / block / override algorithm coverage
- `src/test/similarityOverride.test.ts` — actual Express route, authentication, Mongoose update validation, races, and recovery

## Tests

Install the repository's root test dependencies and existing server dependencies (`npm ci` at the root and `npm ci --prefix server`), then run:

```bash
npm run test:similarity -- --maxWorkers=1 --no-file-parallelism
```

The focused suite contains similarity algorithm and override regressions, including the exact-expiry and immediately-before-expiry cases. The override tests execute the actual Express router, shared principal verifier, service, and Mongoose query casting/update validators. Only the MongoDB collection boundary is replaced with a deterministic adapter that applies guarded writes. This verifies request behavior and failure handling; it is not a claim of native MongoDB durability, replica-set transaction behavior, or a hosted deployment. No live database, wallet, or administrator credentials are needed for these tests.
