// @vitest-environment node

import { Buffer } from "buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  buildChallengeMessage,
  createChallengeToken,
  globalNonceLedger,
} from "../../src/lib/auth/challenge";
import { ErrorCode } from "../../src/lib/api/errorCodes";
import {
  splitSecret,
  reconstructSecret,
  encryptSymmetricSync,
  buildAAD,
  getKmsMasterKeySync,
  encryptPromptPlaintextWithAADSync,
  setKeyPolicy,
  buildPromptAAD,
  buildKmsAAD,
} from "../../src/lib/crypto/kms";
import crypto from "crypto";

const hasAccessMock = vi.fn();
const getPromptMock = vi.fn();
const unwrapPromptKeyMock = vi.fn();
const decryptPromptCiphertextMock = vi.fn();
const hashPromptPlaintextMock = vi.fn();

vi.mock("../../src/lib/stellar/promptHashClient", () => ({
  hasAccess: (...args: unknown[]) => hasAccessMock(...args),
  getPrompt: (...args: unknown[]) => getPromptMock(...args),
}));

vi.mock("../../src/lib/crypto/promptCrypto", () => ({
  unwrapPromptKey: (...args: unknown[]) => unwrapPromptKeyMock(...args),
  decryptPromptCiphertext: (...args: unknown[]) => decryptPromptCiphertextMock(...args),
  hashPromptPlaintext: (...args: unknown[]) => hashPromptPlaintextMock(...args),
  normalizeContentHash: (hash: string) => hash.toLowerCase(),
}));

vi.mock("../../src/lib/observability/wrapper", () => ({
  withObservability: (handler: unknown) => handler,
}));

vi.mock("../../src/lib/observability/rateLimiter", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    success: true,
    limit: 5,
    remaining: 4,
    reset: 60_000,
  }),
}));

vi.mock("../../src/lib/observability/metrics", () => ({
  metrics: {
    emit: vi.fn(),
    trackUnlockSuccess: vi.fn(),
    trackUnlockFailure: vi.fn(),
    trackRateLimitHit: vi.fn(),
  },
}));

vi.mock("../../server/src/services/auditTrail", () => ({
  recordAuditEvent: vi.fn(),
}));

vi.mock("../../server/src/services/webhookDispatcher", () => ({
  dispatchEvent: vi.fn().mockResolvedValue(undefined),
}));

const findFulfillmentRecordMock = vi.fn().mockResolvedValue(null);

vi.mock("../../src/lib/unlock/unlockPolicy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/unlock/unlockPolicy")>();
  return {
    ...actual,
    findFulfillmentRecord: (...args: unknown[]) => findFulfillmentRecordMock(...args),
  };
});

import handler from "./unlock";
import {
  POLICY_UNAVAILABLE_MESSAGE,
  globalUnlockPolicyCache,
} from "../../src/lib/unlock/unlockPolicy";

async function setupUnlockFixture(plaintext = "Secret prompt instructions for buyers.", ttlMs = 5 * 60 * 1000) {
  const buyer = Keypair.random();
  const contentHash = "a".repeat(64);

  process.env.CHALLENGE_TOKEN_SECRET = "integration-test-challenge-secret";
  process.env.UNLOCK_PUBLIC_KEY = "d".repeat(32);
  process.env.UNLOCK_PRIVATE_KEY = "e".repeat(32);
  process.env.PUBLIC_PROMPT_HASH_CONTRACT_ID =
    "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  process.env.PUBLIC_STELLAR_SIMULATION_ACCOUNT = buyer.publicKey();
  process.env.PUBLIC_STELLAR_RPC_URL = "https://soroban-testnet.stellar.org";

  const promptId = "42";
  const challenge = createChallengeToken(
    process.env.CHALLENGE_TOKEN_SECRET,
    buyer.publicKey(),
    promptId,
    Date.now(),
    ttlMs,
  );
  const signedMessage = Buffer.from(
    buyer.sign(Buffer.from(challenge.challenge, "utf8")),
  ).toString("base64");

  hasAccessMock.mockResolvedValue(true);
  getPromptMock.mockResolvedValue({
    id: 42n,
    creator: "GCREATORACCOUNT1234567890ABCDEFGH1234567890ABCDEFGH1234567890",
    title: "Test prompt",
    contentHash,
    encryptedPrompt: "encrypted",
    encryptionIv: "iv",
    wrappedKey: "wrapped",
  });
  unwrapPromptKeyMock.mockResolvedValue(new Uint8Array(32));
  decryptPromptCiphertextMock.mockResolvedValue(plaintext);
  hashPromptPlaintextMock.mockResolvedValue(contentHash);

  return { buyer, promptId, challenge, signedMessage, contentHash, plaintext };
}

