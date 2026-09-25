/**
 * Mongo-backed durable review repository (#179).
 *
 * Uses the shared Review model unique index on (promptId, userAddress)
 * so concurrent inserts yield exactly one document (E11000 → duplicate).
 */

import type { ReviewRepository } from "./reviewRepository";
import {
  DuplicateReportError,
  DuplicateReviewError,
  ReviewNotFoundError,
  LEGACY_SEED_REVIEW_IDS,
  LEGACY_SEED_WALLETS,
  normalizeWallet,
  type ModerationAction,
  type StoredReview,
  type ReviewReport,
  type ReviewStatus,
} from "./reviewTypes";

type LeanReview = {
  reviewId?: string;
  _id: { toString(): string };
  promptId: string;
  userAddress: string;
  rating: number;
  text?: string;
  verified?: boolean;
  status?: ReviewStatus;
  reports?: Array<{ reporterAddress: string; reason: string; createdAt: Date | number }>;
  reportCount?: number;
  createdAt?: Date | number;
  updatedAt?: Date | number;
};

function toMillis(value: Date | number | undefined): number {
  if (value == null) return Date.now();
  if (typeof value === "number") return value;
  return value.getTime();
}

function toStored(doc: LeanReview): StoredReview {
  const reports: ReviewReport[] = (doc.reports ?? []).map((r) => ({
    reporterAddress: r.reporterAddress,
    reason: r.reason,
    createdAt: toMillis(r.createdAt),
  }));
  return {
    id: doc.reviewId ?? doc._id.toString(),
    promptId: String(doc.promptId),
    userAddress: doc.userAddress,
    rating: doc.rating,
    text: doc.text ?? "",
    createdAt: toMillis(doc.createdAt),
    updatedAt: toMillis(doc.updatedAt),
    verified: Boolean(doc.verified),
    status: doc.status ?? "visible",
    reports,
    reportCount: doc.reportCount ?? reports.length,
  };
}

function isDuplicateKeyError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: number }).code === 11000);
}

export interface MongoReviewModel {
  create(doc: Record<string, unknown>): Promise<LeanReview>;
  find(filter: Record<string, unknown>): {
    sort(spec: Record<string, 1 | -1>): {
      lean(): Promise<LeanReview[]>;
    };
  };
  findOne(filter: Record<string, unknown>): {
    lean(): Promise<LeanReview | null>;
  };
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: Record<string, unknown>,
  ): Promise<LeanReview | null>;
  deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount?: number }>;
  countDocuments(filter?: Record<string, unknown>): Promise<number>;
}

function idFilter(reviewId: string, promptId: string): Record<string, unknown> {
  return {
    promptId: String(promptId),
    $or: [{ reviewId }, { _id: reviewId }],
  };
}

export function createMongoReviewRepository(Review: MongoReviewModel): ReviewRepository {
  return {
    async listByPrompt(promptId) {
      const rows = await Review.find({ promptId: String(promptId) }).sort({ createdAt: -1 }).lean();
      return rows.map(toStored);
    },

    async hasUserReviewed(promptId, userAddress) {
      const row = await Review.findOne({
        promptId: String(promptId),
        userAddress: normalizeWallet(userAddress),
      }).lean();
      return Boolean(row);
    },

    async addReview(promptId, userAddress, rating, text) {
      const now = new Date();
      const reviewId = `review_${now.getTime()}_${Math.random().toString(36).slice(2, 9)}`;
      try {
        const doc = await Review.create({
          reviewId,
          promptId: String(promptId),
          userAddress: normalizeWallet(userAddress),
          rating,
          text: text.trim(),
          verified: true,
          status: "visible",
          reports: [],
          reportCount: 0,
        });
        return toStored(doc);
      } catch (err) {
        if (isDuplicateKeyError(err)) throw new DuplicateReviewError();
        throw err;
      }
    },

    async reportReview(reviewId, promptId, reporterAddress, reason) {
      const reporter = normalizeWallet(reporterAddress);
      const updated = await Review.findOneAndUpdate(
        {
          ...idFilter(reviewId, promptId),
          "reports.reporterAddress": { $ne: reporter },
        },
        {
          $push: {
            reports: {
              reporterAddress: reporter,
              reason: reason.trim(),
              createdAt: new Date(),
            },
          },
          $inc: { reportCount: 1 },
          $set: { status: "flagged" },
        },
        { new: true },
      );

      if (updated) return toStored(updated);

      const existing = await Review.findOne(idFilter(reviewId, promptId)).lean();
      if (!existing) throw new ReviewNotFoundError();
      throw new DuplicateReportError();
    },

    async moderateReview(reviewId, promptId, action: ModerationAction) {
      let update: Record<string, unknown>;
      if (action === "hide") {
        update = { $set: { status: "hidden" } };
      } else if (action === "unhide") {
        update = { $set: { status: "visible" } };
      } else {
        update = {
          $set: { status: "visible", reports: [], reportCount: 0 },
        };
      }

      const updated = await Review.findOneAndUpdate(idFilter(reviewId, promptId), update, {
        new: true,
      });
      if (!updated) throw new ReviewNotFoundError();
      return toStored(updated);
    },

    async getById(reviewId, promptId) {
      const filter: Record<string, unknown> = {
        $or: [{ reviewId }, { _id: reviewId }],
      };
      if (promptId !== undefined) filter.promptId = String(promptId);
      const row = await Review.findOne(filter).lean();
      return row ? toStored(row) : null;
    },

    async clear() {
      await Review.deleteMany({});
    },

    async removeSeedRecords() {
      const result = await Review.deleteMany({
        $or: [
          { reviewId: { $in: [...LEGACY_SEED_REVIEW_IDS] } },
          {
            userAddress: {
              $in: LEGACY_SEED_WALLETS.map((w) => w.toLowerCase()),
            },
          },
        ],
      });
      return result.deletedCount ?? 0;
    },

    async countAll() {
      return Review.countDocuments({});
    },
  };
}
