/**
 * Shared review types for durable storage (#179).
 */

export type ReviewStatus = "visible" | "hidden" | "flagged" | "pending";

export interface ReviewReport {
  reporterAddress: string;
  reason: string;
  createdAt: number;
}

export interface StoredReview {
  id: string;
  promptId: string;
  userAddress: string;
  rating: number;
  text: string;
  createdAt: number;
  updatedAt: number;
  verified: boolean;
  status: ReviewStatus;
  reports: ReviewReport[];
  reportCount: number;
}

export interface PublicReview {
  id: string;
  promptId: string;
  userAddress: string;
  rating: number;
  text: string;
  createdAt: number;
  verified: boolean;
  status: ReviewStatus;
}

export type ModerationAction = "hide" | "unhide" | "dismiss_reports";

/** Fictional seed IDs / wallets from the old in-memory map — never re-seed in production. */
export const LEGACY_SEED_REVIEW_IDS = ["review_1", "review_2", "review_3"] as const;

export const LEGACY_SEED_WALLETS = [
  "GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZ",
  "GBCD234ABC567EFG890HIJ123KLM456NOP789QRS012TUV345WXY678ZA",
  "GCDE345BCD678FGH901IJK234LMN567OPQ890RST123UVW456XYZ789AB",
] as const;

export class DuplicateReviewError extends Error {
  constructor(message = "You have already reviewed this prompt") {
    super(message);
    this.name = "DuplicateReviewError";
  }
}

export class ReviewNotFoundError extends Error {
  constructor(message = "Review not found") {
    super(message);
    this.name = "ReviewNotFoundError";
  }
}

export class DuplicateReportError extends Error {
  constructor(message = "You have already reported this review") {
    super(message);
    this.name = "DuplicateReportError";
  }
}

/**
 * Strips internal moderation metadata before returning to public buyers.
 */
export function toPublicReview(review: StoredReview): PublicReview {
  return {
    id: review.id,
    promptId: review.promptId,
    userAddress: review.userAddress,
    rating: review.rating,
    text: review.text,
    createdAt: review.createdAt,
    verified: review.verified,
    status: review.status,
  };
}

export function normalizeWallet(address: string): string {
  return address.trim().toLowerCase();
}

export function uniqueReviewKey(promptId: string, userAddress: string): string {
  return `${String(promptId)}::${normalizeWallet(userAddress)}`;
}

export function isLegacySeedReview(review: Pick<StoredReview, "id" | "userAddress">): boolean {
  const idHit = (LEGACY_SEED_REVIEW_IDS as readonly string[]).includes(review.id);
  const walletHit = (LEGACY_SEED_WALLETS as readonly string[]).some(
    (w) => w.toLowerCase() === review.userAddress.toLowerCase(),
  );
  return idHit || walletHit;
}
