/**
 * Durable review storage tests (#179).
 *
 * Covers: restart, multi-instance concurrency, duplicate review,
 * reporting, moderation, and migration/removal of seed records.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { spawn } from "child_process";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import { withPathLock } from "./pathLock";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import Review from "../../../server/src/models/Review";
import {
  createMongoReviewRepository,
  type MongoReviewModel,
} from "./mongoReviewRepository";
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
  ReviewNotFoundError,
  type StoredReview,
} from "./reviewTypes";
import type { ReviewRepository } from "./reviewRepository";

/** Exercise the real model's query casting without opening a database connection. */
function mongoCastingRepository(
  row: Awaited<ReturnType<MongoReviewModel["create"]>> | null,
) {
  const filters: Record<string, unknown>[] = [];
  const model: Pick<MongoReviewModel, "findOne" | "findOneAndUpdate"> = {
    findOne(filter) {
      return {
        async lean() {
          filters.push(Review.findOne(filter).cast(Review));
          return row;
        },
      };
    },
    async findOneAndUpdate(filter, update, options) {
      filters.push(
        Review.findOneAndUpdate(filter, update, options).cast(Review),
      );
      return row;
    },
  };
  return {
    repo: createMongoReviewRepository(model as MongoReviewModel),
    filters,
  };
}

