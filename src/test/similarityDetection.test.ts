/**
 * Tests for the Anti-Plagiarism / Similarity Detection service (Issue #133).
 *
 * Tests pure algorithm functions (no DB) and the full scanForSimilarity flow
 * with a mocked Prompt model.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock Prompt model before importing the service
// ---------------------------------------------------------------------------
const { mockFindLean, mockFind, mockFindOneAndUpdate } = vi.hoisted(() => {
  const mLean = vi.fn();
  return {
    mockFindLean: mLean,
    mockFind: vi.fn(() => ({ lean: mLean })),
    mockFindOneAndUpdate: vi.fn(),
  };
});

vi.mock("../../server/src/models/Prompt", () => ({
  default: {
    find: mockFind,
    findOneAndUpdate: mockFindOneAndUpdate,
  },
}));

import {
  cosineSimilarity,
  levenshteinRatio,
  computeSimilarityScore,
  classifyScore,
  scanForSimilarity,
  SIMILARITY_THRESHOLDS,
  decidePublication,
  flagToDecision,
  buildCreatorFeedback,
  evaluatePublishSimilarity,
  applyMaintainerOverride,
  withOverride,
  PUBLICATION_THRESHOLDS,
  type PublishSimilarityResult,
} from "../../server/src/services/similarityDetection";

beforeEach(() => {
  vi.clearAllMocks();
  mockFind.mockReturnValue({ lean: mockFindLean });
  mockFindLean.mockResolvedValue([]);
  mockFindOneAndUpdate.mockResolvedValue({});
});

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical term-frequency maps", () => {
    const tf = new Map([["hello", 0.5], ["world", 0.5]]);
    expect(cosineSimilarity(tf, tf)).toBeCloseTo(1.0);
  });

  it("returns 0.0 for completely disjoint maps", () => {
    const a = new Map([["foo", 1]]);
    const b = new Map([["bar", 1]]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });

  it("returns 0.0 for empty maps", () => {
    expect(cosineSimilarity(new Map(), new Map())).toBe(0);
  });

  it("returns partial score for overlapping vocabularies", () => {
    const a = new Map([["write", 0.5], ["code", 0.5]]);
    const b = new Map([["write", 0.5], ["tests", 0.5]]);
    const score = cosineSimilarity(a, b);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// levenshteinRatio
// ---------------------------------------------------------------------------

describe("levenshteinRatio", () => {
  it("returns 1.0 for identical strings", () => {
    expect(levenshteinRatio("hello", "hello")).toBeCloseTo(1.0);
  });

  it("returns 0.0 for completely different strings of same length", () => {
    expect(levenshteinRatio("abc", "xyz")).toBeCloseTo(0.0);
  });

  it("returns 1.0 for two empty strings", () => {
    expect(levenshteinRatio("", "")).toBe(1);
  });

  it("returns intermediate score for minor edits", () => {
    const score = levenshteinRatio("kitten", "sitting");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("handles one empty string", () => {
    expect(levenshteinRatio("", "hello")).toBeCloseTo(0.0);
  });
});

// ---------------------------------------------------------------------------
// computeSimilarityScore — algorithm routing
// ---------------------------------------------------------------------------

describe("computeSimilarityScore", () => {
  it("uses Levenshtein for texts shorter than 50 chars", () => {
    const score = computeSimilarityScore("hello world", "hello world");
    expect(score).toBeCloseTo(1.0);
  });

  it("uses cosine similarity for longer texts", () => {
    const long =
      "Write a detailed marketing email to promote a new SaaS product launch for developers. Include key features, pricing, and a call to action.";
    const score = computeSimilarityScore(long, long);
    expect(score).toBeCloseTo(1.0);
  });

  it("scores near-duplicate long texts highly", () => {
    const original =
      "Write a detailed marketing email to promote a new SaaS product launch for developers. Include key features, pricing, and a call to action.";
    const nearDup =
      "Write a detailed marketing email to promote a new SaaS product launch for developers. Include key features, pricing, and a call to action with urgency.";
    const score = computeSimilarityScore(original, nearDup);
    expect(score).toBeGreaterThan(0.85);
  });

  it("scores unrelated long texts near 0", () => {
    const a =
      "Generate a professional cover letter for a software engineering position at a fintech startup, emphasizing TypeScript and distributed systems experience.";
    const b =
      "Create a whimsical bedtime story about a dragon who collects colorful socks and learns the value of sharing with their forest friends.";
    const score = computeSimilarityScore(a, b);
    expect(score).toBeLessThan(0.4);
  });
});

// ---------------------------------------------------------------------------
// classifyScore
// ---------------------------------------------------------------------------

describe("classifyScore", () => {
  it("classifies score >= 0.90 as highly_similar", () => {
    expect(classifyScore(SIMILARITY_THRESHOLDS.HIGHLY_SIMILAR)).toBe("highly_similar");
    expect(classifyScore(0.95)).toBe("highly_similar");
  });

  it("classifies score >= 0.70 and < 0.90 as suspicious", () => {
    expect(classifyScore(SIMILARITY_THRESHOLDS.SUSPICIOUS)).toBe("suspicious");
    expect(classifyScore(0.80)).toBe("suspicious");
    expect(classifyScore(0.89)).toBe("suspicious");
  });

  it("classifies score < 0.70 as clean", () => {
    expect(classifyScore(0.69)).toBe("clean");
    expect(classifyScore(0)).toBe("clean");
  });
});

// ---------------------------------------------------------------------------
// scanForSimilarity — integration (mocked DB)
// ---------------------------------------------------------------------------

describe("scanForSimilarity", () => {
  it("returns clean for a prompt with no existing prompts to compare", async () => {
    mockFindLean.mockResolvedValueOnce([]);

    const result = await scanForSimilarity("101", "A unique prompt about astronomy");

    expect(result.flag).toBe("clean");
    expect(result.score).toBe(0);
    expect(result.similarTo).toBeNull();
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { onChainId: "101" },
      expect.objectContaining({ $set: expect.objectContaining({ similarityFlag: "clean" }) }),
    );
  });

  it("flags highly_similar when score >= 0.90", async () => {
    const content =
      "Write a professional marketing email for a SaaS launch. Include features, pricing, and a call to action.";
    // Exact duplicate of an existing listing → block / highly_similar.
    mockFindLean.mockResolvedValueOnce([
      {
        onChainId: "50",
        title: "Marketing Email",
        content,
      },
    ]);

    const result = await scanForSimilarity("102", content);

    expect(result.flag).toBe("highly_similar");
    expect(result.score).toBeGreaterThanOrEqual(0.9);
    expect(result.similarTo).toBe("50");
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { onChainId: "102" },
      expect.objectContaining({
        $set: expect.objectContaining({
          similarityFlag: "highly_similar",
          similarTo: "50",
        }),
      }),
    );
  });

  it("flags suspicious when score is between 0.70 and 0.90", async () => {
    const content =
      "Create a weekly content calendar for a B2B SaaS Twitter account covering product updates, customer stories, and industry tips with suggested post times.";
    mockFindLean.mockResolvedValueOnce([
      {
        onChainId: "51",
        title: "Content Calendar",
        content:
          "Create a weekly content calendar for a B2B SaaS Twitter account covering product launches, customer testimonials, and industry news with recommended posting times.",
      },
    ]);

    const result = await scanForSimilarity("103", content);

    expect(result.flag).toBe("suspicious");
    expect(result.score).toBeGreaterThanOrEqual(0.7);
    expect(result.score).toBeLessThan(0.9);
  });

  it("sets similarTo to null when flag is clean", async () => {
    mockFindLean.mockResolvedValueOnce([
      {
        onChainId: "52",
        title: "Dragon Story",
        content:
          "A magical story about a dragon who collects socks and learns to share.",
      },
    ]);

    const result = await scanForSimilarity(
      "104",
      "Write a Python script that scrapes stock prices from Yahoo Finance and sends a daily summary email.",
    );

    expect(result.flag).toBe("clean");
    expect(result.similarTo).toBeNull();
  });

  it("excludes the target prompt from the comparison set", async () => {
    mockFindLean.mockResolvedValueOnce([]);

    await scanForSimilarity("105", "some content");

    // find() must exclude the target prompt
    expect(mockFind).toHaveBeenCalledWith(
      expect.objectContaining({ onChainId: { $ne: "105" } }),
      expect.anything(),
    );
  });

  it("picks the most similar prompt when multiple candidates exist", async () => {
    const content = "Generate unit tests for a REST API using Jest and Supertest in Node.js.";
    mockFindLean.mockResolvedValueOnce([
      {
        onChainId: "60",
        title: "Other",
        content: "Write a short bedtime story for children about a helpful robot.",
      },
      {
        onChainId: "61",
        title: "Tests",
        content: "Generate unit tests for a REST API using Jest and Supertest in Node.js.",
      },
    ]);

    const result = await scanForSimilarity("106", content);

    expect(result.similarTo).toBe("61");
    expect(result.score).toBeCloseTo(1.0, 1);
  });
});

// ---------------------------------------------------------------------------
// Publication decisions (Issue #242) — allow / review / block / override
// ---------------------------------------------------------------------------


describe("decidePublication", () => {
  it("allows scores below the review threshold", () => {
    expect(decidePublication(0)).toBe("allow");
    expect(decidePublication(PUBLICATION_THRESHOLDS.REVIEW - 0.01)).toBe("allow");
  });

  it("sends mid-range scores to review", () => {
    expect(decidePublication(PUBLICATION_THRESHOLDS.REVIEW)).toBe("review");
    expect(decidePublication(0.85)).toBe("review");
    expect(decidePublication(PUBLICATION_THRESHOLDS.BLOCK - 0.01)).toBe("review");
  });

  it("blocks scores at or above the block threshold", () => {
    expect(decidePublication(PUBLICATION_THRESHOLDS.BLOCK)).toBe("block");
    expect(decidePublication(0.99)).toBe("block");
  });
});

describe("flagToDecision", () => {
  it("maps detection flags to publication decisions", () => {
    expect(flagToDecision("clean")).toBe("allow");
    expect(flagToDecision("suspicious")).toBe("review");
    expect(flagToDecision("highly_similar")).toBe("block");
  });
});

describe("buildCreatorFeedback", () => {
  it("returns actionable steps for block", () => {
    const feedback = buildCreatorFeedback("block", 0.95, "42");
    expect(feedback.title.toLowerCase()).toContain("blocked");
    expect(feedback.actions.length).toBeGreaterThan(0);
    expect(feedback.similarTo).toBe("42");
    expect(feedback.scorePercent).toBe(95);
  });

  it("returns review guidance with actions", () => {
    const feedback = buildCreatorFeedback("review", 0.8, "7");
    expect(feedback.decision).toBe("review");
    expect(feedback.actions.length).toBeGreaterThan(0);
  });

  it("returns a clean pass message for allow", () => {
    const feedback = buildCreatorFeedback("allow", 0.2, null);
    expect(feedback.decision).toBe("allow");
    expect(feedback.actions).toEqual([]);
  });
});

describe("evaluatePublishSimilarity — allow / review / block", () => {
  it("allows unrelated drafts", () => {
    const result = evaluatePublishSimilarity(
      "Write a Python script that scrapes stock prices from Yahoo Finance and emails a daily summary.",
      [
        {
          onChainId: "1",
          title: "Dragon Story",
          content: "A magical story about a dragon who collects socks and learns to share.",
        },
      ],
    );
    expect(result.decision).toBe("allow");
    expect(result.flag).toBe("clean");
    expect(result.feedback.decision).toBe("allow");
  });

  it("blocks near-duplicate drafts", () => {
    const content =
      "Write a professional marketing email for a SaaS launch. Include features, pricing, and a call to action.";
    const result = evaluatePublishSimilarity(content, [
      {
        onChainId: "50",
        title: "Marketing Email",
        content:
          "Write a professional marketing email for a SaaS launch. Include features, pricing, and a call to action.",
      },
    ]);
    expect(result.decision).toBe("block");
    expect(result.flag).toBe("highly_similar");
    expect(result.similarTo).toBe("50");
    expect(result.feedback.actions.length).toBeGreaterThan(0);
  });

  it("sends moderately overlapping drafts to review", () => {
    const content =
      "Write a detailed onboarding email sequence for new SaaS users covering welcome, setup checklist, and first-week tips.";
    const result = evaluatePublishSimilarity(content, [
      {
        onChainId: "51",
        title: "Onboarding Sequence",
        content:
          "Write a detailed onboarding email sequence for new SaaS customers covering welcome message, setup steps, and first week advice.",
      },
    ]);
    expect(result.decision).toBe("review");
    expect(result.flag).toBe("suspicious");
    expect(result.feedback.summary.length).toBeGreaterThan(0);
  });
});

describe("applyMaintainerOverride + withOverride", () => {
  const blocked: PublishSimilarityResult = {
    flag: "highly_similar",
    score: 0.94,
    similarTo: "50",
    decision: "block",
    feedback: buildCreatorFeedback("block", 0.94, "50"),
  };

  it("records an override audit entry from block → allow", () => {
    const override = applyMaintainerOverride({
      promptId: "102",
      actorAddress: "GABCDEF",
      previousDecision: "block",
      newDecision: "allow",
      reason: "False positive — shared boilerplate only",
      score: 0.94,
      similarTo: "50",
      previousVersion: 1,
    });

    expect(override.previousDecision).toBe("block");
    expect(override.newDecision).toBe("allow");
    expect(override.decisionVersion).toBe(2);
    expect(override.actorAddress).toBe("gabcdef");
    expect(override.reason).toContain("False positive");
    expect(override.at).toMatch(/^\d{4}-/);
  });

  it("applies override to the publish result without mutating the original", () => {
    const override = applyMaintainerOverride({
      promptId: "102",
      actorAddress: "GABCDEF",
      previousDecision: "block",
      newDecision: "allow",
      reason: "Maintainer clearing false positive",
      score: blocked.score,
      similarTo: blocked.similarTo,
    });

    const next = withOverride(blocked, override);
    expect(next.decision).toBe("allow");
    expect(next.flag).toBe("clean");
    expect(next.overridden).toBe(true);
    expect(next.similarTo).toBeNull();
    expect(blocked.decision).toBe("block");
  });

  it("rejects overrides missing a reason or actor", () => {
    expect(() =>
      applyMaintainerOverride({
        promptId: "1",
        actorAddress: "",
        previousDecision: "block",
        newDecision: "allow",
        reason: "ok",
        score: 0.9,
      }),
    ).toThrow(/actorAddress/);

    expect(() =>
      applyMaintainerOverride({
        promptId: "1",
        actorAddress: "GABC",
        previousDecision: "block",
        newDecision: "allow",
        reason: "   ",
        score: 0.9,
      }),
    ).toThrow(/reason/);
  });

  it("rejects no-op overrides that do not change the decision", () => {
    expect(() =>
      applyMaintainerOverride({
        promptId: "1",
        actorAddress: "GABC",
        previousDecision: "block",
        newDecision: "block",
        reason: "noop",
        score: 0.9,
      }),
    ).toThrow(/must change/);
  });
});
