/** Wallet-bound writes must never accept an arbitrary buyer address from a body. */
import express from "express";
import request from "supertest";

jest.mock("../auth/walletPrincipalHttp", () => ({
  requireWalletPrincipal: (req: any, res: any, next: any) => {
    const address = req.headers["x-test-wallet"];
    if (!address) return res.status(401).json({ error: "Wallet session required." });
    // Only the verified-principal boundary is stubbed here. Cryptographic
    // signature, expiry, replay and revocation have separate core tests.
    res.locals.walletPrincipal = { address };
    next();
  },
}));

jest.mock("../db/connectDb", () => jest.fn().mockResolvedValue(undefined));
jest.mock("../models/Purchase", () => ({
  __esModule: true,
  default: { exists: jest.fn(), findOne: jest.fn() },
}));
jest.mock("../models/Vote", () => ({
  __esModule: true,
  default: {
    create: jest.fn(),
    countDocuments: jest.fn(),
    findOneAndDelete: jest.fn(),
    aggregate: jest.fn(),
  },
}));
jest.mock("../models/Review", () => ({
  __esModule: true,
  default: { findOneAndUpdate: jest.fn(), find: jest.fn() },
}));
jest.mock("../services/cacheService", () => ({
  cacheDel: jest.fn().mockResolvedValue(undefined),
  CACHE_KEYS: { promptDetail: (id: string) => `prompt:detail:${id}` },
}));

import Purchase from "../models/Purchase";
import Vote from "../models/Vote";
import Review from "../models/Review";
import { reviewRouter } from "./reviewRoutes";
import { governanceRouter } from "./governanceRoutes";

const VERIFIED = "GWalletAlice";
const OTHER = "GWalletBob";
const PROMPT = "prompt-1";

function app() {
  const server = express();
  server.use(express.json());
  server.use("/api/reviews", reviewRouter);
  server.use("/api/governance", governanceRouter);
  return server;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("wallet-bound review and governance writes (#144)", () => {
  it("rejects unauthenticated review and vote mutations before DB access", async () => {
    const server = app();
    const review = await request(server).post("/api/reviews/submit")
      .send({ promptId: PROMPT, userAddress: OTHER, rating: 5 });
    const vote = await request(server).post(`/api/governance/vote/${PROMPT}`)
      .send({ voterWallet: OTHER });
    const remove = await request(server).delete(`/api/governance/vote/${PROMPT}`)
      .send({ voterWallet: OTHER });

    expect([review.status, vote.status, remove.status]).toEqual([401, 401, 401]);
    expect(Purchase.findOne).not.toHaveBeenCalled();
    expect(Purchase.exists).not.toHaveBeenCalled();
    expect(Vote.findOneAndDelete).not.toHaveBeenCalled();
  });

  it("rejects forged body wallets for review, vote and vote removal", async () => {
    const server = app();
    const review = await request(server).post("/api/reviews/submit")
      .set("X-Test-Wallet", VERIFIED)
      .send({ promptId: PROMPT, userAddress: OTHER, rating: 5 });
    const vote = await request(server).post(`/api/governance/vote/${PROMPT}`)
      .set("X-Test-Wallet", VERIFIED).send({ voterWallet: OTHER });
    const remove = await request(server).delete(`/api/governance/vote/${PROMPT}`)
      .set("X-Test-Wallet", VERIFIED).send({ voterWallet: OTHER });

    expect([review.status, vote.status, remove.status]).toEqual([403, 403, 403]);
    expect(Purchase.findOne).not.toHaveBeenCalled();
    expect(Purchase.exists).not.toHaveBeenCalled();
    expect(Vote.findOneAndDelete).not.toHaveBeenCalled();
  });

  it("persists a verified purchase review using the signed session wallet", async () => {
    (Purchase.findOne as jest.Mock).mockResolvedValue({ _id: "purchase-1" });
    (Review.findOneAndUpdate as jest.Mock).mockResolvedValue({
      _id: "review-1", rating: 5, createdAt: new Date(0),
    });

    const response = await request(app()).post("/api/reviews/submit")
      .set("X-Test-Wallet", VERIFIED)
      .send({ promptId: PROMPT, rating: 5, text: "Nice" });

    expect(response.status).toBe(200);
    expect(Purchase.findOne).toHaveBeenCalledWith({
      promptId: PROMPT, buyerWallet: VERIFIED.toLowerCase(),
    });
    expect(Review.findOneAndUpdate).toHaveBeenCalledWith(
      { promptId: PROMPT, userAddress: VERIFIED.toLowerCase() },
      { rating: 5, text: "Nice", verified: true },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  });

  it("creates and removes votes for the session wallet and leaves public counts readable", async () => {
    (Purchase.exists as jest.Mock).mockResolvedValue(true);
    (Vote.create as jest.Mock).mockResolvedValue({});
    (Vote.countDocuments as jest.Mock).mockResolvedValue(1);
    (Vote.findOneAndDelete as jest.Mock).mockResolvedValue({});

    const server = app();
    const vote = await request(server).post(`/api/governance/vote/${PROMPT}`)
      .set("X-Test-Wallet", VERIFIED).send({});
    const remove = await request(server).delete(`/api/governance/vote/${PROMPT}`)
      .set("X-Test-Wallet", VERIFIED).send({});
    const count = await request(server).get(`/api/governance/votes/${PROMPT}`);

    expect([vote.status, remove.status, count.status]).toEqual([201, 200, 200]);
    expect(Purchase.exists).toHaveBeenCalledWith({
      promptId: PROMPT, buyerWallet: VERIFIED.toLowerCase(),
    });
    expect(Vote.create).toHaveBeenCalledWith({
      promptId: PROMPT, voterWallet: VERIFIED.toLowerCase(),
    });
    expect(Vote.findOneAndDelete).toHaveBeenCalledWith({
      promptId: PROMPT, voterWallet: VERIFIED.toLowerCase(),
    });
  });
});
