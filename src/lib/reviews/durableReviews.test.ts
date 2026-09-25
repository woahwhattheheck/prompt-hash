/**
 * Durable review storage tests (#179).
 *
 * Covers: restart, multi-instance concurrency, duplicate review,
 * reporting, moderation, and migration/removal of seed records.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  createFileReviewRepository,
  configureReviewRepository,
  getPublicReviews,
  addReview,
  reportReview,
  moderateReview,
  removeSeedRecords,
  resetReviewStore,
  LEGACY_SEED_REVIEW_IDS,
} from "./reviewStore";
import {
  DuplicateReportError,
  DuplicateReviewError,
  type StoredReview,
} from "./reviewTypes";
import type { ReviewRepository } from "./reviewRepository";

async function tempStorePath(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `ph-reviews-${label}-`));
  return path.join(dir, "reviews.json");
}

describe("file-backed durable reviews", () => {
  let storePath: string;
  let repo: ReviewRepository;

  beforeEach(async () => {
    storePath = await tempStorePath("dur");
    repo = createFileReviewRepository(storePath);
    configureReviewRepository(repo);
    await repo.clear();
  });

  afterEach(async () => {
    configureReviewRepository(null);
    try {
      await fs.rm(path.dirname(storePath), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("persists across restart (new repository instance reloads disk)", async () => {
    const created = await repo.addReview(
      "42",
      "GWALLETAAAA",
      5,
      "Excellent prompt for durable storage checks.",
    );

    // Simulate process restart: new instance, same path.
    const reloaded = createFileReviewRepository(storePath);
    const listed = await reloaded.listByPrompt("42");
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(created.id);
    expect(listed[0].text).toContain("Excellent prompt");
    expect(await reloaded.countAll()).toBe(1);
  });

  it("keeps two repository instances consistent on one durable path", async () => {
    const a = createFileReviewRepository(storePath);
    const b = createFileReviewRepository(storePath);

    await a.addReview("7", "GINSTAAAA", 4, "Written via instance A path lock.");
    const fromB = await b.listByPrompt("7");
    expect(fromB).toHaveLength(1);
    expect(fromB[0].userAddress).toBe("GINSTAAAA");

    await b.addReview("7", "GINSTBBBB", 3, "Written via instance B path lock.");
    expect(await a.countAll()).toBe(2);
    expect(await b.countAll()).toBe(2);
  });

  it("creates exactly one review under concurrent duplicate submissions", async () => {
    const wallet = "GDUPLICATEWALLET";
    const promptId = "99";
    const text = "Concurrent duplicate submission body text.";

    const attempts = Array.from({ length: 12 }, (_, i) =>
      repo.addReview(promptId, wallet, 5, `${text} attempt=${i}`),
    );

    const results = await Promise.allSettled(attempts);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(11);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(DuplicateReviewError);
    }

    const listed = await repo.listByPrompt(promptId);
    expect(listed).toHaveLength(1);
    expect(listed[0].userAddress).toBe(wallet);
  });

  it("rejects sequential duplicates with DuplicateReviewError", async () => {
    await addReview("1", "GSEQ", 5, "First durable review submission ok.");
    await expect(addReview("1", "GSEQ", 4, "Second attempt should fail uniquely.")).rejects.toBeInstanceOf(
      DuplicateReviewError,
    );
    expect(await repo.countAll()).toBe(1);
  });

  it("reports and moderates atomically", async () => {
    const review = await addReview("5", "GREVIEWER", 5, "Solid prompt worth reviewing carefully.");
    const flagged = await reportReview(
      review.id,
      "5",
      "GREPORTER1",
      "Contains spam links and noise.",
    );
    expect(flagged.status).toBe("flagged");
    expect(flagged.reportCount).toBe(1);

    await expect(
      reportReview(review.id, "5", "GREPORTER1", "Trying to report again same wallet."),
    ).rejects.toBeInstanceOf(DuplicateReportError);

    const hidden = await moderateReview(review.id, "5", "hide");
    expect(hidden.status).toBe("hidden");

    const publicList = await getPublicReviews("5");
    expect(publicList.map((r) => r.id)).not.toContain(review.id);

    const restored = await moderateReview(review.id, "5", "dismiss_reports");
    expect(restored.status).toBe("visible");
    expect(restored.reportCount).toBe(0);
    expect(restored.reports).toHaveLength(0);

    const visibleAgain = await getPublicReviews("5");
    expect(visibleAgain.map((r) => r.id)).toContain(review.id);
  });

  it("removes legacy seed records via migration helper", async () => {
    // Plant legacy-shaped seed rows directly on disk (as if migrated from Map dump).
    const planted: StoredReview[] = [
      {
        id: LEGACY_SEED_REVIEW_IDS[0],
        promptId: "1",
        userAddress: "GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZ",
        rating: 5,
        text: "Excellent prompt! Helped me generate high-quality technical documentation in minutes.",
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
        verified: true,
        status: "visible",
        reports: [],
        reportCount: 0,
      },
      {
        id: "review_real_user",
        promptId: "1",
        userAddress: "GREALBUYERWALLET",
        rating: 4,
        text: "Real buyer review that must survive seed cleanup.",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        verified: true,
        status: "visible",
        reports: [],
        reportCount: 0,
      },
    ];
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify({ version: 1, reviews: planted }, null, 2),
      "utf8",
    );

    // New instance picks up planted data
    const fresh = createFileReviewRepository(storePath);
    configureReviewRepository(fresh);
    expect(await fresh.countAll()).toBe(2);

    const removed = await removeSeedRecords();
    expect(removed).toBe(1);
    expect(await fresh.countAll()).toBe(1);
    const remaining = await fresh.listByPrompt("1");
    expect(remaining[0].id).toBe("review_real_user");
  });

  it("resetReviewStore clears without re-seeding fiction", async () => {
    await addReview("3", "GW", 5, "Temporary review for reset coverage path.");
    await resetReviewStore();
    expect(await repo.countAll()).toBe(0);
    expect(await getPublicReviews("1")).toHaveLength(0);
    expect(await getPublicReviews("3")).toHaveLength(0);
  });
});
