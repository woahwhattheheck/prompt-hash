import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  promptFind,
  promptLean,
  reviewFind,
  reviewFindById,
  reviewWrite,
  checkPublishSimilarity,
} = vi.hoisted(() => {
  const promptLean = vi.fn();
  return {
    promptLean,
    promptFind: vi.fn(() => ({ lean: promptLean })),
    reviewFind: vi.fn(),
    reviewFindById: vi.fn(),
    reviewWrite: vi.fn(),
    checkPublishSimilarity: vi.fn(),
  };
});

vi.mock("../../server/src/models/Prompt", () => ({
  default: { find: promptFind },
}));

vi.mock("../../server/src/models/PublicationReview", () => ({
  default: {
    findOne: reviewFind,
    findById: reviewFindById,
    findOneAndUpdate: reviewWrite,
  },
}));

vi.mock("../../server/src/services/similarityDetection", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, checkPublishSimilarity };
});

import {
  createPublicationCommitment,
  overridePublicationReview,
  requestPublicationReview,
} from "../../server/src/services/publicationReview";

const reviewId = "665000000000000000000099";
const creator = "GCREATORACCOUNT1234567890ABCDEFGH1234567890ABCDEFGH1234567890";
const title = "Campaign launch pack";
const content = "Private prompt body used for exact publication admission.";

let stored: any = null;

const clone = (value: any) =>
  value == null ? value : JSON.parse(JSON.stringify(value));

beforeEach(() => {
  vi.clearAllMocks();
  stored = null;
  promptFind.mockReturnValue({ lean: promptLean });
  promptLean.mockResolvedValue([]);

  reviewFind.mockImplementation((filter: any) => ({
    lean: async () =>
      stored &&
      stored.creatorAddress === filter.creatorAddress &&
      stored.contentCommitment === filter.contentCommitment
        ? clone(stored)
        : null,
  }));

  reviewFindById.mockImplementation((id: string) => ({
    lean: async () => (stored && stored._id === id ? clone(stored) : null),
  }));

  reviewWrite.mockImplementation((filter: any, update: any) => ({
    lean: async () => {
      if (filter._id) {
        if (
          !stored ||
          stored._id !== String(filter._id) ||
          stored.decision !== filter.decision ||
          stored.decisionVersion !== filter.decisionVersion
        ) {
          return null;
        }
        Object.assign(stored, clone(update.$set ?? {}));
        for (const [key, value] of Object.entries(update.$push ?? {})) {
          (stored[key] ??= []).push(clone(value));
        }
        return clone(stored);
      }

      if (
        stored &&
        stored.creatorAddress === filter.creatorAddress &&
        stored.contentCommitment === filter.contentCommitment
      ) {
        return clone(stored);
      }
      stored = {
        _id: reviewId,
        ...clone(update.$setOnInsert),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return clone(stored);
    },
  }));
});

describe("persisted publication admission", () => {
  it("keeps clean submissions ephemeral", async () => {
    checkPublishSimilarity.mockResolvedValue({
      flag: "clean",
      score: 0.12,
      similarTo: null,
      decision: "allow",
      feedback: {
        decision: "allow",
        title: "Similarity check passed",
        summary: "No high-risk overlap.",
        actions: [],
        scorePercent: 12,
        similarTo: null,
      },
    });

    const result = await requestPublicationReview({
      creatorAddress: creator,
      title,
      content,
    });

    expect(result.decision).toBe("allow");
    expect(result.persisted).toBe(false);
    expect(result.reviewId).toBeNull();
    expect(reviewWrite).not.toHaveBeenCalled();
  });

  it("persists review evidence without draft plaintext", async () => {
    checkPublishSimilarity.mockResolvedValue({
      flag: "suspicious",
      score: 0.81,
      similarTo: "17",
      decision: "review",
      feedback: {
        decision: "review",
        title: "Sent to review",
        summary: "Elevated similarity.",
        actions: [],
        scorePercent: 81,
        similarTo: "17",
      },
    });

    const result = await requestPublicationReview({
      creatorAddress: creator,
      title,
      content,
    });

    expect(result).toMatchObject({
      decision: "review",
      persisted: true,
      reviewId,
      initialDecision: "review",
      decisionVersion: 1,
    });
    expect(stored.contentCommitment).toBe(
      createPublicationCommitment(title, content),
    );
    expect(stored.score).toBe(0.81);
    expect(stored.similarTo).toBe("17");
    expect(stored).not.toHaveProperty("title");
    expect(stored).not.toHaveProperty("content");
  });

  it("reuses an audited allow override for the exact draft without rescoring", async () => {
    checkPublishSimilarity.mockResolvedValue({
      flag: "suspicious",
      score: 0.82,
      similarTo: "23",
      decision: "review",
      feedback: {
        decision: "review",
        title: "Sent to review",
        summary: "Elevated similarity.",
        actions: [],
        scorePercent: 82,
        similarTo: "23",
      },
    });

    const first = await requestPublicationReview({
      creatorAddress: creator,
      title,
      content,
    });
    const cleared = await overridePublicationReview(
      first.reviewId!,
      { newDecision: "allow", reason: "Reviewed source and provenance" },
      "Maintainer:CaseSensitive",
    );
    const replay = await requestPublicationReview({
      creatorAddress: creator,
      title,
      content,
    });

    expect(cleared).toMatchObject({
      decision: "allow",
      overridden: true,
      decisionVersion: 2,
    });
    expect(cleared.override).toMatchObject({
      actorAddress: "Maintainer:CaseSensitive",
      previousDecision: "review",
      newDecision: "allow",
      reason: "Reviewed source and provenance",
      decisionVersion: 2,
    });
    expect(stored.audits).toHaveLength(1);
    expect(replay.decision).toBe("allow");
    expect(replay.overridden).toBe(true);
    expect(checkPublishSimilarity).toHaveBeenCalledTimes(1);
  });

  it("does not silently accept a stale competing moderation write", async () => {
    stored = {
      _id: reviewId,
      creatorAddress: creator,
      contentCommitment: createPublicationCommitment(title, content),
      initialDecision: "block",
      decision: "block",
      score: 0.95,
      similarTo: "9",
      decisionVersion: 4,
      audits: [],
    };
    reviewWrite.mockImplementationOnce(() => ({
      lean: async () => null,
    }));

    await expect(
      overridePublicationReview(
        reviewId,
        { newDecision: "allow", reason: "Reviewed" },
        "Maintainer",
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(stored.decision).toBe("block");
    expect(stored.audits).toHaveLength(0);
  });
});
