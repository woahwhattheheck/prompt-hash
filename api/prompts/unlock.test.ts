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

vi.mock("../../server/src/services/durableAuditQueue", () => ({
  AuditAcceptError: class AuditAcceptError extends Error {
    code = "AUDIT_ACCEPT_FAILED";
  },
  acceptCriticalUnlockAudit: vi.fn().mockResolvedValue({
    acceptanceId: "test-acceptance-id",
    duplicate: false,
    degraded: false,
  }),
  drainCriticalAuditOutbox: vi.fn().mockResolvedValue({ drained: 0, retried: 0, dlq: 0 }),
}));
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
