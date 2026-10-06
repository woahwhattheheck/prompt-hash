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

import { SubmitPromptReport, UpdatePromptReportStatus } from "./controllers";
import express from "express";
import request from "supertest";
import connectDb from "../db/connectDb";
import { promptRouter } from "../routes/promptRoutes";
import {
  clearAdminPrincipalRevocations,
  revokeAdminPrincipalToken,
  signAdminPrincipalToken,
} from "../auth/adminPrincipal";
import { REPORT_REVIEW_AUDIENCE } from "../auth/reportReviewAuth";

const app = express();
app.use(express.json());
app.use("/api/prompts", promptRouter);

function adminToken(
  overrides: Partial<Parameters<typeof signAdminPrincipalToken>[0]> = {},
) {
  return signAdminPrincipalToken({
    sub: "Ops-A",
    roles: ["admin"],
    aud: REPORT_REVIEW_AUDIENCE,
    ...overrides,
  });
}

function storedReport() {
  return {
    _id: "report-1",
    status: "pending",
    reporterAddress: "synthetic-private-reporter",
    reporterPrivate: true,
    statusHistory: [] as unknown[],
    save: mockReportSave,
    toObject() {
      return { ...this };
    },
  };
}

const makeRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  process.env.ADMIN_API_KEY = "admin-secret-key";
  process.env.ADMIN_WALLET_ADDRESS = "gadmin";
  process.env.PUBLIC_STELLAR_SIMULATION_ACCOUNT = "gadmin";
  process.env.ADMIN_PRINCIPAL_SECRET =
    "test-only-report-principal-secret-32-characters";
  clearAdminPrincipalRevocations();
  mockPromptFindById.mockResolvedValue({ _id: "prompt-1", onChainId: "42" });
  mockPromptFindOne.mockResolvedValue({ _id: "prompt-1", onChainId: "42" });
  mockReportFindOne.mockResolvedValue(null);
  mockReportFind.mockReturnValue([storedReport()]);
  mockReportFindById.mockImplementation(async () => storedReport());
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
      expect.objectContaining({
        error: expect.stringMatching(/Unsafe|scheme|data/i),
      }),
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

  it("returns 409 when a concurrent submit loses the unique-index race", async () => {
    mockReportFindOne.mockResolvedValueOnce(null);
    mockReportSave.mockRejectedValueOnce(
      Object.assign(new Error("E11000 duplicate key"), { code: 11000 }),
    );
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
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringMatching(/open report already exists/i),
      }),
    );
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
      headers: { authorization: `Bearer ${adminToken()}` },
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
      headers: { authorization: `Bearer ${adminToken()}` },
      body: { status: "dismissed", actor: "gadmin" },
    };
    const res = makeRes();
    await UpdatePromptReportStatus(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(report.save).not.toHaveBeenCalled();
  });

  it("returns 409 when reopening collides with another open report", async () => {
    const report = storedReport() as any;
    report.status = "resolved";
    mockReportFindById.mockResolvedValueOnce(report);
    mockReportSave.mockRejectedValueOnce(
      Object.assign(new Error("E11000 duplicate key"), { code: 11000 }),
    );

    const req: any = {
      params: { id: "report-1" },
      headers: { authorization: `Bearer ${adminToken()}` },
      body: { status: "investigating" },
    };
    const res = makeRes();

    await UpdatePromptReportStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringMatching(/open report already exists/i),
      }),
    );
  });
});

