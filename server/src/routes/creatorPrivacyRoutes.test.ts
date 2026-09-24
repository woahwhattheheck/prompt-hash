/**
 * Creator privacy routes — cross-wallet matrix, replay, valid creator (#142).
 */

import express from "express";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  CREATOR_DRAFTS_READ,
  CREATOR_OWNED_READ,
  CREATOR_VERSION_WRITE,
  createCreatorSessionToken,
  creatorSessionNonceLedger,
  digestVersionContent,
} from "../auth/creatorSession";

const SECRET = "test-challenge-token-secret-00000001";
const NETWORK = "Test SDF Network ; September 2015";
const CONTENT = "version body bound by digest";
const PROMPT_ID = "507f1f77bcf86cd799439011";

jest.mock("../db/connectDb", () => jest.fn().mockResolvedValue(undefined));

jest.mock("../models/User", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));

jest.mock("../models/Prompt", () => ({
  __esModule: true,
  default: {
    find: jest.fn(),
    findOne: jest.fn(),
    findById: jest.fn(),
  },
}));

jest.mock("../models/PromptVersion", () => ({
  __esModule: true,
  default: { find: jest.fn(), findOne: jest.fn() },
}));

jest.mock("../models/Purchase", () => ({
  __esModule: true,
  default: { findOne: jest.fn(), findOneAndUpdate: jest.fn() },
}));

jest.mock("../models/Report", () => ({ __esModule: true, default: {} }));
jest.mock("../models/PreviewEvent", () => ({ __esModule: true, default: {} }));
jest.mock("../models/AuditLog", () => ({
  __esModule: true,
  AuditLog: { create: jest.fn() },
}));

jest.mock("../services/promptVersioning", () => ({
  publishPromptVersion: jest.fn().mockResolvedValue({ versionIndex: 2 }),
}));

jest.mock("../services/cacheService", () => ({
  cacheGetOrLoad: jest.fn(async (_k: string, loader: () => Promise<unknown>) =>
    loader(),
  ),
  cacheDel: jest.fn(),
  cacheDelPattern: jest.fn(),
  CACHE_KEYS: { promptList: (s: string) => `prompts:list:${s}` },
}));

jest.mock("../services/previewAnalytics", () => ({
  issuePreviewToken: jest.fn(),
  recordPreviewEvent: jest.fn(),
}));

jest.mock("../services/listingValidation", () => ({
  validateListingMetadata: jest.fn(),
}));

jest.mock("../utils/proxyLogger", () => ({
  generateRequestId: jest.fn(() => "req-1"),
  logProxyException: jest.fn(),
  logProxySuccess: jest.fn(),
  logProxyUpstreamError: jest.fn(),
}));

jest.mock("../config/stellar", () => ({
  stellarConfig: { networkPassphrase: NETWORK },
}));

import User from "../models/User";
import Prompt from "../models/Prompt";
import PromptVersion from "../models/PromptVersion";
import { publishPromptVersion } from "../services/promptVersioning";
import { promptRouter } from "./promptRoutes";
import { versioningRouter } from "./versioningRoutes";

const mockUserFindOne = User.findOne as jest.Mock;
const mockPromptFind = Prompt.find as jest.Mock;
const mockPromptFindOne = Prompt.findOne as jest.Mock;
const mockPublish = publishPromptVersion as jest.Mock;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/prompts", promptRouter);
  app.use("/api/versions", versioningRouter);
  return app;
}

function signMessage(keypair: Keypair, message: string): string {
  return keypair.sign(Buffer.from(message, "utf8")).toString("base64");
}

function issueSigned(
  kp: Keypair,
  action:
    | typeof CREATOR_OWNED_READ
    | typeof CREATOR_DRAFTS_READ
    | typeof CREATOR_VERSION_WRITE,
  opts?: { promptId?: string; content?: string; now?: number },
) {
  const contentDigest =
    action === CREATOR_VERSION_WRITE
      ? digestVersionContent(opts?.content ?? CONTENT)
      : undefined;
  const issued = createCreatorSessionToken({
    address: kp.publicKey(),
    action,
    promptId: opts?.promptId,
    contentDigest,
    network: NETWORK,
    secret: SECRET,
    now: opts?.now ?? Date.now(),
  });
  const signature = signMessage(kp, issued.challenge);
  return { ...issued, signature };
}

