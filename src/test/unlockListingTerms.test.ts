// @vitest-environment node

import { Buffer } from "buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  buildChallengeMessage,
  createChallengeToken,
  globalNonceLedger,
  verifyChallengeToken,
} from "../lib/auth/challenge";
import {
  assertQuoteFresh,
  ListingTermsChangedError,
} from "../lib/prompts/unlock";
import {
  toListingQuote,
  type ListingTerms,
} from "../lib/auth/listingTerms";
import { ErrorCode } from "../lib/api/errorCodes";

const hasAccessMock = vi.fn();
const getPromptMock = vi.fn();
const unwrapPromptKeyMock = vi.fn();
const decryptPromptCiphertextMock = vi.fn();
const hashPromptPlaintextMock = vi.fn();
const resolveListingQuoteMock = vi.fn();

vi.mock("../lib/stellar/promptHashClient", () => ({
  hasAccess: (...args: unknown[]) => hasAccessMock(...args),
  getPrompt: (...args: unknown[]) => getPromptMock(...args),
}));

vi.mock("../lib/crypto/promptCrypto", () => ({
  unwrapPromptKey: (...args: unknown[]) => unwrapPromptKeyMock(...args),
  decryptPromptCiphertext: (...args: unknown[]) => decryptPromptCiphertextMock(...args),
  hashPromptPlaintext: (...args: unknown[]) => hashPromptPlaintextMock(...args),
  normalizeContentHash: (hash: string) => hash.toLowerCase(),
}));

vi.mock("../lib/observability/wrapper", () => ({
  withObservability: (handler: unknown) => handler,
}));

vi.mock("../lib/observability/rateLimiter", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    success: true,
    limit: 5,
    remaining: 4,
    reset: 60_000,
  }),
}));

vi.mock("../lib/observability/metrics", () => ({
  metrics: {
    emit: vi.fn(),
    trackUnlockSuccess: vi.fn(),
    trackUnlockFailure: vi.fn(),
    trackRateLimitHit: vi.fn(),
  },
}));

vi.mock("../lib/observability/replayProtection", () => ({
  checkReplayProtection: vi.fn().mockResolvedValue({ valid: true }),
}));

vi.mock("../../server/src/services/auditTrail", () => ({
  recordAuditEvent: vi.fn(),
}));

vi.mock("../../server/src/services/webhookDispatcher", () => ({
  dispatchEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/auth/resolveListingQuote", () => ({
  resolveListingQuote: (...args: unknown[]) => resolveListingQuoteMock(...args),
}));