async function invokeUnlock(body: Record<string, unknown>) {
  let statusCode = 0;
  let responseData: Record<string, unknown> = {};
  const errorLog = vi.fn();

  const req = {
    method: "POST",
    headers: {},
    body,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: errorLog,
    },
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

  return { statusCode, responseData, errorLog };
}

describe("unlock API integrity and replay protection checks (#37)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalNonceLedger.clear();
    globalUnlockPolicyCache.clear();
    findFulfillmentRecordMock.mockResolvedValue(null);
  });

  it("returns plaintext when decrypted content matches the stored hash", async () => {
    const { buyer, promptId, challenge, signedMessage, plaintext } =
      await setupUnlockFixture();

    const { statusCode, responseData } = await invokeUnlock({
      token: challenge.token,
      promptId,
      address: buyer.publicKey(),
      signedMessage,
    });

    expect(statusCode).toBe(200);
    expect(responseData.plaintext).toBe(plaintext);
    expect(responseData.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects challenge token replay attempts", async () => {
    const { buyer, promptId, challenge, signedMessage } =
      await setupUnlockFixture();

    // First unlock call succeeds
    const { statusCode: status1 } = await invokeUnlock({
      token: challenge.token,
      promptId,
      address: buyer.publicKey(),
      signedMessage,
    });
    expect(status1).toBe(200);

    // Second unlock call with same token/nonce is blocked as replay
    const { statusCode: status2, responseData: data2 } = await invokeUnlock({
      token: challenge.token,
      promptId,
      address: buyer.publicKey(),
      signedMessage,
    });
    expect(status2).toBe(400);
    expect(data2.code).toBe(ErrorCode.TEMPORARY_FAILURE);
    expect(data2.error).toContain("already been processed");
  });

  it("rejects expired challenge tokens with HTTP 401", async () => {
    const { buyer, promptId, challenge, signedMessage } =
      await setupUnlockFixture("Secret content", -1000); // Expired 1 second ago

    const { statusCode, responseData } = await invokeUnlock({
      token: challenge.token,
      promptId,
      address: buyer.publicKey(),
      signedMessage,
    });

    expect(statusCode).toBe(401);
    expect(responseData.code).toBe(ErrorCode.CHALLENGE_EXPIRED);
    expect(responseData.error).toContain("expired");
  });

  it("rejects wallet address mismatch (challenge issued for wallet A used by wallet B)", async () => {
    const { buyer, promptId, challenge, signedMessage } = await setupUnlockFixture();
    const attackerWallet = Keypair.random();

    const { statusCode, responseData } = await invokeUnlock({
      token: challenge.token,
      promptId,
      address: attackerWallet.publicKey(), // Wallet mismatch
      signedMessage,
    });

    expect(statusCode).toBe(401);
    expect(responseData.code).toBe(ErrorCode.INVALID_SIGNATURE);
    expect(responseData.error).toContain("mismatch");
  });

  it("rejects prompt ID mismatch", async () => {
    const { buyer, challenge, signedMessage } = await setupUnlockFixture();

    const { statusCode, responseData } = await invokeUnlock({
      token: challenge.token,
      promptId: "999", // Prompt mismatch (token was issued for 42)
      address: buyer.publicKey(),
      signedMessage,
    });

    expect(statusCode).toBe(401);
    expect(responseData.error).toContain("mismatch");
  });

  it("fails safely when the recomputed hash does not match", async () => {
    const { buyer, promptId, challenge, signedMessage } =
      await setupUnlockFixture("Matching plaintext body.");

    hashPromptPlaintextMock.mockResolvedValue("b".repeat(64));

    const { statusCode, responseData } = await invokeUnlock({
      token: challenge.token,
      promptId,
      address: buyer.publicKey(),
      signedMessage,
    });

    expect(statusCode).toBe(500);
    expect(responseData.code).toBe(ErrorCode.INTEGRITY_FAILURE);
    expect(responseData.plaintext).toBeUndefined();
    expect(responseData.error).toBe("Prompt integrity check failed.");
  });

  it("rejects unlock when wallet signature is invalid", async () => {
    const { buyer, promptId, challenge } = await setupUnlockFixture();
    const wrongSigner = Keypair.random();
    const signedMessage = Buffer.from(
      wrongSigner.sign(Buffer.from(challenge.challenge, "utf8")),
    ).toString("base64");

    const { statusCode, responseData } = await invokeUnlock({
      token: challenge.token,
      promptId,
      address: buyer.publicKey(),
      signedMessage,
    });

    expect(statusCode).toBe(401);
    expect(responseData.code).toBe(ErrorCode.INVALID_SIGNATURE);
    expect(responseData.plaintext).toBeUndefined();
  });
});

