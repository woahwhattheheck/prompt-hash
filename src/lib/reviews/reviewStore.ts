/**
 * Durable review storage & moderation (#179).
 *
 * Replaces the process-local seeded Map with a durable repository:
 * Mongo when MONGODB_URI is set, otherwise a file-backed store.
 * No production seed data. Concurrent duplicate submits create one review.
 */

import os from "os";
import path from "path";
import type { ReviewRepository } from "./reviewRepository";
import { createFileReviewRepository } from "./fileReviewRepository";
import { createMongoReviewRepository } from "./mongoReviewRepository";
import {
  DuplicateReportError,
  DuplicateReviewError,
  ReviewNotFoundError,
  toPublicReview,
  type PublicReview,
  type StoredReview,
  type ModerationAction,
} from "./reviewTypes";

export type {
  ReviewStatus,
  ReviewReport,
  StoredReview,
  PublicReview,
  ModerationAction,
} from "./reviewTypes";

export {
  DuplicateReviewError,
  DuplicateReportError,
  ReviewNotFoundError,
  toPublicReview,
  LEGACY_SEED_REVIEW_IDS,
  LEGACY_SEED_WALLETS,
  isLegacySeedReview,
} from "./reviewTypes";

let configured: ReviewRepository | null = null;
let defaultPromise: Promise<ReviewRepository> | null = null;

/** Inject a repository (tests). */
export function configureReviewRepository(repo: ReviewRepository | null): void {
  configured = repo;
  defaultPromise = null;
}

export function defaultReviewStorePath(): string {
  const fromEnv = process.env.REVIEW_STORE_PATH?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.tmpdir(), "prompt-hash-reviews", "reviews.json");
}

async function buildDefaultRepository(): Promise<ReviewRepository> {
  if (process.env.MONGODB_URI) {
    const [{ default: connectDb }, reviewModule] = await Promise.all([
      import("../../../server/src/db/connectDb"),
      import("../../../server/src/models/Review"),
    ]);
    await connectDb();
    return createMongoReviewRepository(reviewModule.default as never);
  }
  return createFileReviewRepository(defaultReviewStorePath());
}

export async function getReviewRepository(): Promise<ReviewRepository> {
  if (configured) return configured;
  if (!defaultPromise) {
    defaultPromise = buildDefaultRepository();
  }
  return defaultPromise;
}

/**
 * Returns public visible (or flagged) reviews for a prompt.
 * Hidden reviews are excluded from normal buyer views.
 */
export async function getPublicReviews(promptId: string): Promise<PublicReview[]> {
  const repo = await getReviewRepository();
  const reviews = await repo.listByPrompt(String(promptId));
  return reviews
    .filter((r) => r.status !== "hidden")
    .map(toPublicReview)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getAllReviewsForPrompt(promptId: string): Promise<StoredReview[]> {
  const repo = await getReviewRepository();
  return repo.listByPrompt(String(promptId));
}

export async function hasUserReviewed(promptId: string, userAddress: string): Promise<boolean> {
  const repo = await getReviewRepository();
  return repo.hasUserReviewed(promptId, userAddress);
}

export async function addReview(
  promptId: string,
  userAddress: string,
  rating: number,
  text: string,
): Promise<StoredReview> {
  const repo = await getReviewRepository();
  try {
    return await repo.addReview(promptId, userAddress, rating, text);
  } catch (err) {
    if (err instanceof DuplicateReviewError) throw err;
    throw err;
  }
}

export async function reportReview(
  reviewId: string,
  promptId: string,
  reporterAddress: string,
  reason: string,
): Promise<StoredReview> {
  const repo = await getReviewRepository();
  return repo.reportReview(reviewId, promptId, reporterAddress, reason);
}

export async function moderateReview(
  reviewId: string,
  promptId: string,
  action: ModerationAction,
): Promise<StoredReview> {
  const repo = await getReviewRepository();
  return repo.moderateReview(reviewId, promptId, action);
}

/**
 * Reset store (unit tests). Clears durable data; does NOT re-seed fiction.
 */
export async function resetReviewStore(): Promise<void> {
  const repo = await getReviewRepository();
  await repo.clear();
}

export async function removeSeedRecords(): Promise<number> {
  const repo = await getReviewRepository();
  return repo.removeSeedRecords();
}

/** Re-export factory helpers for tests / ops. */
export { createFileReviewRepository } from "./fileReviewRepository";
export { createMongoReviewRepository } from "./mongoReviewRepository";
