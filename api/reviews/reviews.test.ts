// @vitest-environment node

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

const hasAccessMock = vi.fn();

vi.mock("../../src/lib/stellar/promptHashClient", () => ({
  hasAccess: (...args: unknown[]) => hasAccessMock(...args),
}));

import submitHandler from "./submit";
import listHandler from "./list";
import reportHandler from "./report";
import moderateHandler from "./moderate";
import {
  configureReviewRepository,
  createFileReviewRepository,
  resetReviewStore,
  addReview,
} from "../../src/lib/reviews/reviewStore";

function mockReqRes(
  method: string,
  body: Record<string, unknown> = {},
  query: Record<string, string> = {},
  headers: Record<string, string> = {},
) {
  let statusCode = 0;
  let responseData: any = {};

  const req = {
    method,
    body,
    query,
    headers,
  };

  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(data: any) {
      responseData = data;
      return this;
    },
  };

  return { req, res, getStatus: () => statusCode, getData: () => responseData };
}

describe("Review Moderation Workflow API (#41 / #179)", () => {
  let storePath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    storePath = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "ph-api-reviews-")),
      "reviews.json",
    );
    configureReviewRepository(createFileReviewRepository(storePath));
    await resetReviewStore();
    process.env.ADMIN_WALLET_ADDRESS =
      "GADMINADDRESS1234567890ABCDEFGH1234567890ABCDEFGH1234567890";
    process.env.ADMIN_API_KEY = "admin-secret-key";
  });

  afterEach(async () => {
    configureReviewRepository(null);
    try {
      await fs.rm(path.dirname(storePath), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("prevents duplicate reviews from the same wallet for the same prompt", async () => {
    hasAccessMock.mockResolvedValue(true);

    const wallet = "GBUYER1234567890ABCDEFGH1234567890ABCDEFGH1234567890";
    const promptId = "99";

    const { req: req1, res: res1, getStatus: status1 } = mockReqRes("POST", {
      promptId,
      userAddress: wallet,
      rating: 5,
      text: "Great prompt for documentation generation!",
    });
    await submitHandler(req1, res1);
    expect(status1()).toBe(201);

    const { req: req2, res: res2, getStatus: status2, getData: data2 } = mockReqRes("POST", {
      promptId,
      userAddress: wallet,
      rating: 4,
      text: "Trying to review again with a different text.",
    });
    await submitHandler(req2, res2);
    expect(status2()).toBe(409);
    expect(data2().error).toContain("already reviewed");
  });

  it("allows buyers to report a review and flags it for moderation", async () => {
    const promptId = "1";
    const review = await addReview(
      promptId,
      "GORIGINALREVIEWER",
      5,
      "Fixture review used for report workflow coverage.",
    );
    const reporter = "GREPORTER1234567890ABCDEFGH1234567890ABCDEFGH1234567890";

    const { req, res, getStatus, getData } = mockReqRes("POST", {
      reviewId: review.id,
      promptId,
      reporterAddress: reporter,
      reason: "This review contains inappropriate spam.",
    });

    await reportHandler(req, res);
    expect(getStatus()).toBe(200);
    expect(getData().success).toBe(true);
    expect(getData().status).toBe("flagged");
  });

  it("allows maintainer/admin to hide a review and excludes it from public lists", async () => {
    const promptId = "1";
    const review = await addReview(
      promptId,
      "GORIGINALREVIEWER",
      4,
      "Fixture review that maintainers can hide from lists.",
    );
    const admin = "GADMINADDRESS1234567890ABCDEFGH1234567890ABCDEFGH1234567890";

    const { req: modReq, res: modRes, getStatus: modStatus } = mockReqRes("POST", {
      reviewId: review.id,
      promptId,
      action: "hide",
      adminAddress: admin,
    });
    await moderateHandler(modReq, modRes);
    expect(modStatus()).toBe(200);

    const {
      req: listReq,
      res: listRes,
      getStatus: listStatus,
      getData: listData,
    } = mockReqRes("GET", {}, { promptId: "1" });
    await listHandler(listReq, listRes);

    expect(listStatus()).toBe(200);
    const reviewIds = listData().reviews.map((r: any) => r.id);
    expect(reviewIds).not.toContain(review.id);
  });

  it("rejects unauthorized users trying to moderate reviews", async () => {
    const review = await addReview(
      "1",
      "GORIGINALREVIEWER",
      3,
      "Fixture review for unauthorized moderation attempts.",
    );

    const { req, res, getStatus, getData } = mockReqRes("POST", {
      reviewId: review.id,
      promptId: "1",
      action: "hide",
      adminAddress: "GUNAUTHORIZED1234567890ABCDEFGH1234567890ABCDEFGH1234567890",
    });

    await moderateHandler(req, res);

    expect(getStatus()).toBe(403);
    expect(getData().error).toContain("Unauthorized");
  });
});