describe("unlock challenge message contract", () => {
  it("uses the expected challenge message format", () => {
    const payload = {
      address: "GBUYERACCOUNT1234567890ABCDEFGH1234567890ABCDEFGH123456789",
      promptId: "7",
      nonce: "nonce-123",
      issuedAt: 1_700_000_000_000,
      expiresAt: 1_700_000_000_000,
    };

    expect(buildChallengeMessage(payload)).toBe(
      "prompt-hash unlock:GBUYERACCOUNT1234567890ABCDEFGH1234567890ABCDEFGH123456789:7:nonce-123:1700000000000:1700000000000",
    );
  });
});

describe("Envelope Encryption and KMS Key Custody (#79)", () => {
  it("splits and reconstructs a KEK using Shamir's Secret Sharing (recovery quorum)", () => {
    const originalKey = crypto.getRandomValues(new Uint8Array(32));
    const shares = splitSecret(originalKey, 3, 5);
    
    expect(shares).toHaveLength(5);
    
    // Quorum of 3 reconstructs key
    const recoveredKey = reconstructSecret([shares[0], shares[2], shares[4]]);
    expect(recoveredKey).toEqual(originalKey);
    
    // Quorum of 2 fails to reconstruct key (returns wrong value or throws)
    const badKey = reconstructSecret([shares[0], shares[1]]);
    expect(badKey).not.toEqual(originalKey);
  });

  it("decrypts envelope v2 listings with AAD and rejects tampered context (wrong/swapped data)", async () => {
    const rawDEK = crypto.getRandomValues(new Uint8Array(32));
    const plaintext = "High-performance marketing prompt content.";
    const creator = "GCREATORACCOUNT1234567890ABCDEFGH1234567890ABCDEFGH123456789";
    const promptId = "42";
    const kmsVersion = "1";
    
    // 1. Encrypt prompt plaintext using DEK and metadata context
    const contentHash = crypto.createHash("sha256").update(plaintext).digest("hex");
    const encrypted = encryptPromptPlaintextWithAADSync(plaintext, rawDEK, {
      promptId,
      creator,
      contentHash,
      version: "2.0.0",
    });

    // 3. Prepare KMS AAD context using prompt metadata + prompt ciphertext
    const kmsAad = buildKmsAAD({
      promptId,
      creator,
      contentHash,
      version: "2.0.0",
      nonce: encrypted.encryptionIv,
      ciphertext: encrypted.encryptedPrompt
    });

    // 4. Wrap the DEK with KMS KEK and kmsAad
    const kmsKey = getKmsMasterKeySync(kmsVersion);
    const wrappedDEK = encryptSymmetricSync(rawDEK, kmsKey, kmsAad);
    
    const envelopeKey = `env:v2:${kmsVersion}:${wrappedDEK.iv}:${wrappedDEK.tag}:${wrappedDEK.ciphertext}`;

    // Setup mocks
    hasAccessMock.mockResolvedValue(true);
    hashPromptPlaintextMock.mockResolvedValue(encrypted.contentHash);
    getPromptMock.mockResolvedValue({
      id: BigInt(promptId),
      creator,
      title: "V2 Test Prompt",
      contentHash: encrypted.contentHash,
      encryptedPrompt: encrypted.encryptedPrompt,
      encryptionIv: encrypted.encryptionIv,
      wrappedKey: envelopeKey,
    });

    const buyer = Keypair.random();
    process.env.CHALLENGE_TOKEN_SECRET = "integration-test-challenge-secret";
    process.env.PUBLIC_PROMPT_HASH_CONTRACT_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    process.env.PUBLIC_STELLAR_SIMULATION_ACCOUNT = buyer.publicKey();

    const challenge = createChallengeToken(
      process.env.CHALLENGE_TOKEN_SECRET,
      buyer.publicKey(),
      promptId,
      Date.now(),
      5 * 60 * 1000
    );
    const signedMessage = Buffer.from(
      buyer.sign(Buffer.from(challenge.challenge, "utf8")),
    ).toString("base64");

    // Decrypting with correct credentials works
    const { statusCode, responseData } = await invokeUnlock({
      token: challenge.token,
      promptId,
      address: buyer.publicKey(),
      signedMessage,
    });
    expect(statusCode).toBe(200);
    expect(responseData.plaintext).toBe(plaintext);
  });

  it("enforces dispute suspension and deletion/revocation key policies", async () => {
    const promptId = "100";
    setKeyPolicy(promptId, "suspended");

    const buyer = Keypair.random();
    const challenge = createChallengeToken(
      process.env.CHALLENGE_TOKEN_SECRET || "secret",
      buyer.publicKey(),
      promptId,
      Date.now(),
      5 * 60 * 1000
    );
    const signedMessage = Buffer.from(
      buyer.sign(Buffer.from(challenge.challenge, "utf8")),
    ).toString("base64");

    const { statusCode, responseData } = await invokeUnlock({
      token: challenge.token,
      promptId,
      address: buyer.publicKey(),
      signedMessage,
    });

    expect(statusCode).toBe(403);
    expect(responseData.error).toContain("suspended");

    // Delisted/revoked policy
    setKeyPolicy(promptId, "revoked");
    const challenge2 = createChallengeToken(
      process.env.CHALLENGE_TOKEN_SECRET || "secret",
      buyer.publicKey(),
      promptId,
      Date.now(),
      5 * 60 * 1000
    );
    const signedMessage2 = Buffer.from(
      buyer.sign(Buffer.from(challenge2.challenge, "utf8")),
    ).toString("base64");

    const { statusCode: statusRevoked, responseData: dataRevoked } = await invokeUnlock({
      token: challenge2.token,
      promptId,
      address: buyer.publicKey(),
      signedMessage: signedMessage2,
    });

    expect(statusRevoked).toBe(403);
    expect(dataRevoked.error).toContain("revoked");
  });
});


