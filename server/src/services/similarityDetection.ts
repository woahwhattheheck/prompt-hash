/**
 * Anti-Plagiarism / Similarity Detection Service (Issue #133)
 *
 * Detects when a newly indexed prompt is too similar to existing ones.
 * Uses TF-IDF cosine similarity for general content and Levenshtein ratio
 * for very short texts (< 50 chars).
 *
 * Thresholds:
 *   score >= 0.90  → "highly_similar" (flag for moderation)
 *   score >= 0.70  → "suspicious"
 *   score <  0.70  → "clean"
 */

import Prompt from "../models/Prompt";

// ---------------------------------------------------------------------------
// Text preprocessing
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function buildTermFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  // Normalize by document length
  for (const [term, count] of tf) {
    tf.set(term, count / tokens.length);
  }
  return tf;
}

// ---------------------------------------------------------------------------
// Cosine similarity on TF vectors
// ---------------------------------------------------------------------------

export function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const [term, tfA] of a) {
    normA += tfA * tfA;
    const tfB = b.get(term) ?? 0;
    dot += tfA * tfB;
  }
  for (const [, tfB] of b) {
    normB += tfB * tfB;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Levenshtein distance (for short texts)
// ---------------------------------------------------------------------------

export function levenshteinRatio(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  const distance = dp[m][n];
  const maxLen = Math.max(m, n);
  return maxLen === 0 ? 1 : 1 - distance / maxLen;
}

// ---------------------------------------------------------------------------
// Score computation
// ---------------------------------------------------------------------------

export function computeSimilarityScore(textA: string, textB: string): number {
  const norm = (s: string) => s.toLowerCase().trim();
  const a = norm(textA);
  const b = norm(textB);

  if (a.length < 50 || b.length < 50) {
    return levenshteinRatio(a, b);
  }

  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  const tfA = buildTermFrequency(tokensA);
  const tfB = buildTermFrequency(tokensB);
  return cosineSimilarity(tfA, tfB);
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export const SIMILARITY_THRESHOLDS = {
  HIGHLY_SIMILAR: 0.9,
  SUSPICIOUS: 0.7,
} as const;

export type SimilarityFlag = "clean" | "suspicious" | "highly_similar";

export function classifyScore(score: number): SimilarityFlag {
  if (score >= SIMILARITY_THRESHOLDS.HIGHLY_SIMILAR) return "highly_similar";
  if (score >= SIMILARITY_THRESHOLDS.SUSPICIOUS) return "suspicious";
  return "clean";
}

// ---------------------------------------------------------------------------
// Main scan function: called after a new prompt is indexed
// ---------------------------------------------------------------------------

export interface SimilarityResult {
  flag: SimilarityFlag;
  score: number;
  similarTo: string | null;
}

/**
 * LEGACY: Scan synchronously (blocking, O(n) plaintext reads, quadratic growth)
 * Kept for backward compatibility and testing.
 * NEW CODE should use enqueueSimilarityScan() for queue-based processing.
 *
 * @param onChainId  The on-chain ID of the newly created prompt.
 * @param content    The prompt text to compare (title + body combined).
 * @deprecated Use enqueueSimilarityScan() instead for non-blocking queue processing
 */
export async function scanForSimilaritySync(
  onChainId: string,
  content: string,
): Promise<SimilarityResult> {
  const existing = await Prompt.find(
    { onChainId: { $ne: onChainId } },
    { onChainId: 1, content: 1, title: 1 },
  ).lean();

  let maxScore = 0;
  let mostSimilarId: string | null = null;

  for (const prompt of existing) {
    const candidateText = `${prompt.title ?? ""} ${prompt.content ?? ""}`;
    const score = computeSimilarityScore(content, candidateText);
    if (score > maxScore) {
      maxScore = score;
      mostSimilarId = prompt.onChainId ?? null;
    }
  }

  const flag = classifyScore(maxScore);

  await Prompt.findOneAndUpdate(
    { onChainId },
    {
      $set: {
        similarityFlag: flag,
        similarityScore: maxScore,
        similarTo: flag !== "clean" ? mostSimilarId : null,
        similarityCheckedAt: new Date(),
      },
    },
  );

  if (flag !== "clean") {
    console.warn(
      `[similarity] Prompt ${onChainId} flagged as "${flag}" ` +
        `(score=${maxScore.toFixed(3)}, similar to ${mostSimilarId})`,
    );
  }

  return { flag, score: maxScore, similarTo: flag !== "clean" ? mostSimilarId : null };
}

/**
 * NEW: Queue-based similarity scan (non-blocking, fingerprint-based, bounded)
 * Enqueues a retryable scan job for asynchronous processing.
 * Returns immediately; results are available via getJobStatus() or job polling.
 *
 * Benefits:
 * - Listing latency independent of total prompt count
 * - Fingerprints avoid plaintext in-memory concentration
 * - Deterministic results (reproducible for same algorithm/index version)
 * - Recoverable after crashes (persistent job state)
 * - Budget enforcement (candidates, memory, time limits)
 *
 * @param onChainId  The on-chain ID of the newly created prompt
 * @returns jobId for tracking scan progress
 */
export async function scanForSimilarity(
  onChainId: string,
  content?: string,
): Promise<SimilarityResult> {
  // Publish-time / test path: when plaintext is provided, run the synchronous
  // scan so callers (and the sell-page gate) get an immediate decision.
  if (typeof content === "string" && content.length > 0) {
    return scanForSimilaritySync(onChainId, content);
  }

  // Post-index path: enqueue a retryable fingerprint-based job (Issue #157).
  const { enqueueSimilarityScan } = await import("./similarityJobQueue.js");
  await enqueueSimilarityScan(onChainId);

  return {
    flag: "clean", // placeholder until the async scan completes
    score: 0,
    similarTo: null,
  };
}

// ---------------------------------------------------------------------------
// Publication decisions (Issue #242)
// Map detection flags → allow / review / block for the sell/publish gate.
// ---------------------------------------------------------------------------

export type PublicationDecision = "allow" | "review" | "block";

export const PUBLICATION_THRESHOLDS = {
  /** score >= BLOCK → block publication */
  BLOCK: SIMILARITY_THRESHOLDS.HIGHLY_SIMILAR,
  /** score >= REVIEW && < BLOCK → hold for review */
  REVIEW: SIMILARITY_THRESHOLDS.SUSPICIOUS,
} as const;

export function decidePublication(score: number): PublicationDecision {
  if (score >= PUBLICATION_THRESHOLDS.BLOCK) return "block";
  if (score >= PUBLICATION_THRESHOLDS.REVIEW) return "review";
  return "allow";
}

export function flagToDecision(flag: SimilarityFlag): PublicationDecision {
  switch (flag) {
    case "highly_similar":
      return "block";
    case "suspicious":
      return "review";
    default:
      return "allow";
  }
}

export interface CreatorFeedback {
  decision: PublicationDecision;
  title: string;
  summary: string;
  actions: string[];
  scorePercent: number;
  similarTo: string | null;
}

export function buildCreatorFeedback(
  decision: PublicationDecision,
  score: number,
  similarTo: string | null,
): CreatorFeedback {
  const scorePercent = Math.round(score * 100);
  const similarRef = similarTo ? `existing prompt #${similarTo}` : "an existing listing";

  if (decision === "block") {
    return {
      decision,
      title: "Publication blocked — high similarity detected",
      summary: `This draft is ~${scorePercent}% similar to ${similarRef}. High-risk duplicates cannot be published until the content is differentiated or a maintainer overrides the block.`,
      actions: [
        "Rewrite unique sections (instructions, examples, constraints) so the wording diverges from the matched listing.",
        "Avoid copying titles or boilerplate from popular prompts; keep structure if needed but change the substance.",
        "If this is a false positive, open an appeal from My Prompts — maintainers can override with an audited decision.",
      ],
      scorePercent,
      similarTo,
    };
  }

  if (decision === "review") {
    return {
      decision,
      title: "Sent to review — elevated similarity",
      summary: `This draft is ~${scorePercent}% similar to ${similarRef}. You can still submit, but the listing stays in review until a maintainer clears it.`,
      actions: [
        "Consider revising overlapping phrases before submitting to speed up review.",
        "Add a short note in your appeal/response explaining intentional similarity (e.g. shared template, co-authored series).",
        "Expect a delay before the listing appears as fully published.",
      ],
      scorePercent,
      similarTo,
    };
  }

  return {
    decision,
    title: "Similarity check passed",
    summary: "No high-risk overlap with existing listings. You can publish.",
    actions: [],
    scorePercent,
    similarTo: null,
  };
}

export interface PublishSimilarityResult extends SimilarityResult {
  decision: PublicationDecision;
  feedback: CreatorFeedback;
  overridden?: boolean;
}

/**
 * Pure evaluation against an in-memory candidate list (no DB).
 * Used by tests and by the publish-check endpoint after loading candidates.
 */
export function evaluatePublishSimilarity(
  content: string,
  candidates: Array<{ onChainId?: string | null; title?: string | null; content?: string | null }>,
): PublishSimilarityResult {
  let maxScore = 0;
  let mostSimilarId: string | null = null;

  for (const prompt of candidates) {
    const candidateText = `${prompt.title ?? ""} ${prompt.content ?? ""}`;
    const score = computeSimilarityScore(content, candidateText);
    if (score > maxScore) {
      maxScore = score;
      mostSimilarId = prompt.onChainId ?? null;
    }
  }

  const flag = classifyScore(maxScore);
  const decision = decidePublication(maxScore);
  const similarTo = decision === "allow" ? null : mostSimilarId;
  const feedback = buildCreatorFeedback(decision, maxScore, similarTo);

  return { flag, score: maxScore, similarTo, decision, feedback };
}

/**
 * Pre-publish gate: compare draft text to indexed prompts without requiring
 * an on-chain id yet. Optionally exclude a prompt (edits / republication).
 */
export async function checkPublishSimilarity(
  content: string,
  options: { excludeOnChainId?: string } = {},
): Promise<PublishSimilarityResult> {
  const filter =
    options.excludeOnChainId != null
      ? { onChainId: { $ne: options.excludeOnChainId } }
      : {};

  const existing = await Prompt.find(filter, {
    onChainId: 1,
    content: 1,
    title: 1,
  }).lean();

  return evaluatePublishSimilarity(content, existing);
}

// ---------------------------------------------------------------------------
// Maintainer override audit (Issue #242)
// ---------------------------------------------------------------------------

export interface SimilarityOverrideRecord {
  actorAddress: string;
  previousDecision: PublicationDecision;
  newDecision: PublicationDecision;
  reason: string;
  score: number;
  similarTo: string | null;
  promptId: string;
  at: string; // ISO
  decisionVersion: number;
}

export function applyMaintainerOverride(params: {
  promptId: string;
  actorAddress: string;
  previousDecision: PublicationDecision;
  newDecision: PublicationDecision;
  reason: string;
  score: number;
  similarTo?: string | null;
  previousVersion?: number;
}): SimilarityOverrideRecord {
  const reason = params.reason?.trim();
  if (!reason) {
    throw new Error("Override reason is required");
  }
  if (!params.actorAddress?.trim()) {
    throw new Error("Override actorAddress is required");
  }
  if (params.previousDecision === params.newDecision) {
    throw new Error("Override must change the publication decision");
  }

  return {
    actorAddress: params.actorAddress.trim().toLowerCase(),
    previousDecision: params.previousDecision,
    newDecision: params.newDecision,
    reason,
    score: params.score,
    similarTo: params.similarTo ?? null,
    promptId: params.promptId,
    at: new Date().toISOString(),
    decisionVersion: (params.previousVersion ?? 1) + 1,
  };
}

/**
 * Apply an override to a scored result (e.g. after maintainer clears a block).
 * Returns a new PublishSimilarityResult with updated decision/feedback and
 * overridden=true. Does not mutate the input.
 */
export function withOverride(
  result: PublishSimilarityResult,
  override: SimilarityOverrideRecord,
): PublishSimilarityResult {
  const decision = override.newDecision;
  const flag: SimilarityFlag =
    decision === "block"
      ? "highly_similar"
      : decision === "review"
        ? "suspicious"
        : "clean";
  const similarTo = decision === "allow" ? null : result.similarTo;
  return {
    flag,
    score: result.score,
    similarTo,
    decision,
    feedback: buildCreatorFeedback(decision, result.score, similarTo),
    overridden: true,
  };
}