describe("report moderator authorization through the HTTP router", () => {
  it.each(["get", "patch", "post"] as const)(
    "rejects a public admin address on %s before opening the database",
    async (method) => {
      const http = request(app);
      const response =
        method === "get"
          ? await http.get("/api/prompts/reports?adminAddress=gadmin")
          : await http[method](
              method === "patch"
                ? "/api/prompts/reports/report-1"
                : "/api/prompts/reports/report-1/status",
            ).send({
              status: "investigating",
              actor: "gadmin",
              adminAddress: "gadmin",
            });
      expect(response.status).toBe(401);
      expect(response.body.code).toBe("missing_credentials");
      expect(connectDb).not.toHaveBeenCalled();
      expect(mockReportFind).not.toHaveBeenCalled();
      expect(mockReportFindById).not.toHaveBeenCalled();
      expect(mockReportSave).not.toHaveBeenCalled();
      expect(JSON.stringify(response.body)).not.toContain(
        "synthetic-private-reporter",
      );
    },
  );

  it("rejects the old default key and body-secret credentials", async () => {
    delete process.env.ADMIN_API_KEY;
    const legacy = await request(app)
      .get("/api/prompts/reports")
      .set("Authorization", "Bearer admin-secret-key");
    expect(legacy.status).toBe(401);

    process.env.ADMIN_API_KEY = "configured-legacy-admin-key";
    const bodySecret = await request(app)
      .post("/api/prompts/reports/report-1/status")
      .send({
        status: "investigating",
        actor: "gadmin",
        adminSecretKey: "configured-legacy-admin-key",
      });
    expect(bodySecret.status).toBe(401);
    expect(connectDb).not.toHaveBeenCalled();
    expect(mockReportSave).not.toHaveBeenCalled();
  });

  it.each(["forged", "expired", "revoked", "wrong-audience"] as const)(
    "rejects a %s principal on both reads and writes before database access",
    async (kind) => {
      const now = Date.now();
      jest.spyOn(Date, "now").mockReturnValue(now);
      let token = adminToken({ now, jti: "report-auth-case" });
      if (kind === "forged")
        token = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
      if (kind === "expired")
        token = adminToken({ now: now - 1000, ttlMs: 1000 });
      if (kind === "revoked") revokeAdminPrincipalToken("report-auth-case");
      if (kind === "wrong-audience")
        token = adminToken({ aud: "unrelated-api" });

      const read = await request(app)
        .get("/api/prompts/reports?adminAddress=gadmin")
        .set("Authorization", `Bearer ${token}`);
      const write = await request(app)
        .post("/api/prompts/reports/report-1/status")
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "investigating", actor: "gadmin" });
      expect(read.status).toBe(401);
      expect(write.status).toBe(401);
      expect(connectDb).not.toHaveBeenCalled();
      expect(mockReportFind).not.toHaveBeenCalled();
      expect(mockReportFindById).not.toHaveBeenCalled();
      expect(mockReportSave).not.toHaveBeenCalled();
    },
  );

  it("fails closed when principal credentials are not configured", async () => {
    const token = adminToken();
    delete process.env.ADMIN_PRINCIPAL_SECRET;
    const response = await request(app)
      .get("/api/prompts/reports?adminAddress=gadmin")
      .set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(401);
    expect(connectDb).not.toHaveBeenCalled();
  });

  it("allows signed admin and report-reviewer reads of the private queue", async () => {
    for (const role of ["admin", "report_reviewer"]) {
      const response = await request(app)
        .get("/api/prompts/reports")
        .set("Authorization", `Bearer ${adminToken({ roles: [role] })}`);
      expect(response.status).toBe(200);
      expect(response.body[0].reporterAddress).toBe(
        "synthetic-private-reporter",
      );
    }
    expect(connectDb).toHaveBeenCalledTimes(2);
    expect(mockReportSave).not.toHaveBeenCalled();
  });

  it("denies a viewer on reads and writes and a report reviewer on writes", async () => {
    const viewer = adminToken({ roles: ["viewer"] });
    const read = await request(app)
      .get("/api/prompts/reports?adminAddress=gadmin")
      .set("Authorization", `Bearer ${viewer}`);
    expect(read.status).toBe(403);
    for (const roles of [["viewer"], ["report_reviewer"]]) {
      const response = await request(app)
        .post("/api/prompts/reports/report-1/status")
        .set("Authorization", `Bearer ${adminToken({ roles })}`)
        .send({ status: "investigating", actor: "gadmin" });
      expect(response.status).toBe(403);
    }
    expect(connectDb).not.toHaveBeenCalled();
    expect(mockReportSave).not.toHaveBeenCalled();
  });

  it("uses the signed admin identity on both status routes, ignoring supplied actors", async () => {
    const http = request(app);
    for (const method of ["patch", "post"] as const) {
      const report = storedReport();
      mockReportFindById.mockResolvedValueOnce(report);
      const response = await http[method](
        method === "patch"
          ? "/api/prompts/reports/report-1"
          : "/api/prompts/reports/report-1/status",
      )
        .set("Authorization", `Bearer ${adminToken()}`)
        .send(
          method === "patch"
            ? {
                status: "investigating",
                actor: "claimed-imposter",
                adminAddress: "gadmin",
              }
            : { status: "investigating" },
        );
      expect(response.status).toBe(200);
      expect(report.status).toBe("investigating");
      expect(report.statusHistory).toHaveLength(1);
      expect(report.statusHistory[0]).toEqual(
        expect.objectContaining({ actor: "Ops-A" }),
      );
      expect(response.body.report.moderatedBy).toBe("Ops-A");
    }
    expect(mockReportSave).toHaveBeenCalledTimes(2);
  });
});