function chainFind(results: unknown[]) {
  const sort = jest.fn().mockResolvedValue(results);
  const populate = jest.fn().mockReturnValue({ sort });
  mockPromptFind.mockReturnValue({ populate });
  return { populate, sort };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CHALLENGE_TOKEN_SECRET = SECRET;
  process.env.PUBLIC_STELLAR_NETWORK_PASSPHRASE = NETWORK;
  creatorSessionNonceLedger.clear();
});

afterAll(() => {
  delete process.env.CHALLENGE_TOKEN_SECRET;
});

describe("POST /api/prompts/creator-session", () => {
  it("issues owned-read and version-write sessions", async () => {
    const kp = Keypair.random();
    const owned = await request(buildApp())
      .post("/api/prompts/creator-session")
      .send({ address: kp.publicKey(), action: CREATOR_OWNED_READ });
    expect(owned.status).toBe(200);
    expect(owned.body.sessionToken).toBeTruthy();
    expect(owned.body.challenge).toContain(CREATOR_OWNED_READ);

    const write = await request(buildApp())
      .post("/api/prompts/creator-session")
      .send({
        address: kp.publicKey(),
        action: CREATOR_VERSION_WRITE,
        promptId: PROMPT_ID,
        content: CONTENT,
      });
    expect(write.status).toBe(200);
    expect(write.body.contentDigest).toBe(digestVersionContent(CONTENT));
  });
});

describe("GET owned / drafts — cross-wallet matrix", () => {
  it("rejects unauthenticated owned read", async () => {
    const res = await request(buildApp()).get(
      "/api/prompts/buyer/GSOMEWALLET/owned",
    );
    expect(res.status).toBe(401);
    expect(mockPromptFind).not.toHaveBeenCalled();
  });

  it("valid creator: authenticated owned read returns private projection", async () => {
    const creator = Keypair.random();
    const { sessionToken, signature } = issueSigned(
      creator,
      CREATOR_OWNED_READ,
    );
    mockUserFindOne.mockResolvedValueOnce({
      _id: "u1",
      walletAddress: creator.publicKey().toLowerCase(),
    });
    chainFind([
      {
        _id: "p1",
        title: "Mine",
        content: "PRIVATE CONTENT",
        listingStatus: "published",
        owner: {
          username: "me",
          walletAddress: creator.publicKey().toLowerCase(),
        },
      },
    ]);

    const res = await request(buildApp())
      .get(`/api/prompts/buyer/${creator.publicKey()}/owned`)
      .set("Authorization", `Bearer ${sessionToken}`)
      .set("X-Wallet-Signature", signature);

    expect(res.status).toBe(200);
    expect(res.body[0].content).toBe("PRIVATE CONTENT");
    expect(mockUserFindOne).toHaveBeenCalledWith({
      walletAddress: creator.publicKey().toLowerCase(),
    });
  });

  it("cross-wallet: creator A session cannot read B drafts", async () => {
    const a = Keypair.random();
    const b = Keypair.random();
    const { sessionToken, signature } = issueSigned(a, CREATOR_DRAFTS_READ);

    const res = await request(buildApp())
      .get(`/api/prompts/creator/${b.publicKey()}/drafts`)
      .set("Authorization", `Bearer ${sessionToken}`)
      .set("X-Wallet-Signature", signature);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("wallet_mismatch");
    expect(mockPromptFind).not.toHaveBeenCalled();
  });

  it("replay: spent owned-read session is rejected", async () => {
    const creator = Keypair.random();
    const { sessionToken, signature } = issueSigned(
      creator,
      CREATOR_OWNED_READ,
    );
    mockUserFindOne.mockResolvedValue({
      _id: "u1",
      walletAddress: creator.publicKey().toLowerCase(),
    });
    chainFind([]);

    const first = await request(buildApp())
      .get(`/api/prompts/buyer/${creator.publicKey()}/owned`)
      .set("Authorization", `Bearer ${sessionToken}`)
      .set("X-Wallet-Signature", signature);
    expect(first.status).toBe(200);

    const second = await request(buildApp())
      .get(`/api/prompts/buyer/${creator.publicKey()}/owned`)
      .set("Authorization", `Bearer ${sessionToken}`)
      .set("X-Wallet-Signature", signature);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("replay");
  });
});

