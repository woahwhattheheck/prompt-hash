/**
 * Governance vote routes — authenticated buyer votes (#147).
 *
 * Covers: valid buyer, impersonation (forged body wallet), cross-wallet
 * delete, replay, duplicate, wrong-network. Public GETs stay unauthenticated.
 */

import express from "express";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  VOTE_CREATE_ACTION,
  VOTE_DELETE_ACTION,
  createWalletSessionToken,
  governanceSessionNonceLedger,
} from "../auth/walletSession";

const SECRET = "test-challenge-token-secret-00000001";
const NETWORK = "Test SDF Network ; September 2015";
const OTHER_NETWORK = "Public Global Stellar Network ; September 2015";
const NOW = 1_700_000_000_000;
const PROMPT = "prompt-99";

jest.mock("../models/Vote", () => ({
  __esModule: true,
  default: {
    create: jest.fn(),
    findOneAndDelete: jest.fn(),
    countDocuments: jest.fn(),
    aggregate: jest.fn(),
  },
}));

jest.mock("../models/Purchase", () => ({
  __esModule: true,
  default: {
    exists: jest.fn(),
  },
}));

import Vote from "../models/Vote";
import Purchase from "../models/Purchase";
import { governanceRouter } from "./governanceRoutes";

const mockVoteCreate = Vote.create as jest.Mock;
const mockVoteDelete = Vote.findOneAndDelete as jest.Mock;
const mockVoteCount = Vote.countDocuments as jest.Mock;
const mockPurchaseExists = Purchase.exists as jest.Mock;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/governance", governanceRouter);
  return app;
}

function signMessage(keypair: Keypair, message: string): string {
  return keypair.sign(Buffer.from(message, "utf8")).toString("base64");
}

function issueSigned(
  kp: Keypair,
  action: typeof VOTE_CREATE_ACTION | typeof VOTE_DELETE_ACTION,
  opts?: { network?: string; promptId?: string; now?: number },
) {
  const issued = createWalletSessionToken({
    address: kp.publicKey(),
    promptId: opts?.promptId ?? PROMPT,
    action,
    network: opts?.network ?? NETWORK,
    secret: SECRET,
    now: opts?.now ?? Date.now(),
  });
  const signature = signMessage(kp, issued.challenge);
  return { ...issued, signature };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CHALLENGE_TOKEN_SECRET = SECRET;
  process.env.PUBLIC_STELLAR_NETWORK_PASSPHRASE = NETWORK;
  governanceSessionNonceLedger.clear();
  mockVoteCount.mockResolvedValue(1);
});

afterAll(() => {
  delete process.env.CHALLENGE_TOKEN_SECRET;
});

