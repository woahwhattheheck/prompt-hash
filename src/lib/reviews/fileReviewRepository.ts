/**
 * File-backed durable review repository (#179).
 *
 * Survives process restart (reload from disk) and stays consistent across
 * multiple repository instances that share the same path (path lock +
 * atomic temp-file rename). Used for local/dev and CI; production prefers Mongo.
 */

import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { withPathLock } from "./pathLock";
import type { ReviewRepository } from "./reviewRepository";
import {
  DuplicateReportError,
  DuplicateReviewError,
  ReviewNotFoundError,
  isLegacySeedReview,
  normalizeWallet,
  uniqueReviewKey,
  type ModerationAction,
  type StoredReview,
} from "./reviewTypes";

interface FileSnapshot {
  version: 1;
  reviews: StoredReview[];
}

function emptySnapshot(): FileSnapshot {
  return { version: 1, reviews: [] };
}

async function readSnapshot(filePath: string): Promise<FileSnapshot> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as FileSnapshot;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.reviews)) {
      return emptySnapshot();
    }
    return parsed;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return emptySnapshot();
    throw err;
  }
}

async function writeSnapshot(filePath: string, snapshot: FileSnapshot): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
  const payload = JSON.stringify(snapshot, null, 2);
  await fs.writeFile(tmp, payload, "utf8");
  await fs.rename(tmp, filePath);
}

function newReviewId(): string {
  return `review_${Date.now()}_${randomBytes(4).toString("hex")}`;
}

export function createFileReviewRepository(filePath: string): ReviewRepository {
  const absPath = path.resolve(filePath);

  async function mutate<T>(fn: (snap: FileSnapshot) => T | Promise<T>): Promise<T> {
    return withPathLock(absPath, async () => {
      const snap = await readSnapshot(absPath);
      const result = await fn(snap);
      await writeSnapshot(absPath, snap);
      return result;
    });
  }

  return {
    async listByPrompt(promptId) {
      const snap = await withPathLock(absPath, () => readSnapshot(absPath));
      return snap.reviews
        .filter((r) => r.promptId === String(promptId))
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((r) => ({ ...r, reports: r.reports.map((x) => ({ ...x })) }));
    },

    async hasUserReviewed(promptId, userAddress) {
      const snap = await withPathLock(absPath, () => readSnapshot(absPath));
      const key = uniqueReviewKey(promptId, userAddress);
      return snap.reviews.some((r) => uniqueReviewKey(r.promptId, r.userAddress) === key);
    },

    async addReview(promptId, userAddress, rating, text) {
      return mutate((snap) => {
        const key = uniqueReviewKey(promptId, userAddress);
        if (snap.reviews.some((r) => uniqueReviewKey(r.promptId, r.userAddress) === key)) {
          throw new DuplicateReviewError();
        }
        const now = Date.now();
        const review: StoredReview = {
          id: newReviewId(),
          promptId: String(promptId),
          userAddress,
          rating,
          text: text.trim(),
          createdAt: now,
          updatedAt: now,
          verified: true,
          status: "visible",
          reports: [],
          reportCount: 0,
        };
        snap.reviews.push(review);
        return { ...review, reports: [] };
      });
    },

    async reportReview(reviewId, promptId, reporterAddress, reason) {
      return mutate((snap) => {
        const review = snap.reviews.find(
          (r) => r.id === reviewId && r.promptId === String(promptId),
        );
        if (!review) throw new ReviewNotFoundError();

        const reporter = normalizeWallet(reporterAddress);
        if (review.reports.some((rep) => normalizeWallet(rep.reporterAddress) === reporter)) {
          throw new DuplicateReportError();
        }

        const report = {
          reporterAddress,
          reason: reason.trim(),
          createdAt: Date.now(),
        };
        review.reports.push(report);
        review.reportCount += 1;
        review.status = "flagged";
        review.updatedAt = Date.now();
        return {
          ...review,
          reports: review.reports.map((x) => ({ ...x })),
        };
      });
    },

    async moderateReview(reviewId, promptId, action: ModerationAction) {
      return mutate((snap) => {
        const review = snap.reviews.find(
          (r) => r.id === reviewId && r.promptId === String(promptId),
        );
        if (!review) throw new ReviewNotFoundError();

        if (action === "hide") {
          review.status = "hidden";
        } else if (action === "unhide") {
          review.status = "visible";
        } else if (action === "dismiss_reports") {
          review.status = "visible";
          review.reports = [];
          review.reportCount = 0;
        }
        review.updatedAt = Date.now();
        return {
          ...review,
          reports: review.reports.map((x) => ({ ...x })),
        };
      });
    },

    async getById(reviewId, promptId) {
      const snap = await withPathLock(absPath, () => readSnapshot(absPath));
      const review = snap.reviews.find(
        (r) => r.id === reviewId && (promptId === undefined || r.promptId === String(promptId)),
      );
      return review
        ? { ...review, reports: review.reports.map((x) => ({ ...x })) }
        : null;
    },

    async clear() {
      await withPathLock(absPath, async () => {
        await writeSnapshot(absPath, emptySnapshot());
      });
    },

    async removeSeedRecords() {
      return mutate((snap) => {
        const before = snap.reviews.length;
        snap.reviews = snap.reviews.filter((r) => !isLegacySeedReview(r));
        return before - snap.reviews.length;
      });
    },

    async countAll() {
      const snap = await withPathLock(absPath, () => readSnapshot(absPath));
      return snap.reviews.length;
    },
  };
}
