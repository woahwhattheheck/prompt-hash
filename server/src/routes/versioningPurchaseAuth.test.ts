/**
 * Issue #144: purchase entitlements are accepted only through the trusted
 * backend boundary, never directly from browser wallet input.
 */
import express from "express";
import request from "supertest";

jest.mock("../auth/walletPrincipalHttp", () => ({
  requireWalletPrincipal: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../auth/fulfillmentService", () => ({
  requireFulfillmentService: (req: any, res: any, next: any) => {
    if (req.headers["x-test-service"] !== "trusted") {
      return res.status(401).json({ error: "trusted service required" });
    }
    next();
  },
}));

jest.mock("../controllers/versioningControllers", () => ({
  PostPromptUpdate: jest.fn((_req: any, res: any) => res.status(200).json({ ok: true })),
  GetPromptVersions: jest.fn((_req: any, res: any) => res.status(200).json({ ok: true })),
  RecordPurchase: jest.fn((_req: any, res: any) => res.status(201).json({ indexed: true })),
  GetBuyerVersion: jest.fn((_req: any, res: any) => res.status(200).json({ ok: true })),
}));

import { RecordPurchase } from "../controllers/versioningControllers";
import { versioningRouter } from "./versioningRoutes";

const recordPurchase = RecordPurchase as jest.Mock;

function app() {
  const server = express();
  server.use(express.json());
  server.use("/api/versions", versioningRouter);
  return server;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("version purchase indexing boundary (#144)", () => {
  it("rejects direct callers before RecordPurchase", async () => {
    const response = await request(app())
      .post("/api/versions/purchase")
      .send({ promptId: "prompt-1", buyerWallet: "GWalletAlice", txHash: "tx-1" });

    expect(response.status).toBe(401);
    expect(recordPurchase).not.toHaveBeenCalled();
  });

  it("allows the trusted backend path to reach RecordPurchase", async () => {
    const response = await request(app())
      .post("/api/versions/purchase")
      .set("X-Test-Service", "trusted")
      .send({ promptId: "prompt-1", buyerWallet: "GWalletAlice", txHash: "tx-1" });

    expect(response.status).toBe(201);
    expect(recordPurchase).toHaveBeenCalledTimes(1);
  });
});
