/** Focused reconciliation service vs approver authorization, offline (#144). */
import express from "express";
import request from "supertest";

jest.mock("../models/ReconciliationReport", () => ({
  __esModule: true,
  default: { find: jest.fn(), findOne: jest.fn() },
}));
jest.mock("../services/reconciliationService", () => ({
  runReconciliation: jest.fn(),
  executeRepair: jest.fn(),
}));

import ReconciliationReport from "../models/ReconciliationReport";
import { runReconciliation, executeRepair } from "../services/reconciliationService";
import { reconciliationRouter } from "./reconciliationRoutes";

const SERVICE = "test-reconciliation-reader-credential-longer-than-32";
const APPROVER = "test-reconciliation-approver-credential-longer-than-32";
const originalService = process.env.RECONCILIATION_SERVICE_TOKEN;
const originalApprover = process.env.RECONCILIATION_APPROVER_TOKEN;

function app() {
  const server = express();
  server.use(express.json());
  server.use("/api/reconciliation", reconciliationRouter);
  return server;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.RECONCILIATION_SERVICE_TOKEN = SERVICE;
  process.env.RECONCILIATION_APPROVER_TOKEN = APPROVER;
});
afterAll(() => {
  if (originalService === undefined) delete process.env.RECONCILIATION_SERVICE_TOKEN;
  else process.env.RECONCILIATION_SERVICE_TOKEN = originalService;
  if (originalApprover === undefined) delete process.env.RECONCILIATION_APPROVER_TOKEN;
  else process.env.RECONCILIATION_APPROVER_TOKEN = originalApprover;
});

describe("reconciliation API privileged roles", () => {
  it("fails closed before reading or modifying data without configured tokens", async () => {
    delete process.env.RECONCILIATION_SERVICE_TOKEN;
    delete process.env.RECONCILIATION_APPROVER_TOKEN;
    const server = app();
    const run = await request(server).post("/api/reconciliation/run").send({ isDryRun: false });
    const list = await request(server).get("/api/reconciliation/reports");
    const repair = await request(server).post("/api/reconciliation/repair/rec-1");
    expect([run.status, list.status, repair.status]).toEqual([503, 503, 503]);
    expect(runReconciliation).not.toHaveBeenCalled();
    expect(ReconciliationReport.find).not.toHaveBeenCalled();
    expect(executeRepair).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated and cross-role bearer access without DB effects", async () => {
    const server = app();
    const anonymous = await request(server).get("/api/reconciliation/reports");
    const forged = await request(server).post("/api/reconciliation/run")
      .set("Authorization", "Bearer arbitrary-credential")
      .send({ isDryRun: false, createdBy: "admin" });
    const readerCannotRepair = await request(server).post("/api/reconciliation/repair/rec-1")
      .set("Authorization", `Bearer ${SERVICE}`)
      .send({ approvedBy: "forged-owner" });
    const approverCannotRead = await request(server).get("/api/reconciliation/reports")
      .set("Authorization", `Bearer ${APPROVER}`);
    expect([anonymous.status, forged.status, readerCannotRepair.status, approverCannotRead.status])
      .toEqual([401, 403, 403, 403]);
    expect(runReconciliation).not.toHaveBeenCalled();
    expect(ReconciliationReport.find).not.toHaveBeenCalled();
    expect(executeRepair).not.toHaveBeenCalled();
  });

  it("permits authenticated service reports and run using server-derived audit identity", async () => {
    (ReconciliationReport.find as jest.Mock).mockReturnValue({
      sort: () => ({ lean: async () => [{ reportId: "rec-1" }] }),
    });
    (runReconciliation as jest.Mock).mockResolvedValue({ reportId: "rec-1" });
    const server = app();
    const listed = await request(server).get("/api/reconciliation/reports")
      .set("Authorization", `Bearer ${SERVICE}`);
    const invalid = await request(server).post("/api/reconciliation/run")
      .set("Authorization", `Bearer ${SERVICE}`)
      .send({ isDryRun: "false" });
    const run = await request(server).post("/api/reconciliation/run")
      .set("Authorization", `Bearer ${SERVICE}`)
      .send({ isDryRun: true, createdBy: "forged-owner" });
    expect([listed.status, invalid.status, run.status]).toEqual([200, 400, 201]);
    expect(runReconciliation).toHaveBeenCalledTimes(1);
    expect(runReconciliation).toHaveBeenCalledWith({
      isDryRun: true, createdBy: "reconciliation-service",
    });
    expect(listed.headers["cache-control"]).toBe("no-store");
  });

  it("permits only the independent approver to repair with non-forgeable attribution", async () => {
    (executeRepair as jest.Mock).mockResolvedValue({ repairedCount: 1 });
    const response = await request(app()).post("/api/reconciliation/repair/rec-1")
      .set("Authorization", `Bearer ${APPROVER}`)
      .send({ approvedBy: "forged-owner" });
    expect(response.status).toBe(200);
    expect(executeRepair).toHaveBeenCalledWith("rec-1", "reconciliation-approver");
    expect(runReconciliation).not.toHaveBeenCalled();
  });
});
