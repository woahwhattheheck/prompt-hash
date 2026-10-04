import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../server/src/models/Appeal", () => ({
  default: {
    create: vi.fn(),
    findById: vi.fn(),
    find: vi.fn(),
    findByIdAndUpdate: vi.fn(),
    countDocuments: vi.fn(),
    aggregate: vi.fn(),
  },
}));

import Appeal from "../../server/src/models/Appeal";
import {
  createAppeal,
  getAppeal,
  listAppeals,
  updateAppealStatus,
  getAppealStats,
} from "../../server/src/controllers/appealController";

function mockReq(overrides: Record<string, unknown> = {}) {
  return {
    body: {},
    params: {},
    query: {},
    ...overrides,
  } as any;
}

function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createAppeal", () => {
  it("returns 400 if required fields are missing", async () => {
    const req = mockReq({ body: {} });
    const res = mockRes();
    await createAppeal(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("creates an appeal with valid fields", async () => {
    const mockAppeal = { _id: "appeal1", promptId: "42", status: "flagged" };
    (Appeal.create as any).mockResolvedValue(mockAppeal);
    const req = mockReq({
      body: {
        promptId: "42",
        reporterAddress: "GABC",
        creatorAddress: "GXYZ",
        similarityScore: 0.95,
        contentCommitment: "abc123",
        fingerprintHash: "def456",
      },
    });
    const res = mockRes();
    await createAppeal(req, res);
    expect(Appeal.create).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(mockAppeal);
  });
});

describe("getAppeal", () => {
  it("returns 404 for unknown id", async () => {
    (Appeal.findById as any).mockResolvedValue(null);
    const req = mockReq({ params: { id: "nonexistent" } });
    const res = mockRes();
    await getAppeal(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns appeal for valid id", async () => {
    const appeal = { _id: "abc", promptId: "42" };
    (Appeal.findById as any).mockResolvedValue(appeal);
    const req = mockReq({ params: { id: "abc" } });
    const res = mockRes();
    await getAppeal(req, res);
    expect(res.json).toHaveBeenCalledWith(appeal);
  });
});

describe("updateAppealStatus", () => {
  it("updates status to notified", async () => {
    const updated = { _id: "abc", status: "notified", notifiedAt: new Date() };
    (Appeal.findByIdAndUpdate as any).mockResolvedValue(updated);
    const req = mockReq({
      params: { id: "abc" },
      body: { status: "notified" },
    });
    const res = mockRes();
    await updateAppealStatus(req, res);
    expect(Appeal.findByIdAndUpdate).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(updated);
  });

  it("appends a review decision while retaining prior history and advancing status", async () => {
    const previousDecision = {
      reviewerAddress: "GPRIOR",
      decision: "upheld",
      reasonCode: "original-review",
    };
    const incomingDecision = {
      reviewerAddress: "GNEXT",
      decision: "rejected",
      reasonCode: "false-positive",
      evidenceHash: "review-evidence",
      decisionVersion: 2,
      conflictOfInterest: false,
    };
    const stored = {
      _id: "507f1f77bcf86cd799439011",
      status: "flagged",
      reviewerDecisions: [previousDecision],
    };

    const { default: actualAppeal } = await vi.importActual<
      typeof import("../../server/src/models/Appeal")
    >("../../server/src/models/Appeal");
    const originalCollectionUpdate = actualAppeal.collection.findOneAndUpdate;

    try {
      // Use the actual schema, query casting and validators. Replace only the
      // collection call; a status-only write must not fabricate an audit entry.
      actualAppeal.collection.findOneAndUpdate = async (_filter: any, mutation: any) => {
        const next = { ...stored, ...mutation.$set };
        if (mutation.$push?.reviewerDecisions) {
          next.reviewerDecisions = [
            ...stored.reviewerDecisions,
            mutation.$push.reviewerDecisions,
          ];
        }
        return next;
      };
      (Appeal.findByIdAndUpdate as any).mockImplementationOnce(
        (...args: any[]) => actualAppeal.findByIdAndUpdate(...args),
      );
      const res = mockRes();
      await updateAppealStatus(
        mockReq({ params: { id: stored._id }, body: { reviewerDecision: incomingDecision } }),
        res,
      );

      expect(Appeal.findByIdAndUpdate).toHaveBeenCalledTimes(1);
      const returned = res.json.mock.calls[0][0];
      expect(returned.error).toBeUndefined();
      expect(returned.status).toBe("reviewed");
      expect(returned.reviewedAt).toBeInstanceOf(Date);
      expect(returned.reviewerDecisions).toEqual([
        previousDecision,
        { ...incomingDecision, decidedAt: expect.any(Date) },
      ]);
      expect(stored.reviewerDecisions).toEqual([previousDecision]);
    } finally {
      actualAppeal.collection.findOneAndUpdate = originalCollectionUpdate;
    }
  });

  it("returns 404 for unknown id on update", async () => {
    (Appeal.findByIdAndUpdate as any).mockResolvedValue(null);
    const req = mockReq({
      params: { id: "nonexistent" },
      body: { status: "upheld" },
    });
    const res = mockRes();
    await updateAppealStatus(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe("listAppeals", () => {
  it("returns paginated results", async () => {
    const mockAppeals = [{ _id: "1" }, { _id: "2" }];
    (Appeal.find as any).mockReturnValue({
      sort: vi.fn().mockReturnValue({
        skip: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue(mockAppeals),
          }),
        }),
      }),
    });
    (Appeal.countDocuments as any).mockResolvedValue(10);

    const req = mockReq({ query: { page: "1", limit: "20" } });
    const res = mockRes();
    await listAppeals(req, res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: mockAppeals,
        total: 10,
        page: 1,
        pageSize: 20,
      }),
    );
  });
});

describe("getAppealStats", () => {
  it("returns aggregated stats", async () => {
    (Appeal.aggregate as any).mockResolvedValue([
      { _id: "flagged", count: 5 },
      { _id: "upheld", count: 3 },
    ]);
    (Appeal.countDocuments as any).mockResolvedValue(8);

    const req = mockReq();
    const res = mockRes();
    await getAppealStats(req, res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        total: 8,
        byStatus: expect.arrayContaining([
          expect.objectContaining({ _id: "flagged" }),
        ]),
      }),
    );
  });
});