describe("Mongo review identifier casting", () => {
  it("retrieves, reports and moderates public review IDs without casting them as ObjectIds", async () => {
    const review = new Review({
      reviewId: "review_1791011700000_abc1234",
      promptId: "42",
      userAddress: "gbuyer",
      rating: 5,
    }).toObject();
    const { repo, filters } = mongoCastingRepository(review);

    expect((await repo.getById(review.reviewId, "42"))?.id).toBe(
      review.reviewId,
    );
    expect((await repo.getById(review.reviewId))?.id).toBe(review.reviewId);
    expect(
      (
        await repo.reportReview(
          review.reviewId,
          "42",
          "GREPORTER",
          "Spam links",
        )
      ).id,
    ).toBe(review.reviewId);
    expect((await repo.moderateReview(review.reviewId, "42", "hide")).id).toBe(
      review.reviewId,
    );

    expect(filters).toEqual([
      { reviewId: review.reviewId, promptId: "42" },
      { reviewId: review.reviewId },
      {
        reviewId: review.reviewId,
        promptId: "42",
        "reports.reporterAddress": { $ne: "greporter" },
      },
      { reviewId: review.reviewId, promptId: "42" },
    ]);
  });

  it("retains legacy ObjectId lookup and prompt scope for reads and mutations", async () => {
    const review = new Review({
      promptId: "42",
      userAddress: "gbuyer",
      rating: 4,
    }).toObject();
    const reviewId = review._id.toString();
    const { repo, filters } = mongoCastingRepository(review);

    expect((await repo.getById(reviewId))?.id).toBe(reviewId);
    expect(
      (await repo.reportReview(reviewId, "42", "GREPORTER", "Spam links")).id,
    ).toBe(reviewId);
    expect((await repo.moderateReview(reviewId, "42", "hide")).id).toBe(
      reviewId,
    );

    expect(filters.map((filter) => filter.promptId)).toEqual([
      undefined,
      "42",
      "42",
    ]);
    for (const filter of filters) {
      expect(filter.$or).toEqual([{ reviewId }, { _id: review._id }]);
    }
  });

  it.each(["review_missing", "123456789012", "z".repeat(24)])(
    "returns normal not-found outcomes for an unmatched string ID: %s",
    async (reviewId) => {
      const { repo, filters } = mongoCastingRepository(null);

      expect(await repo.getById(reviewId, "42")).toBeNull();
      await expect(
        repo.reportReview(reviewId, "42", "GREPORTER", "Spam links"),
      ).rejects.toBeInstanceOf(ReviewNotFoundError);
      await expect(
        repo.moderateReview(reviewId, "42", "hide"),
      ).rejects.toBeInstanceOf(ReviewNotFoundError);
      expect(filters.every((filter) => filter.promptId === "42")).toBe(true);
    },
  );
});

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

  it.each([
    [
      "unsupported version",
      (reviews: StoredReview[]) => ({ version: 2, reviews }),
    ],
    ["missing version", (reviews: StoredReview[]) => ({ reviews })],
    [
      "non-array reviews",
      (reviews: StoredReview[]) => ({
        version: 1,
        reviews: { saved: reviews },
      }),
    ],
    ["top-level array", (reviews: StoredReview[]) => reviews],
    ["null", () => null],
  ] as const)(
    "preserves an incompatible snapshot: %s",
    async (_label, incompatibleSnapshot) => {
      const created = await repo.addReview(
        "42",
        "GSAVEDREVIEW",
        5,
        "This persisted review must survive a rejected snapshot.",
      );
      const valid = await fs.readFile(storePath, "utf8");
      const raw = JSON.stringify(incompatibleSnapshot([created]));
      await fs.writeFile(storePath, raw, "utf8");

      await expect(repo.listByPrompt("42")).rejects.toThrow(
        "Invalid review store snapshot",
      );
      expect(await fs.readFile(storePath, "utf8")).toBe(raw);
      await expect(
        repo.addReview(
          "42",
          "GNEWREVIEW",
          4,
          "A new review must not overwrite stored data.",
        ),
      ).rejects.toThrow("Invalid review store snapshot");
      expect(await fs.readFile(storePath, "utf8")).toBe(raw);
      await expect(repo.removeSeedRecords()).rejects.toThrow(
        "Invalid review store snapshot",
      );
      expect(await fs.readFile(storePath, "utf8")).toBe(raw);

      // A rejected snapshot releases the path lock, so restoring valid data recovers.
      await fs.writeFile(storePath, valid, "utf8");
      expect(await repo.getById(created.id, "42")).toEqual(created);
      expect(await fs.readFile(storePath, "utf8")).toBe(valid);
    },
  );

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
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(
        DuplicateReviewError,
      );
    }

    const listed = await repo.listByPrompt(promptId);
    expect(listed).toHaveLength(1);
    expect(listed[0].userAddress).toBe(wallet);
  });

  it("rejects sequential duplicates with DuplicateReviewError", async () => {
    await addReview("1", "GSEQ", 5, "First durable review submission ok.");
    await expect(
      addReview("1", "GSEQ", 4, "Second attempt should fail uniquely."),
    ).rejects.toBeInstanceOf(DuplicateReviewError);
    expect(await repo.countAll()).toBe(1);
  });

  it("reports and moderates atomically", async () => {
    const review = await addReview(
      "5",
      "GREVIEWER",
      5,
      "Solid prompt worth reviewing carefully.",
    );
    const flagged = await reportReview(
      review.id,
      "5",
      "GREPORTER1",
      "Contains spam links and noise.",
    );
    expect(flagged.status).toBe("flagged");
    expect(flagged.reportCount).toBe(1);

    await expect(
      reportReview(
        review.id,
        "5",
        "GREPORTER1",
        "Trying to report again same wallet.",
      ),
    ).rejects.toBeInstanceOf(DuplicateReportError);

    const hidden = await moderateReview(review.id, "5", "hide");
    expect(hidden.status).toBe("hidden");

    const reportedHidden = await reportReview(
      review.id,
      "5",
      "GREPORTER2",
      "$status is literal report text",
    );
    expect(reportedHidden.status).toBe("hidden");
    expect(reportedHidden.reportCount).toBe(2);
    expect(reportedHidden.reports[1].reason).toBe("$status is literal report text");

    const reloaded = createFileReviewRepository(storePath);
    expect((await reloaded.getById(review.id, "5"))?.status).toBe("hidden");
    await expect(
      reloaded.reportReview(review.id, "5", "greporter2", "Duplicate report"),
    ).rejects.toBeInstanceOf(DuplicateReportError);
    expect((await reloaded.getById(review.id, "5"))?.reportCount).toBe(2);

    const publicList = await getPublicReviews("5");
    expect(publicList.map((r) => r.id)).not.toContain(review.id);

    const unhidden = await moderateReview(review.id, "5", "unhide");
    expect(unhidden.status).toBe("visible");
    expect(unhidden.reportCount).toBe(2);

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
        userAddress:
          "GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZ",
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

describe("file-store coordination across local processes", () => {
  let workerDir: string;
  let storePath: string;
  let repo: ReviewRepository;

  type Operation = {
    method: "addReview" | "reportReview";
    args: Array<string | number>;
  };
  type Outcome = {
    status: "fulfilled" | "rejected";
    id?: string;
    name?: string;
    message?: string;
  };

  beforeAll(async () => {
    workerDir = await fs.mkdtemp(path.join(os.tmpdir(), "ph-review-workers-"));
    await fs.writeFile(
      path.join(workerDir, "package.json"),
      JSON.stringify({ type: "commonjs" }),
    );
    // Compile the actual repository modules for ordinary Node child processes.
    // This uses the declared TypeScript dev dependency, without a database.
    for (const name of ["pathLock", "reviewTypes", "fileReviewRepository"]) {
      const source = await fs.readFile(
        new URL("./" + name + ".ts", import.meta.url),
        "utf8",
      );
      const compiled = transpileModule(source, {
        compilerOptions: {
          module: ModuleKind.CommonJS,
          target: ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      });
      await fs.writeFile(
        path.join(workerDir, name + ".js"),
        compiled.outputText,
      );
    }
  });

  afterAll(async () => {
    await fs.rm(workerDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    storePath = await tempStorePath("process");
    repo = createFileReviewRepository(storePath);
    await repo.clear();
  });

  afterEach(async () => {
    await fs.rm(path.dirname(storePath), { recursive: true, force: true });
  });

  async function runProcesses(calls: Operation[][]): Promise<Outcome[][]> {
    const workerCode = `
      const { createFileReviewRepository } = require(process.argv[1]);
      const repo = createFileReviewRepository(process.argv[2]);
      process.once("message", async ({ calls }) => {
        const outcomes = [];
        for (const call of calls) {
          try {
            const row = await repo[call.method](...call.args);
            outcomes.push({ status: "fulfilled", id: row.id });
          } catch (error) {
            outcomes.push({ status: "rejected", name: error.name, message: error.message });
          }
        }
        process.send({ kind: "result", outcomes });
        process.disconnect();
      });
      process.send({ kind: "ready" });
    `;
    const children: ReturnType<typeof spawn>[] = [];
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const workers = calls.map((operations) => {
        const child = spawn(
          process.execPath,
          [
            "--max-old-space-size=48",
            "-e",
            workerCode,
            path.join(workerDir, "fileReviewRepository.js"),
            storePath,
          ],
          { stdio: ["ignore", "ignore", "pipe", "ipc"] },
        );
        children.push(child);
        let stderr = "";
        let result: Outcome[] | undefined;
        let markReady!: () => void;
        let finish = (value: Outcome[]) => {
          result = value;
        };
        let fail = (error: Error): void => {
          throw error;
        };
        const ready = new Promise<void>((resolve) => {
          markReady = resolve;
        });
        const done = new Promise<Outcome[]>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        });
        child.stderr?.on("data", (chunk) => {
          stderr = (stderr + String(chunk)).slice(-4096);
        });
        child.on("message", (message) => {
          const data = message as { kind: string; outcomes?: Outcome[] };
          if (data.kind === "ready") markReady();
          if (data.kind === "result") result = data.outcomes;
        });
        child.on("error", (error) => {
          markReady();
          fail(error);
        });
        child.on("exit", (code, signal) => {
          markReady();
          if (code === 0 && result) finish(result);
          else fail(new Error(JSON.stringify({ code, signal, stderr })));
        });
        return { child, operations, ready, done };
      });
      const completed = Promise.all(workers.map((worker) => worker.done));
      const timeout = new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("Review worker deadline exceeded")),
          8_000,
        );
      });
      await Promise.race([
        Promise.all(workers.map((worker) => worker.ready)),
        completed.then(() => {
          throw new Error("Review workers ended before starting");
        }),
        timeout,
      ]);
      for (const worker of workers)
        worker.child.send({ calls: worker.operations });
      return await Promise.race([completed, timeout]);
    } finally {
      clearTimeout(deadline);
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          await new Promise<void>((resolve) => {
            child.once("exit", () => resolve());
            child.kill();
          });
        }),
      );
    }
  }

  it("retains every accepted distinct review from two processes", async () => {
    const results = await runProcesses(
      [0, 1].map((worker) =>
        Array.from({ length: 4 }, (_, index) => ({
          method: "addReview" as const,
          args: [
            "42",
            "GWORKER_" + worker + "_" + index,
            5,
            "A durable process review.",
          ],
        })),
      ),
    );
    expect(
      results.flat().every((result) => result.status === "fulfilled"),
    ).toBe(true);
    const persisted = await repo.listByPrompt("42");
    expect(persisted).toHaveLength(8);
    expect(new Set(persisted.map((review) => review.id))).toEqual(
      new Set(results.flat().map((result) => result.id)),
    );
  }, 15_000);

  it("accepts exactly one concurrent duplicate across processes", async () => {
    const results = (
      await runProcesses(
        [0, 1].map((worker) => [
          {
            method: "addReview" as const,
            args: ["99", "GDUPLICATE", 5, "Review from process " + worker],
          },
        ]),
      )
    ).flat();
    const accepted = results.filter((result) => result.status === "fulfilled");
    expect(accepted).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({ name: "DuplicateReviewError" }),
    ]);
    expect((await repo.listByPrompt("99")).map((review) => review.id)).toEqual(
      accepted.map((result) => result.id),
    );
  }, 15_000);

  it("retains every accepted report from two processes", async () => {
    const review = await repo.addReview(
      "5",
      "GREVIEWER",
      4,
      "A review to report.",
    );
    const results = await runProcesses(
      [0, 1].map((worker) =>
        Array.from({ length: 4 }, (_, index) => ({
          method: "reportReview" as const,
          args: [
            review.id,
            "5",
            "GREPORTER_" + worker + "_" + index,
            "A distinct report reason.",
          ],
        })),
      ),
    );
    expect(
      results.flat().every((result) => result.status === "fulfilled"),
    ).toBe(true);
    const persisted = await repo.getById(review.id, "5");
    expect(persisted?.reports).toHaveLength(8);
    expect(persisted?.reportCount).toBe(8);
    expect(
      new Set(persisted?.reports.map((report) => report.reporterAddress)).size,
    ).toBe(8);
  }, 15_000);

  it("releases its sidecar after both successful and failed operations", async () => {
    const lockPath = storePath + ".lock";
    await expect(
      withPathLock(storePath, async () => {
        expect(JSON.parse(await fs.readFile(lockPath, "utf8"))).toEqual(
          expect.objectContaining({ version: 1, pid: process.pid }),
        );
        return "saved";
      }),
    ).resolves.toBe("saved");
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });

    const failure = new Error("Operation failed before replacing the snapshot");
    await expect(
      withPathLock(storePath, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await repo.countAll()).toBe(0);
  });

  it("times out without stealing an old lock or invoking the operation", async () => {
    const lockPath = storePath + ".lock";
    const owner = JSON.stringify({
      version: 1,
      pid: process.pid,
      createdAt: 0,
    });
    const snapshot = await fs.readFile(storePath, "utf8");
    await fs.writeFile(lockPath, owner);
    await fs.utimes(lockPath, new Date(0), new Date(0));
    const operation = vi.fn(async () => "must not run");
    const started = performance.now();

    await expect(withPathLock(storePath, operation)).rejects.toMatchObject({
      name: "ReviewStoreLockTimeoutError",
    });
    expect(performance.now() - started).toBeGreaterThanOrEqual(4_900);
    expect(operation).not.toHaveBeenCalled();
    expect(await fs.readFile(lockPath, "utf8")).toBe(owner);
    expect((await fs.stat(lockPath)).mtimeMs).toBe(0);
    expect(await fs.readFile(storePath, "utf8")).toBe(snapshot);

    // Explicit recovery after confirming ownership; the library never steals it.
    await fs.unlink(lockPath);
    expect(await repo.countAll()).toBe(0);
  }, 10_000);

  it("propagates setup failures without invoking the operation", async () => {
    const parentFile = path.join(path.dirname(storePath), "not-a-directory");
    await fs.writeFile(parentFile, "existing bytes");
    const operation = vi.fn(async () => "must not run");
    await expect(
      withPathLock(path.join(parentFile, "reviews.json"), operation),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^(EEXIST|ENOTDIR)$/),
    });
    expect(operation).not.toHaveBeenCalled();
    expect(await fs.readFile(parentFile, "utf8")).toBe("existing bytes");
  });

  it("leaves a replacement owner's lock in place during cleanup", async () => {
    const lockPath = storePath + ".lock";
    const replacement = JSON.stringify({ owner: "replacement" });
    await expect(
      withPathLock(storePath, async () => {
        await fs.rename(lockPath, lockPath + ".original");
        await fs.writeFile(lockPath, replacement);
      }),
    ).rejects.toThrow("lock ownership changed");
    expect(await fs.readFile(lockPath, "utf8")).toBe(replacement);
  });

  it("retains operation and cleanup failures together", async () => {
    const lockPath = storePath + ".lock";
    const failure = new Error("Original operation failure");
    let rejected: unknown;
    try {
      await withPathLock(storePath, async () => {
        await fs.rename(lockPath, lockPath + ".original");
        await fs.writeFile(lockPath, "replacement owner");
        throw failure;
      });
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(AggregateError);
    expect((rejected as AggregateError).errors).toEqual([
      failure,
      expect.objectContaining({
        message: expect.stringContaining("lock ownership changed"),
      }),
    ]);
    expect(await fs.readFile(lockPath, "utf8")).toBe("replacement owner");
  });

  it("allows operations on different paths to progress independently", async () => {
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = withPathLock(storePath, async () => {
      entered();
      await released;
    });
    await ready;
    try {
      await expect(
        withPathLock(storePath + ".other", async () => "independent"),
      ).resolves.toBe("independent");
    } finally {
      release();
      await held;
    }
  });
});