describe("POST version write — bind creator/prompt/digest", () => {
  it("valid creator posts version; forged body wallet ignored", async () => {
    const creator = Keypair.random();
    const victim = Keypair.random();
    const { sessionToken, signature } = issueSigned(
      creator,
      CREATOR_VERSION_WRITE,
      { promptId: PROMPT_ID, content: CONTENT },
    );
    mockUserFindOne.mockResolvedValueOnce({
      _id: "u1",
      walletAddress: creator.publicKey().toLowerCase(),
    });
    mockPromptFindOne.mockResolvedValueOnce({ _id: PROMPT_ID });

    const res = await request(buildApp())
      .post("/api/versions/update")
      .send({
        promptId: PROMPT_ID,
        content: CONTENT,
        changeNote: "n",
        walletAddress: victim.publicKey(),
        sessionToken,
        signature,
      });

    expect(res.status).toBe(201);
    expect(mockUserFindOne).toHaveBeenCalledWith({
      walletAddress: creator.publicKey().toLowerCase(),
    });
    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        promptId: PROMPT_ID,
        createdBy: creator.publicKey().toLowerCase(),
      }),
    );
  });

  it("cross-wallet write: session for A cannot write as owner lookup for victim content digest mismatch / ownership", async () => {
    const attacker = Keypair.random();
    const { sessionToken, signature } = issueSigned(
      attacker,
      CREATOR_VERSION_WRITE,
      { promptId: PROMPT_ID, content: CONTENT },
    );
    mockUserFindOne.mockResolvedValueOnce({
      _id: "attacker",
      walletAddress: attacker.publicKey().toLowerCase(),
    });
    // Attacker does not own the prompt
    mockPromptFindOne.mockResolvedValueOnce(null);

    const res = await request(buildApp())
      .post("/api/versions/update")
      .send({
        promptId: PROMPT_ID,
        content: CONTENT,
        sessionToken,
        signature,
        walletAddress: "G_FORGED_OWNER",
      });

    expect(res.status).toBe(403);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("rejects version write when content digest does not match session", async () => {
    const creator = Keypair.random();
    const { sessionToken, signature } = issueSigned(
      creator,
      CREATOR_VERSION_WRITE,
      { promptId: PROMPT_ID, content: CONTENT },
    );

    const res = await request(buildApp())
      .post("/api/versions/update")
      .send({
        promptId: PROMPT_ID,
        content: "DIFFERENT CONTENT NOT IN DIGEST",
        sessionToken,
        signature,
      });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("digest_mismatch");
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("rejects version write with only body walletAddress (no session)", async () => {
    const res = await request(buildApp())
      .post("/api/versions/update")
      .send({
        promptId: PROMPT_ID,
        content: CONTENT,
        walletAddress: Keypair.random().publicKey(),
      });

    expect(res.status).toBe(401);
    expect(mockPublish).not.toHaveBeenCalled();
  });
});

describe("GET /api/versions/:promptId/history — no private content", () => {
  it("history select omits content (metadata only)", async () => {
    const select = jest.fn().mockResolvedValue([
      { versionIndex: 2, changeNote: "n" },
    ]);
    const sort = jest.fn().mockReturnValue({ select });
    (PromptVersion.find as jest.Mock).mockReturnValue({ sort });

    const res = await request(buildApp()).get(
      `/api/versions/${PROMPT_ID}/history`,
    );
    expect(res.status).toBe(200);
    expect(select).toHaveBeenCalledWith("-content");
    expect(JSON.stringify(res.body)).not.toContain("SECRET");
  });
});
