/**
 * Report listing access — auth gate, DTO projection, audit (#146).
 */

jest.mock("../db/connectDb", () => jest.fn().mockResolvedValue(undefined));

const mockFind = jest.fn();
const mockSort = jest.fn();
const mockLean = jest.fn();

jest.mock("../models/Report", () => ({
  __esModule: true,
  default: { find: mockFind },
}));

import {
  ADMIN_ROLE,
  REPORT_REVIEWER_ROLE,
  clearAdminPrincipalRevocations,
  revokeAdminPrincipalToken,
  signAdminPrincipalToken,
} from "../auth/adminPrincipal";
import { REPORT_REVIEW_AUDIENCE } from "../auth/reportReviewAuth";
import {
  listPromptReportsForReview,
  setReportAccessAuditSink,
  toReportReviewDto,
} from "./reportAccess";

const SECRET = "test-admin-principal-secret-00000002";
const NOW = 1_700_000_000_000;

function reviewerBearer(overrides?: {
  roles?: string[];
  sub?: string;
  jti?: string;
  ttlMs?: number;
  aud?: string;
}): string {
  const token = signAdminPrincipalToken({
    sub: overrides?.sub ?? "reviewer-1",
    roles: overrides?.roles ?? [REPORT_REVIEWER_ROLE],
    now: NOW,
    ttlMs: overrides?.ttlMs,
    jti: overrides?.jti,
    aud: overrides?.aud ?? REPORT_REVIEW_AUDIENCE,
  });
  return `Bearer ${token}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ADMIN_PRINCIPAL_SECRET = SECRET;
  clearAdminPrincipalRevocations();
  setReportAccessAuditSink(null);
  mockFind.mockReturnValue({ sort: mockSort });
  mockSort.mockReturnValue({ lean: mockLean });
  mockLean.mockResolvedValue([]);
});

afterAll(() => {
  delete process.env.ADMIN_PRINCIPAL_SECRET;
});

describe("toReportReviewDto — field projection", () => {
  it("projects only allowlisted fields and drops internals", () => {
    const dto = toReportReviewDto({
      _id: "abc123",
      __v: 7,
      promptId: "p1",
      reporterAddress: "g1reporter",
      reason: "plagiarism",
      description: "copied listing",
      status: "pending",
      adminNotes: "looks real",
      resolvedAt: null,
      createdAt: new Date("2024-01-01T00:00:00Z"),
      updatedAt: new Date("2024-01-02T00:00:00Z"),
      internalSecret: "should-not-leak",
    });

    expect(dto).toEqual({
      id: "abc123",
      promptId: "p1",
      reporterAddress: "g1reporter",
      reason: "plagiarism",
      description: "copied listing",
      status: "pending",
      adminNotes: "looks real",
      resolvedAt: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
    });
    expect(dto).not.toHaveProperty("__v");
    expect(dto).not.toHaveProperty("internalSecret");
    expect(dto).not.toHaveProperty("_id");
  });
});

describe("listPromptReportsForReview", () => {
  it("rejects the former bypass: any non-empty bearer", async () => {
    const result = await listPromptReportsForReview({
      authorizationHeader: "Bearer not-a-real-token",
      now: NOW,
    });
    expect(result.status).toBe(401);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it("rejects expired tokens before querying", async () => {
    const result = await listPromptReportsForReview({
      authorizationHeader: reviewerBearer({ ttlMs: 1 }),
      now: NOW + 60_000,
    });
    expect(result.status).toBe(401);
    expect((result.body as { code: string }).code).toBe("expired_token");
    expect(mockFind).not.toHaveBeenCalled();
  });

  it("rejects revoked tokens before querying", async () => {
    const auth = reviewerBearer({ jti: "dead-jti" });
    revokeAdminPrincipalToken("dead-jti");
    const result = await listPromptReportsForReview({
      authorizationHeader: auth,
      now: NOW,
    });
    expect(result.status).toBe(401);
    expect((result.body as { code: string }).code).toBe("revoked_token");
    expect(mockFind).not.toHaveBeenCalled();
  });

  it("rejects wrong-role principals with 403", async () => {
    const result = await listPromptReportsForReview({
      authorizationHeader: reviewerBearer({ roles: ["analytics_viewer"] }),
      now: NOW,
    });
    expect(result.status).toBe(403);
    expect((result.body as { code: string }).code).toBe("forbidden");
    expect(mockFind).not.toHaveBeenCalled();
  });

  it("allows a valid report_reviewer and returns allowlisted DTOs", async () => {
    mockLean.mockResolvedValueOnce([
      {
        _id: "r1",
        __v: 0,
        promptId: "prompt-9",
        reporterAddress: "greporter",
        reason: "harmful-content",
        description: "bad stuff",
        status: "pending",
        adminNotes: "",
        resolvedAt: null,
        createdAt: new Date("2024-06-01T00:00:00Z"),
        updatedAt: new Date("2024-06-01T00:00:00Z"),
        extra: "nope",
      },
    ]);

    const audits: Array<Record<string, unknown>> = [];
    setReportAccessAuditSink((e) => audits.push(e));

    const result = await listPromptReportsForReview({
      authorizationHeader: reviewerBearer(),
      promptId: "prompt-9",
      now: NOW,
      requestId: "req-1",
    });

    expect(result.status).toBe(200);
    expect(mockFind).toHaveBeenCalledWith({ promptId: "prompt-9" });
    const body = result.body as { reports: Array<Record<string, unknown>> };
    expect(body.reports).toHaveLength(1);
    expect(body.reports[0]).toMatchObject({
      id: "r1",
      promptId: "prompt-9",
      reporterAddress: "greporter",
      reason: "harmful-content",
    });
    expect(body.reports[0]).not.toHaveProperty("__v");
    expect(body.reports[0]).not.toHaveProperty("extra");

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "report_review_access",
      result: "success",
      count: 1,
      requestId: "req-1",
    });
    expect(audits[0].actorHash).toMatch(/^[a-f0-9]{16}$/);
  });

  it("allows admin role as a valid reviewer", async () => {
    mockLean.mockResolvedValueOnce([]);
    const result = await listPromptReportsForReview({
      authorizationHeader: reviewerBearer({
        roles: [ADMIN_ROLE],
        sub: "admin-ops",
      }),
      now: NOW,
    });
    expect(result.status).toBe(200);
    expect(mockFind).toHaveBeenCalled();
  });

  it("audits denials without leaking credentials", async () => {
    const audits: Array<Record<string, unknown>> = [];
    setReportAccessAuditSink((e) => audits.push(e));
    await listPromptReportsForReview({
      authorizationHeader: "Bearer super-secret-value-should-not-appear",
      now: NOW,
      requestId: "deny-1",
    });
    expect(audits[0].action).toBe("report_review_denied");
    expect(JSON.stringify(audits[0])).not.toContain("super-secret-value");
  });
});
