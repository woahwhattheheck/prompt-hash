/**
 * Durable review repository contract (#179).
 *
 * Implementations must enforce unique (promptId, wallet) and atomic
 * report / moderation transitions. No production seed data.
 */

import type {
  ModerationAction,
  StoredReview,
} from "./reviewTypes";

export interface ReviewRepository {
  /** All reviews for a prompt (including hidden), newest first. */
  listByPrompt(promptId: string): Promise<StoredReview[]>;

  hasUserReviewed(promptId: string, userAddress: string): Promise<boolean>;

  /**
   * Insert a review. Must be atomic w.r.t. the unique (promptId, wallet)
   * constraint — never check-then-insert. Throws DuplicateReviewError.
   */
  addReview(
    promptId: string,
    userAddress: string,
    rating: number,
    text: string,
  ): Promise<StoredReview>;

  /**
   * Append a report and set status=flagged atomically if the reporter
   * has not already reported. Throws ReviewNotFoundError / DuplicateReportError.
   */
  reportReview(
    reviewId: string,
    promptId: string,
    reporterAddress: string,
    reason: string,
  ): Promise<StoredReview>;

  /**
   * Apply moderation atomically. Throws ReviewNotFoundError.
   */
  moderateReview(
    reviewId: string,
    promptId: string,
    action: ModerationAction,
  ): Promise<StoredReview>;

  getById(reviewId: string, promptId?: string): Promise<StoredReview | null>;

  /** Wipe all reviews (tests only). Does not re-seed. */
  clear(): Promise<void>;

  /** Delete legacy in-memory seed records. Returns deleted count. */
  removeSeedRecords(): Promise<number>;

  /** Snapshot count for assertions (optional backends may approximate). */
  countAll(): Promise<number>;
}
