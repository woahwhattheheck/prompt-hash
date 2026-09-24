# Similarity publish gate

Issue: [#242](https://github.com/Prompt-Hash-Stellar/prompt-hash/issues/242)

## Purpose

Before a creator submits a listing from `/sell`, the app checks the draft against indexed prompts and maps the similarity score to a **publication decision**:

| Score | Detection flag | Decision | Behavior |
| --- | --- | --- | --- |
| `< 0.70` | `clean` | **allow** | Publish proceeds |
| `0.70`–`0.89` | `suspicious` | **review** | Creator must acknowledge; listing is held for maintainer review |
| `≥ 0.90` | `highly_similar` | **block** | Submit disabled until the draft changes or a maintainer overrides |

## API

- `POST /api/fingerprint/publish-check` — body `{ title, content, excludeOnChainId? }` → `{ decision, score, similarTo, flag, feedback }`
- `POST /api/fingerprint/override` — maintainer override with audited `{ actorAddress, previousDecision, newDecision, reason, … }`
- Appeals remain on `/api/appeals*` for creator false-positive requests

## Creator feedback

`feedback` includes a title, summary, and concrete actions (rewrite guidance, appeal path). The sell form renders this via `SimilarityPublishFeedback`.

## Override audit

Overrides append an immutable record (actor, prior/new decision, reason, timestamp, version). Prior decisions are never deleted.

## Code map

- `server/src/services/similarityDetection.ts` — thresholds, decide/feedback/override
- `server/src/controllers/fingerprintController.ts` — publish-check + override handlers
- `src/pages/sell/CreatePromptForm.tsx` — pre-submit gate
- `src/test/similarityDetection.test.ts` — allow / review / block / override coverage

## Tests

```bash
npm run test:similarity
```
