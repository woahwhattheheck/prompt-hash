import express from "express";
import request from "supertest";
import PayoutStatementModel from "../models/PayoutStatement";
import { payoutRouter } from "../routes/payoutRoutes";

describe("payout statement event persistence boundary", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("keeps caller-supplied event batches preview-only", async () => {
    const persist = jest.spyOn(PayoutStatementModel, "findOneAndUpdate");
    const app = express();
    app.use(express.json());
    app.use("/api/payouts", payoutRouter);

    const base = {
      sellerWallet: "GSELLER",
      periodStart: "2026-01-01T00:00:00.000Z",
      periodEnd: "2026-01-31T23:59:59.999Z",
      purchases: [],
    };

    const rejected = await request(app)
      .post("/api/payouts/statements/generate")
      .send({ ...base, persist: true });

    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(/preview-only/i);
    expect(persist).not.toHaveBeenCalled();

    const preview = await request(app)
      .post("/api/payouts/statements/generate")
      .send({ ...base, persist: false });

    expect(preview.status).toBe(201);
    expect(preview.body.statement.sellerWallet).toBe("gseller");
    expect(persist).not.toHaveBeenCalled();
  });
});