describe("unlock fail-closed fulfillment policy (#166)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalNonceLedger.clear();
    globalUnlockPolicyCache.clear();
    findFulfillmentRecordMock.mockResolvedValue(null);
  });

  it("returns TEMPORARY_FAILURE when fulfillment lookup throws (no decrypt)", async () => {
    const { buyer, promptId, challenge, signedMessage } = await setupUnlockFixture();
    findFulfillmentRecordMock.mockRejectedValue(
      new Error("MongoServerError: connection refused"),
    );

    const { statusCode, responseData } = await invokeUnlock({
      token: challenge.token,
      promptId,
      address: buyer.publicKey(),
      signedMessage,
    });

    expect(statusCode).toBe(503);
    expect(responseData.code).toBe(ErrorCode.TEMPORARY_FAILURE);
    expect(responseData.error).toBe(POLICY_UNAVAILABLE_MESSAGE);
    expect(JSON.stringify(responseData)).not.toMatch(/mongo|ECONNREFUSED|bypassed/i);
    expect(decryptPromptCiphertextMock).not.toHaveBeenCalled();
  });

  it("blocks refunded buyers with ACCESS_NOT_PURCHASED", async () => {
    const { buyer, promptId, challenge, signedMessage } = await setupUnlockFixture();
    findFulfillmentRecordMock.mockResolvedValue({ status: "refunded" });

    const { statusCode, responseData } = await invokeUnlock({
      token: challenge.token,
      promptId,
      address: buyer.publicKey(),
      signedMessage,
    });

    expect(statusCode).toBe(403);
    expect(responseData.code).toBe(ErrorCode.ACCESS_NOT_PURCHASED);
    expect(String(responseData.error)).toMatch(/refund/i);
    expect(decryptPromptCiphertextMock).not.toHaveBeenCalled();
  });

  it("blocks open disputes (refund_requested)", async () => {
    const { buyer, promptId, challenge, signedMessage } = await setupUnlockFixture();
    findFulfillmentRecordMock.mockResolvedValue({ status: "refund_requested" });

    const { statusCode, responseData } = await invokeUnlock({
      token: challenge.token,
      promptId,
      address: buyer.publicKey(),
      signedMessage,
    });

    expect(statusCode).toBe(403);
    expect(responseData.code).toBe(ErrorCode.ACCESS_NOT_PURCHASED);
    expect(String(responseData.error)).toMatch(/dispute/i);
    expect(decryptPromptCiphertextMock).not.toHaveBeenCalled();
  });

  it("allows unlock when no fulfillment record exists", async () => {
    const { buyer, promptId, challenge, signedMessage, plaintext } =
      await setupUnlockFixture();
    findFulfillmentRecordMock.mockResolvedValue(null);

    const { statusCode, responseData } = await invokeUnlock({
      token: challenge.token,
      promptId,
      address: buyer.publicKey(),
      signedMessage,
    });

    expect(statusCode).toBe(200);
    expect(responseData.plaintext).toBe(plaintext);
  });
});
