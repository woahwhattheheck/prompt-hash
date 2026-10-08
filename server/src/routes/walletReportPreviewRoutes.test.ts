/** Owner-only analytics and signed reporter attribution for issue #144. */
import express from "express";
import request from "supertest";

jest.mock("../auth/walletPrincipalHttp", () => ({
  requireWalletPrincipal: (req: any, res: any, next: any) => {
    const principal = req.headers["x-test-wallet"];
    if (!principal) return res.status(401).json({ error: "Wallet session required." });
    res.locals.walletPrincipal = { address: principal };
    next();
  },
}));
jest.mock("../db/connectDb", () => jest.fn().mockResolvedValue(undefined));
jest.mock("../models/User", () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock("../models/Prompt", () => ({
  __esModule: true, default: { findById: jest.fn(), findOne: jest.fn(), find: jest.fn() },
}));
jest.mock("../models/Report", () => ({
  __esModule: true,
  default: Object.assign(jest.fn().mockImplementation(() => ({ save: jest.fn() })), { find: jest.fn() }),
}));
jest.mock("../models/Purchase", () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock("../models/AuditLog", () => ({ AuditLog: { create: jest.fn() } }));
jest.mock("../models/PreviewEvent", () => ({
  __esModule: true, PreviewEvent: { aggregate: jest.fn() },
}));
jest.mock("../services/cacheService", () => ({
  cacheGetOrLoad: jest.fn(),
  cacheDel: jest.fn(), cacheDelPattern: jest.fn(),
  CACHE_KEYS: { promptList: (key: string) => key },
}));
jest.mock("../services/creatorPrivacy", () => ({
  CREATOR_DRAFTS_READ: "creator_drafts_read",
  CREATOR_OWNED_READ: "creator_owned_read",
  requireCreatorReadSession: jest.fn(),
  mapPromptsPrivate: jest.fn(),
  mapPromptsPublic: jest.fn(),
}));
jest.mock("../services/previewAnalytics", () => ({
  issuePreviewToken: jest.fn(() => "preview-token"),
  recordPreviewEvent: jest.fn(),
}));
jest.mock("../services/listingValidation", () => ({ validateListingMetadata: jest.fn() }));
jest.mock("../utils/proxyLogger", () => ({
  generateRequestId: jest.fn(), logProxyException: jest.fn(),
  logProxySuccess: jest.fn(), logProxyUpstreamError: jest.fn(),
}));
jest.mock("../config/stellar", () => ({ stellarConfig: {} }));

import User from "../models/User";
import Prompt from "../models/Prompt";
import Report from "../models/Report";
import { PreviewEvent } from "../models/PreviewEvent";
import { promptRouter } from "./promptRoutes";

const WALLET = "GSessionOwner";
const OTHER = "GAnotherWallet";
const SAMPLE = "507f1f77bcf86cd799439011";
const ADMIN_REPORT_TOKEN = "trusted-report-admin-token-at-least-32-bytes-long";
const originalAdminToken = process.env.REPORT_ADMIN_TOKEN;
function app() {
  const server = express();
  server.use(express.json());
  server.use("/api/prompts", promptRouter);
  return server;
}
beforeEach(() => jest.clearAllMocks());
afterAll(() => {
  if (originalAdminToken === undefined) delete process.env.REPORT_ADMIN_TOKEN;
  else process.env.REPORT_ADMIN_TOKEN = originalAdminToken;
});

describe("wallet report and preview session boundaries", () => {
  it("rejects unauthenticated private preview analytics and report writes", async () => {
    const server = app();
    const stat = await request(server).get("/api/prompts/preview/stats?walletAddress=" + OTHER);
    const report = await request(server).post("/api/prompts/reports")
      .send({ promptId: SAMPLE, reporterAddress: OTHER, reason: "other" });
    expect([stat.status, report.status]).toEqual([401, 401]);
    expect(User.findOne).not.toHaveBeenCalled();
    expect(Prompt.findById).not.toHaveBeenCalled();
  });

  it("denies cross-wallet report and analytics selectors before database access", async () => {
    const server = app();
    const stat = await request(server).get("/api/prompts/preview/stats?walletAddress=" + OTHER)
      .set("X-Test-Wallet", WALLET);
    const report = await request(server).post("/api/prompts/reports")
      .set("X-Test-Wallet", WALLET)
      .send({ promptId: SAMPLE, reporterAddress: OTHER, reason: "other" });
    expect([stat.status, report.status]).toEqual([403, 403]);
    expect(User.findOne).not.toHaveBeenCalled();
    expect(Prompt.findById).not.toHaveBeenCalled();
  });

  it("queries only the authenticated creator's preview analytics", async () => {
    (User.findOne as jest.Mock).mockResolvedValue({ _id: "owner1" });
    (Prompt.find as jest.Mock).mockReturnValue({
      select: () => ({ sort: async () => [{ _id: SAMPLE, previewCount: 2 }] }),
    });
    (PreviewEvent.aggregate as jest.Mock).mockResolvedValue([]);
    const stat = await request(app()).get("/api/prompts/preview/stats")
      .set("X-Test-Wallet", WALLET);
    expect(stat.status).toBe(200);
    expect(User.findOne).toHaveBeenCalledWith({ walletAddress: WALLET.toLowerCase() });
    expect(Prompt.find).toHaveBeenCalledWith({ owner: "owner1" });
  });

  it("persists a report with verified signer identity, not a request wallet", async () => {
    (Prompt.findById as jest.Mock).mockResolvedValue({ _id: SAMPLE });
    const result = await request(app()).post("/api/prompts/reports")
      .set("X-Test-Wallet", WALLET)
      .send({ promptId: SAMPLE, reason: "quality-issue", description: "needs attention" });
    expect(result.status).toBe(201);
    expect(Report).toHaveBeenCalledWith(expect.objectContaining({
      promptId: SAMPLE,
      reporterAddress: WALLET.toLowerCase(),
      reason: "quality-issue",
    }));
  });

  it("denies report enumeration when admin credentials are not configured", async () => {
    delete process.env.REPORT_ADMIN_TOKEN;
    const result = await request(app()).get("/api/prompts/reports?promptId=" + SAMPLE)
      .set("Authorization", "Bearer arbitrary-token");
    expect(result.status).toBe(503);
    expect(Report.find).not.toHaveBeenCalled();
  });

  it("rejects a signed wallet or unknown bearer as report-admin authority", async () => {
    process.env.REPORT_ADMIN_TOKEN = ADMIN_REPORT_TOKEN;
    const wallet = await request(app()).get("/api/prompts/reports")
      .set("X-Test-Wallet", WALLET);
    const forged = await request(app()).get("/api/prompts/reports")
      .set("Authorization", "Bearer arbitrary-token");
    expect([wallet.status, forged.status]).toEqual([401, 403]);
    expect(Report.find).not.toHaveBeenCalled();
  });

  it("does not let the independent fulfillment token read private reports", async () => {
    process.env.REPORT_ADMIN_TOKEN = ADMIN_REPORT_TOKEN;
    process.env.FULFILLMENT_SERVICE_TOKEN = "not-the-report-admin-token-value-of-adequate-length";
    const result = await request(app()).get("/api/prompts/reports")
      .set("Authorization", `Bearer ${process.env.FULFILLMENT_SERVICE_TOKEN}`);
    expect(result.status).toBe(403);
    expect(Report.find).not.toHaveBeenCalled();
    delete process.env.FULFILLMENT_SERVICE_TOKEN;
  });

  it("reads exactly the requested report set using a trusted admin token and relative URL", async () => {
    process.env.REPORT_ADMIN_TOKEN = ADMIN_REPORT_TOKEN;
    (Report.find as jest.Mock).mockReturnValue({
      sort: jest.fn().mockResolvedValue([{ promptId: SAMPLE, reason: "quality-issue" }]),
    });
    const result = await request(app()).get("/api/prompts/reports?promptId=" + SAMPLE)
      .set("Authorization", `Bearer ${ADMIN_REPORT_TOKEN}`);
    expect(result.status).toBe(200);
    expect(result.body).toEqual([{ promptId: SAMPLE, reason: "quality-issue" }]);
    expect(Report.find).toHaveBeenCalledWith({ promptId: SAMPLE });
  });

  it("preserves the anonymous public preview-token lookup", async () => {
    (Prompt.findOne as jest.Mock).mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: SAMPLE }),
    });
    const result = await request(app()).get("/api/prompts/preview/token?promptId=" + SAMPLE);
    expect(result.status).toBe(200);
    expect(result.body.token).toBe("preview-token");
  });
});
