import { createHash } from "crypto";
import PublicationReview from "../models/PublicationReview";
import {
  buildCreatorFeedback,
  checkPublishSimilarity,
  type PublicationDecision,
  type PublishSimilarityResult,
  type SimilarityFlag,
} from "./similarityDetection";

export class PublicationReviewError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "PublicationReviewError";
  }
}

export interface PublicationReviewResult extends PublishSimilarityResult {
  reviewId: string | null;
  persisted: boolean;
  initialDecision: Exclude<PublicationDecision, "allow"> | null;
  decisionVersion: number | null;
}

export function createPublicationCommitment(
  title: string,
  content: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([title, content]), "utf8")
    .digest("hex");
}

function flagForDecision(decision: PublicationDecision): SimilarityFlag {
  if (decision === "block") return "highly_similar";
  if (decision === "review") return "suspicious";
  return "clean";
}

function persistedResult(review: any): PublicationReviewResult {
  const decision = review.decision as PublicationDecision;
  const initialDecision =
    review.initialDecision as Exclude<PublicationDecision, "allow">;
  const overridden = decision !== initialDecision;
  const similarTo =
    decision === "allow" ? null : (review.similarTo ?? null);
  const feedback = buildCreatorFeedback(
    decision,
    review.score,
    similarTo,
  );

  if (overridden && decision === "allow") {
    feedback.title = "Maintainer override approved";
    feedback.summary =
      "A maintainer cleared this exact draft commitment for publication.";
    feedback.actions = [];
  }

  return {
    flag: flagForDecision(decision),
    score: review.score,
    similarTo,
    decision,
    feedback,
    overridden,
    reviewId: String(review._id),
    persisted: true,
    initialDecision,
    decisionVersion: review.decisionVersion,
  };
}

/**
 * One submission admission operation:
 * - exact already-reviewed drafts reuse their stored moderation decision;
 * - new drafts are scored exactly once;
 * - clean drafts remain ephemeral;
 * - review/block drafts persist only a commitment + moderation evidence.
 *
 * This never writes Prompt. Prompt remains an indexer-owned projection of
 * on-chain state.
 */
export async function requestPublicationReview(input: {
  creatorAddress?: unknown;
  title?: unknown;
  content?: unknown;
}): Promise<PublicationReviewResult> {
  const creatorAddress =
    typeof input.creatorAddress === "string"
      ? input.creatorAddress.trim()
      : "";
  const title = typeof input.title === "string" ? input.title : "";
  const content = typeof input.content === "string" ? input.content : "";
  const combined = `${title} ${content}`.trim();

  if (!creatorAddress || !combined) {
    throw new PublicationReviewError(
      400,
      "creatorAddress and title/content are required",
    );
  }

  const contentCommitment = createPublicationCommitment(title, content);
  const existing = await PublicationReview.findOne({
    creatorAddress,
    contentCommitment,
  }).lean();
  if (existing) return persistedResult(existing);

  const gate = await checkPublishSimilarity(combined);
  if (gate.decision === "allow") {
    return {
      ...gate,
      reviewId: null,
      persisted: false,
      initialDecision: null,
      decisionVersion: null,
    };
  }

  // Upsert makes repeated submit attempts idempotent and closes the race where
  // two tabs submit the same exact draft at once.
  const review = await PublicationReview.findOneAndUpdate(
    { creatorAddress, contentCommitment },
    {
      $setOnInsert: {
        creatorAddress,
        contentCommitment,
        initialDecision: gate.decision,
        decision: gate.decision,
        score: gate.score,
        similarTo: gate.similarTo,
        decisionVersion: 1,
        audits: [],
      },
    },
    {
      upsert: true,
      returnDocument: "after",
      setDefaultsOnInsert: true,
      runValidators: true,
    },
  ).lean();

  if (!review) {
    throw new PublicationReviewError(
      500,
      "Unable to persist publication review",
    );
  }
  return persistedResult(review);
}

export async function overridePublicationReview(
  reviewId: string,
  input: { newDecision?: unknown; reason?: unknown },
  verifiedActor: string,
): Promise<PublicationReviewResult & { override: Record<string, unknown> }> {
  if (!/^[a-f\d]{24}$/i.test(reviewId)) {
    throw new PublicationReviewError(400, "Invalid publication review id");
  }

  const newDecision = input.newDecision;
  const reason =
    typeof input.reason === "string" ? input.reason.trim() : "";
  if (
    typeof newDecision !== "string" ||
    !["allow", "review", "block"].includes(newDecision) ||
    !reason
  ) {
    throw new PublicationReviewError(
      400,
      "newDecision (allow, review, block) and reason are required",
    );
  }
  if (!verifiedActor?.trim()) {
    throw new PublicationReviewError(400, "Verified actor is required");
  }

  const review = await PublicationReview.findById(reviewId).lean();
  if (!review) {
    throw new PublicationReviewError(404, "Publication review not found");
  }

  const currentDecision = review.decision as PublicationDecision;
  if (currentDecision === newDecision) {
    throw new PublicationReviewError(
      400,
      "Override must change the publication decision",
    );
  }

  const currentVersion = Number(review.decisionVersion);
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) {
    throw new PublicationReviewError(
      409,
      "Stored publication review version is invalid",
    );
  }

  const override = {
    actorAddress: verifiedActor,
    previousDecision: currentDecision,
    newDecision,
    reason,
    at: new Date(),
    decisionVersion: currentVersion + 1,
  };

  const updated = await PublicationReview.findOneAndUpdate(
    {
      _id: review._id,
      decision: currentDecision,
      decisionVersion: currentVersion,
    },
    {
      $set: {
        decision: newDecision,
        decisionVersion: currentVersion + 1,
      },
      $push: { audits: override },
    },
    { returnDocument: "after", runValidators: true },
  ).lean();

  if (!updated) {
    throw new PublicationReviewError(
      409,
      "Publication review changed; reload before overriding",
    );
  }

  return {
    ...persistedResult(updated),
    override,
  };
}