describe("POST /api/governance/vote/:promptId", () => {
  it("valid buyer: authenticated session creates a vote", async () => {
    const buyer = Keypair.random();
    const { sessionToken, signature } = issueSigned(buyer, VOTE_CREATE_ACTION);
    mockPurchaseExists.mockResolvedValueOnce(true);
    mockVoteCreate.mockResolvedValueOnce({});

    const res = await request(buildApp())
      .post(`/api/governance/vote/${PROMPT}`)
      .send({ sessionToken, signature, voterWallet: "G_FORGED_SHOULD_BE_IGNORED" });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(mockPurchaseExists).toHaveBeenCalledWith({
      promptId: PROMPT,
      buyerWallet: buyer.publicKey().toLowerCase(),
    });
    expect(mockVoteCreate).toHaveBeenCalledWith({
      promptId: PROMPT,
      voterWallet: buyer.publicKey().toLowerCase(),
    });
  });

  it("impersonation: forged body wallet has no effect; session address wins", async () => {
    const buyer = Keypair.random();
    const victim = Keypair.random();
    const { sessionToken, signature } = issueSigned(buyer, VOTE_CREATE_ACTION);
    mockPurchaseExists.mockResolvedValueOnce(true);
    mockVoteCreate.mockResolvedValueOnce({});

    const res = await request(buildApp())
      .post(`/api/governance/vote/${PROMPT}`)
      .send({
        sessionToken,
        signature,
        voterWallet: victim.publicKey(),
      });

    expect(res.status).toBe(201);
    expect(mockPurchaseExists).toHaveBeenCalledWith({
      promptId: PROMPT,
      buyerWallet: buyer.publicKey().toLowerCase(),
    });
    expect(mockVoteCreate).toHaveBeenCalledWith({
      promptId: PROMPT,
      voterWallet: buyer.publicKey().toLowerCase(),
    });
    // Victim wallet never queried / written
    const purchaseArgs = mockPurchaseExists.mock.calls[0][0];
    expect(purchaseArgs.buyerWallet).not.toBe(victim.publicKey().toLowerCase());
  });

  it("rejects requests that only supply voterWallet (no session)", async () => {
    const res = await request(buildApp())
      .post(`/api/governance/vote/${PROMPT}`)
      .send({ voterWallet: Keypair.random().publicKey() });

    expect(res.status).toBe(400);
    expect(mockVoteCreate).not.toHaveBeenCalled();
  });

  it("rejects non-buyer even with a valid signature", async () => {
    const stranger = Keypair.random();
    const { sessionToken, signature } = issueSigned(stranger, VOTE_CREATE_ACTION);
    mockPurchaseExists.mockResolvedValueOnce(null);

    const res = await request(buildApp())
      .post(`/api/governance/vote/${PROMPT}`)
      .send({ sessionToken, signature });

    expect(res.status).toBe(403);
    expect(mockVoteCreate).not.toHaveBeenCalled();
  });

  it("duplicate: second create for same principal returns 409", async () => {
    const buyer = Keypair.random();
    const base = Date.now();
    const first = issueSigned(buyer, VOTE_CREATE_ACTION, { now: base });
    const second = issueSigned(buyer, VOTE_CREATE_ACTION, { now: base + 10 });
    mockPurchaseExists.mockResolvedValue(true);
    mockVoteCreate
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        Object.assign(new Error("E11000 duplicate key"), { code: 11000 }),
      );

    const ok = await request(buildApp())
      .post(`/api/governance/vote/${PROMPT}`)
      .send({ sessionToken: first.sessionToken, signature: first.signature });
    expect(ok.status).toBe(201);

    const dup = await request(buildApp())
      .post(`/api/governance/vote/${PROMPT}`)
      .send({ sessionToken: second.sessionToken, signature: second.signature });
    expect(dup.status).toBe(409);
  });

  it("replay: reusing the same signed session is rejected", async () => {
    const buyer = Keypair.random();
    const { sessionToken, signature } = issueSigned(buyer, VOTE_CREATE_ACTION);
    mockPurchaseExists.mockResolvedValue(true);
    mockVoteCreate.mockResolvedValue({});

    const first = await request(buildApp())
      .post(`/api/governance/vote/${PROMPT}`)
      .send({ sessionToken, signature });
    expect(first.status).toBe(201);

    const replay = await request(buildApp())
      .post(`/api/governance/vote/${PROMPT}`)
      .send({ sessionToken, signature });
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe("replay");
  });

  it("wrong-network: session bound to another passphrase is rejected", async () => {
    const buyer = Keypair.random();
    const { sessionToken, signature } = issueSigned(buyer, VOTE_CREATE_ACTION, {
      network: OTHER_NETWORK,
    });

    const res = await request(buildApp())
      .post(`/api/governance/vote/${PROMPT}`)
      .send({ sessionToken, signature });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("wrong_network");
    expect(mockPurchaseExists).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/governance/vote/:promptId", () => {
  it("cross-wallet delete: authenticated wallet can only remove its own vote", async () => {
    const attacker = Keypair.random();
    const victim = Keypair.random();
    const { sessionToken, signature } = issueSigned(attacker, VOTE_DELETE_ACTION);
    // Attacker has no vote — delete finds nothing for attacker address
    mockVoteDelete.mockResolvedValueOnce(null);

    const res = await request(buildApp())
      .delete(`/api/governance/vote/${PROMPT}`)
      .send({
        sessionToken,
        signature,
        voterWallet: victim.publicKey(), // forged — ignored
      });

    expect(res.status).toBe(404);
    expect(mockVoteDelete).toHaveBeenCalledWith({
      promptId: PROMPT,
      voterWallet: attacker.publicKey().toLowerCase(),
    });
    const args = mockVoteDelete.mock.calls[0][0];
    expect(args.voterWallet).not.toBe(victim.publicKey().toLowerCase());
  });

  it("valid buyer can remove its own vote", async () => {
    const buyer = Keypair.random();
    const { sessionToken, signature } = issueSigned(buyer, VOTE_DELETE_ACTION);
    mockVoteDelete.mockResolvedValueOnce({
      promptId: PROMPT,
      voterWallet: buyer.publicKey().toLowerCase(),
    });
    mockVoteCount.mockResolvedValueOnce(0);

    const res = await request(buildApp())
      .delete(`/api/governance/vote/${PROMPT}`)
      .send({ sessionToken, signature });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, upvotes: 0 });
  });
});

describe("public aggregate reads", () => {
  it("GET /votes/:promptId does not require a session", async () => {
    mockVoteCount.mockResolvedValue(7);
    const res = await request(buildApp()).get(
      `/api/governance/votes/${PROMPT}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ promptId: PROMPT, upvotes: 7 });
  });
});

describe("POST /api/governance/session", () => {
  it("issues a session for a supported action", async () => {
    const buyer = Keypair.random();
    const res = await request(buildApp()).post("/api/governance/session").send({
      address: buyer.publicKey(),
      promptId: PROMPT,
      action: VOTE_CREATE_ACTION,
    });

    expect(res.status).toBe(200);
    expect(res.body.sessionToken).toBeTruthy();
    expect(res.body.challenge).toContain(VOTE_CREATE_ACTION);
    expect(res.body.network).toBe(NETWORK);
  });
});

// Silence unused import lint in some configs