vi.mock("../../server/src/models/FulfillmentRecord", () => ({
  default: {
    findOne: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("../lib/crypto/kms", async () => {
  const actual = await vi.importActual<typeof import("../lib/crypto/kms")>("../lib/crypto/kms");
  return {
    ...actual,
    validateKeyPolicy: vi.fn(),
    unwrapServerPrivateKey: vi.fn().mockReturnValue("unwrapped-private"),
  };
});

import handler from "../../api/prompts/unlock";

const SECRET = "integration-test-challenge-secret";

function sampleTerms(overrides: Partial<ListingTerms> = {}): ListingTerms {
  return {
    promptId: "42",
    versionIndex: 1,
    priceStroops: "50000000",
    asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    seller: "GCREATORACCOUNT1234567890ABCDEFGH1234567890ABCDEFGH123456789",
    active: true,
    ...overrides,
  };
}

async function setupBoundUnlock(terms: ListingTerms, ttlMs = 5 * 60 * 1000) {
  const buyer = Keypair.random();
  const contentHash = "a".repeat(64);
  const plaintext = "Secret prompt instructions for buyers.";

  process.env.CHALLENGE_TOKEN_SECRET = SECRET;
  process.env.UNLOCK_PUBLIC_KEY = "d".repeat(32);
  process.env.UNLOCK_PRIVATE_KEY = "e".repeat(32);
  process.env.PUBLIC_PROMPT_HASH_CONTRACT_ID =
    "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  process.env.PUBLIC_STELLAR_SIMULATION_ACCOUNT = buyer.publicKey();
  process.env.PUBLIC_STELLAR_RPC_URL = "https://soroban-testnet.stellar.org";

  const promptId = "42";
  const challenge = createChallengeToken(SECRET, buyer.publicKey(), promptId, {
    now: Date.now(),
    ttlMs,
    terms,
  });
  const signedMessage = Buffer.from(
    buyer.sign(Buffer.from(challenge.challenge, "utf8")),
  ).toString("base64");

  hasAccessMock.mockResolvedValue(true);
  getPromptMock.mockResolvedValue({
    id: 42n,
    creator: terms.seller,
    title: "Test prompt",
    contentHash,
    encryptedPrompt: "encrypted",
    encryptionIv: "iv",
    wrappedKey: "wrapped",
  });
  unwrapPromptKeyMock.mockResolvedValue(new Uint8Array(32));
  decryptPromptCiphertextMock.mockResolvedValue(plaintext);
  hashPromptPlaintextMock.mockResolvedValue(contentHash);
  resolveListingQuoteMock.mockResolvedValue(toListingQuote(terms));

  return { buyer, promptId, challenge, signedMessage, plaintext, terms };
}

async function invokeUnlock(body: Record<string, unknown>) {
  let statusCode = 0;
  let responseData: Record<string, unknown> = {};

  const req = {
    method: "POST",
    headers: {},
    body,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    requestId: "test-request",
    socket: { remoteAddress: "127.0.0.1" },
  };

  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(data: Record<string, unknown>) {
      responseData = data;
      return this;
    },
    setHeader: vi.fn(),
  };

  // @ts-expect-error test handler invocation
  await handler(req, res);
  return { statusCode, responseData };
}

describe("unlock listing terms binding (#239)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalNonceLedger.clear();
  });

  it("happy path: unchanged terms settle successfully", async () => {
    const terms = sampleTerms();
    const { buyer, promptId, challenge, signedMessage, plaintext } =
      await setupBoundUnlock(terms);

    const { statusCode, responseData } = await invokeUnlock({
      token: challenge.token,
      promptId,
      address: buyer.publicKey(),
      signedMessage,
    });

    expect(statusCode).toBe(200);
    expect(responseData.plaintext).toBe(plaintext);
    expect(challenge.challenge).toContain("terms:");
    expect(challenge.quote?.termsHash).toHaveLength(64);
  });

  it("rejects when price changed after challenge issuance", async () => {
    const terms = sampleTerms();
    const { buyer, promptId, challenge, signedMessage } =
      await setupBoundUnlock(terms);

    resolveListingQuoteMock.mockResolvedValue(
      toListingQuote({ ...terms, priceStroops: "99000000" }),
    );

    const { statusCode, responseData } = await invokeUnlock({
      token: challenge.token,
      promptId,
      address: buyer.publicKey(),
      signedMessage,
    });

    expect(statusCode).toBe(409);
    expect(responseData.code).toBe(ErrorCode.TERMS_CHANGED);
    expect(responseData.changes).toContain("price");
    expect((responseData.quote as { priceStroops: string }).priceStroops).toBe(
      "99000000",
    );
  });

  it("rejects when asset changed", async () => {
    const terms = sampleTerms();
    const { buyer, promptId, challenge, signedMessage } =
      await setupBoundUnlock(terms);

    resolveListingQuoteMock.mockResolvedValue(
      toListingQuote({
        ...terms,
        asset: "CASSETCHANGED0000000000000000000000000000000000000000000",
      }),
    );

    const { statusCode, responseData } = await invokeUnlock({
      token: challenge.token,
      promptId,
      address: buyer.publicKey(),
      signedMessage,
    });

    expect(statusCode).toBe(409);
    expect(responseData.code).toBe(ErrorCode.TERMS_CHANGED);
    expect(responseData.changes).toContain("asset");
  });

  it("rejects when seller changed", async () => {
    const terms = sampleTerms();
    const { buyer, promptId, challenge, signedMessage } =
      await setupBoundUnlock(terms);

    resolveListingQuoteMock.mockResolvedValue(
      toListingQuote({
        ...terms,
        seller: "GNEWSELLER000000000000000000000000000000000000000000000",
      }),
    );

    const { statusCode, responseData } = await invokeUnlock({
      token: challenge.token,
      promptId,
      address: buyer.publicKey(),
      signedMessage,
    });

    expect(statusCode).toBe(409);
    expect(responseData.code).toBe(ErrorCode.TERMS_CHANGED);
    expect(responseData.changes).toContain("seller");
  });

  it("rejects when prompt version changed", async () => {
    const terms = sampleTerms();
    const { buyer, promptId, challenge, signedMessage } =
      await setupBoundUnlock(terms);

    resolveListingQuoteMock.mockResolvedValue(
      toListingQuote({ ...terms, versionIndex: 4 }),
    );

    const { statusCode, responseData } = await invokeUnlock({
      token: challenge.token,
      promptId,
      address: buyer.publicKey(),
      signedMessage,
    });

    expect(statusCode).toBe(409);
    expect(responseData.code).toBe(ErrorCode.TERMS_CHANGED);
    expect(responseData.changes).toContain("version");
  });

  it("challenge message and token bind termsHash", () => {
    const terms = sampleTerms();
    const address = Keypair.random().publicKey();
    const challenge = createChallengeToken(SECRET, address, "42", {
      now: 1_700_000_000_000,
      terms,
    });
    const payload = verifyChallengeToken(
      SECRET,
      challenge.token,
      address,
      "42",
      1_700_000_060_000,
    );
    expect(payload.termsHash).toBe(challenge.quote?.termsHash);
    expect(buildChallengeMessage(payload)).toContain(
      `terms:${payload.termsHash}`,
    );
  });
});

describe("pre-sign quote freshness (#239)", () => {
  it("assertQuoteFresh throws ListingTermsChangedError without allowing sign", () => {
    const bound = toListingQuote(sampleTerms());
    const live = toListingQuote({ ...sampleTerms(), priceStroops: "1" });
    expect(() => assertQuoteFresh(bound, live)).toThrow(ListingTermsChangedError);
    try {
      assertQuoteFresh(bound, live);
    } catch (err) {
      expect(err).toBeInstanceOf(ListingTermsChangedError);
      expect((err as ListingTermsChangedError).changes).toContain("price");
      expect((err as ListingTermsChangedError).quote.priceStroops).toBe("1");
    }
  });

  it("assertQuoteFresh allows identical quotes", () => {
    const quote = toListingQuote(sampleTerms());
    expect(() => assertQuoteFresh(quote, { ...quote })).not.toThrow();
  });
});
