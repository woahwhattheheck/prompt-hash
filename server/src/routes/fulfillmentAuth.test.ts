/** Exact buyer/session vs backend/service authorization acceptance for #144. */
import express from "express";
import request from "supertest";

jest.mock("../auth/walletPrincipalHttp", () => ({
  requireWalletPrincipal: (req: any, res: any, next: any) => {
    const address = req.headers["x-test-wallet"];
    if (!address) return res.status(401).json({ error: "Wallet session required." });
    res.locals.walletPrincipal = { address };
    next();
  },
}));
jest.mock("../models/FulfillmentRecord", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    find: jest.fn(),
    updateMany: jest.fn(),
  },
}));
import FulfillmentRecord from "../models/FulfillmentRecord";
import { fulfillmentRouter } from "./fulfillmentRoutes";

const BUYER = "GSessionBuyer";
const OTHER = "GOtherBuyer";
const PROMPT = "prompt-one";
const SERVER_TOKEN = "local-test-service-token-with-at-least-32-bytes";
const previousToken = process.env.FULFILLMENT_SERVICE_TOKEN;
function app() {
  const server = express();
  server.use(express.json());
  server.use("/api/fulfillment", fulfillmentRouter);
  return server;
}
beforeEach(() => {
  jest.clearAllMocks();
  process.env.FULFILLMENT_SERVICE_TOKEN = SERVER_TOKEN;
});
afterAll(() => {
  if (previousToken === undefined) delete process.env.FULFILLMENT_SERVICE_TOKEN;
  else process.env.FULFILLMENT_SERVICE_TOKEN = previousToken;
});

describe("fulfillment owner and privileged-service boundaries", () => {
  it("denies anonymous buyer reads and refund writes before DB access", async () => {
    const server = app();
    const read = await request(server).get(`/api/fulfillment/${PROMPT}/${OTHER}`);
    const refund = await request(server).post(`/api/fulfillment/${PROMPT}/${OTHER}/request-refund`)
      .send({ reason: "missing delivery" });
    expect([read.status, refund.status]).toEqual([401, 401]);
    expect(FulfillmentRecord.findOne).not.toHaveBeenCalled();
  });

  it("rejects a signed wallet targeting someone else's delivery/refund", async () => {
    const server = app();
    const read = await request(server).get(`/api/fulfillment/${PROMPT}/${OTHER}`)
      .set("X-Test-Wallet", BUYER);
    const refund = await request(server).post(`/api/fulfillment/${PROMPT}/${OTHER}/request-refund`)
      .set("X-Test-Wallet", BUYER).send({ reason: "fraudulent refund" });
    expect([read.status, refund.status]).toEqual([403, 403]);
    expect(FulfillmentRecord.findOne).not.toHaveBeenCalled();
  });

  it("keeps owner lookups and refund eligibility on the authenticated buyer", async () => {
    const row: any = {
      status: "failed", auditLog: [], isRefundEligible: () => true,
      save: jest.fn().mockResolvedValue(undefined),
    };
    (FulfillmentRecord.findOne as jest.Mock).mockResolvedValue(row);
    const server = app();
    const read = await request(server).get(`/api/fulfillment/${PROMPT}/${BUYER}`)
      .set("X-Test-Wallet", BUYER);
    const refund = await request(server).post(`/api/fulfillment/${PROMPT}/${BUYER}/request-refund`)
      .set("X-Test-Wallet", BUYER).send({ reason: "missing delivery" });
    expect([read.status, refund.status]).toEqual([200, 200]);
    expect(FulfillmentRecord.findOne).toHaveBeenCalledWith({
      promptId: PROMPT, buyerWallet: BUYER.toLowerCase(),
    });
    expect(row.status).toBe("refund_requested");
    expect(row.save).toHaveBeenCalledTimes(1);
  });

  it("denies forged delivery completion, admin refunds, queue reads and sweeps", async () => {
    const server = app();
    const upsert = await request(server).post("/api/fulfillment")
      .send({ promptId: PROMPT, buyerWallet: BUYER, status: "delivered" });
    const resolve = await request(server).post(`/api/fulfillment/${PROMPT}/${BUYER}/resolve`)
      .set("X-Test-Wallet", BUYER).send({ refund: true });
    const list = await request(server).get("/api/fulfillment/pending-refunds");
    const sweep = await request(server).post("/api/fulfillment/auto-refund-sweep");
    expect([upsert.status, resolve.status, list.status, sweep.status]).toEqual([401,401,401,401]);
    expect(FulfillmentRecord.findOneAndUpdate).not.toHaveBeenCalled();
    expect(FulfillmentRecord.updateMany).not.toHaveBeenCalled();
  });

  it("fails closed with no service token configured, and denies invalid tokens", async () => {
    const server = app();
    delete process.env.FULFILLMENT_SERVICE_TOKEN;
    const missing = await request(server).post("/api/fulfillment").send({});
    process.env.FULFILLMENT_SERVICE_TOKEN = SERVER_TOKEN;
    const forged = await request(server).post("/api/fulfillment")
      .set("Authorization", "Bearer wrong-service-token").send({});
    expect([missing.status, forged.status]).toEqual([503,403]);
  });

  it("allows trusted service delivery while rejecting forged refund statuses", async () => {
    (FulfillmentRecord.findOneAndUpdate as jest.Mock).mockResolvedValue({
      promptId: PROMPT, buyerWallet: BUYER.toLowerCase(), status: "delivered",
    });
    const server = app();
    const accepted = await request(server).post("/api/fulfillment")
      .set("Authorization", `Bearer ${SERVER_TOKEN}`)
      .send({ promptId: PROMPT, buyerWallet: BUYER, status: "delivered" });
    const invalid = await request(server).post("/api/fulfillment")
      .set("Authorization", `Bearer ${SERVER_TOKEN}`)
      .send({ promptId: PROMPT, buyerWallet: BUYER, status: "refunded" });
    expect([accepted.status, invalid.status]).toEqual([200,400]);
    expect(FulfillmentRecord.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("requires the service bearer for admin queue and bulk sweep", async () => {
    (FulfillmentRecord.find as jest.Mock).mockReturnValue({
      sort: jest.fn().mockResolvedValue([]),
    });
    (FulfillmentRecord.updateMany as jest.Mock).mockResolvedValue({ modifiedCount: 2 });
    const server = app();
    const queue = await request(server).get("/api/fulfillment/pending-refunds")
      .set("Authorization", `Bearer ${SERVER_TOKEN}`);
    const sweep = await request(server).post("/api/fulfillment/auto-refund-sweep")
      .set("Authorization", `Bearer ${SERVER_TOKEN}`);
    expect([queue.status, sweep.status]).toEqual([200,200]);
    expect(sweep.body.swept).toBe(2);
    expect(FulfillmentRecord.updateMany).toHaveBeenCalledTimes(1);
  });
});
