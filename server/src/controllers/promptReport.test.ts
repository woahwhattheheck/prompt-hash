/**
 * Tests for prompt abuse report controllers (Issue #241).
 */

jest.mock("../db/connectDb", () => jest.fn().mockResolvedValue(undefined));

const mockPromptFindById = jest.fn();
const mockPromptFindOne = jest.fn();
jest.mock("../models/Prompt", () => ({
  __esModule: true,
  default: {
    findById: (...args: unknown[]) => mockPromptFindById(...args),
    findOne: (...args: unknown[]) => mockPromptFindOne(...args),
  },
}));

const mockReportFindOne = jest.fn();
const mockReportFind = jest.fn();
const mockReportFindById = jest.fn();
const mockReportSave = jest.fn();

jest.mock("../models/Report", () => {
  function MockReport(this: any, data: any) {
    Object.assign(this, data);
    this._id = "report-new";
    this.status = data.status || "pending";
    this.statusHistory = data.statusHistory || [];
    this.save = mockReportSave.mockResolvedValue(this);
    this.toObject = () => ({ ...this });
  }
  MockReport.findOne = (...args: unknown[]) => {
    const result = mockReportFindOne(...args);
    return {
      lean: async () => result,
      then: (resolve: any, reject: any) =>
        Promise.resolve(result).then(resolve, reject),
    };
  };
  MockReport.find = (...args: unknown[]) => {
    const result = mockReportFind(...args);
    return {
      sort: () => Promise.resolve(result),
    };
  };
  MockReport.findById = (...args: unknown[]) => mockReportFindById(...args);
  return { __esModule: true, default: MockReport };
});

jest.mock("../models/User", () => ({ __esModule: true, default: {} }));
jest.mock("../models/AuditLog", () => ({ AuditLog: {} }));
jest.mock("../models/PreviewEvent", () => ({ PreviewEvent: {} }));
jest.mock("../services/listingValidation", () => ({
  validateListingMetadata: jest.fn(),
}));
jest.mock("../services/cacheService", () => ({
  cacheGetOrLoad: jest.fn(),
  cacheDel: jest.fn(),
  cacheDelPattern: jest.fn(),
  CACHE_KEYS: {},
}));
jest.mock("../services/auditTrail", () => ({
  hashWalletAddress: jest.fn((a: string) => a),
}));
jest.mock("../services/previewAnalytics", () => ({
  issuePreviewToken: jest.fn(),
  recordPreviewEvent: jest.fn(),
}));
jest.mock("../utils/proxyLogger", () => ({
  generateRequestId: jest.fn(() => "req"),
  logProxyException: jest.fn(),
  logProxySuccess: jest.fn(),
  logProxyUpstreamError: jest.fn(),
}));
jest.mock("../config/stellar", () => ({ stellarConfig: {} }));
jest.mock("ai", () => ({ streamText: jest.fn() }));
jest.mock("@ai-sdk/openai", () => ({ openai: jest.fn() }));

import {
  SubmitPromptReport,
  UpdatePromptReportStatus,
} from "./controllers";

const makeRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ADMIN_API_KEY = "admin-secret-key";
  process.env.ADMIN_WALLET_ADDRESS = "gadmin";
  mockPromptFindById.mockResolvedValue({ _id: "prompt-1", onChainId: "42" });
  mockPromptFindOne.mockResolvedValue({ _id: "prompt-1", onChainId: "42" });
  mockReportFindOne.mockResolvedValue(null);
  mockReportSave.mockImplementation(async function (this: any) {
    return this;
  });
});

describe("SubmitPromptReport", () => {
  it("rejects unsafe evidence with 400", async () => {
    const req: any = {
      body: {
        promptId: "prompt-1",
        reporterAddress: "GABC",
        reason: "harmful-content",
        evidence: [{ kind: "url_ref", ref: "data:text/plain,nope" }],
      },
    };
    const res = makeRes();
    await SubmitPromptReport(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringMatching(/Unsafe|scheme|data/i) }),
    );
  });

  it("returns 409 on duplicate open reports", async () => {
    mockReportFindOne.mockResolvedValueOnce({
      _id: "existing",
      status: "pending",
    });
    const req: any = {
      body: {
        promptId: "prompt-1",
        reporterAddress: "GABC",
        reason: "plagiarism",
      },
    };
    const res = makeRes();
    await SubmitPromptReport(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it("creates a report with normalized evidence", async () => {
    const req: any = {
      body: {
        promptId: "prompt-1",
        reporterAddress: "GABC",
        reason: "copyright",
        evidence: [{ kind: "content_hash", ref: "a".repeat(64) }],
      },
    };
    const res = makeRes();
    await SubmitPromptReport(req, res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        evidenceCount: 1,
        status: "pending",
      }),
    );
  });
});

describe("UpdatePromptReportStatus", () => {
  it("updates status and appends history", async () => {
    const report: any = {
      _id: "r1",
      status: "pending",
      statusHistory: [],
      save: jest.fn().mockResolvedValue(undefined),
      toObject() {
        return { ...this };
      },
    };
    mockReportFindById.mockResolvedValue(report);

    const req: any = {
      params: { id: "r1" },
      headers: { authorization: "Bearer admin-secret-key" },
      body: {
        status: "investigating",
        actor: "gadmin",
        notes: "triage started",
      },
    };
    const res = makeRes();
    await UpdatePromptReportStatus(req, res);

    expect(report.status).toBe("investigating");
    expect(report.statusHistory).toHaveLength(1);
    expect(report.save).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("rejects illegal transitions", async () => {
    const report: any = {
      _id: "r1",
      status: "resolved",
      statusHistory: [],
      save: jest.fn(),
      toObject() {
        return { ...this };
      },
    };
    mockReportFindById.mockResolvedValue(report);

    const req: any = {
      params: { id: "r1" },
      headers: { authorization: "Bearer admin-secret-key" },
      body: { status: "dismissed", actor: "gadmin" },
    };
    const res = makeRes();
    await UpdatePromptReportStatus(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(report.save).not.toHaveBeenCalled();
  });
});
