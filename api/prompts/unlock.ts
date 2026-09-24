import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  buildChallengeMessage,
  globalNonceLedger,
  verifyChallengeSignature,
  verifyChallengeToken,
} from "../../src/lib/auth/challenge";
import {
  decryptPromptCiphertext,
  hashPromptPlaintext,
  normalizeContentHash,
  unwrapPromptKey,
} from "../../src/lib/crypto/promptCrypto";
import {
  decryptSymmetricSync,
  getKmsMasterKeySync,
  unwrapServerPrivateKey,
  buildAAD,
  validateKeyPolicy,
  decryptPromptCiphertextWithAADSync,
  buildPromptAAD,
  buildKmsAAD,
} from "../../src/lib/crypto/kms";
import {
  getPrompt,
  hasAccess,
  type PromptHashConfig,
} from "../../src/lib/stellar/promptHashClient";
import { fetchCiphertextFromIpfs } from "../../src/lib/ipfs/gateway";
import { isIpfsReference } from "../../src/lib/ipfs/reference";
import { withObservability } from "../../src/lib/observability/wrapper";
import { checkRateLimit } from "../../src/lib/observability/rateLimiter";
import { checkReplayProtection } from "../../src/lib/observability/replayProtection";
import { metrics } from "../../src/lib/observability/metrics";
import { dispatchEvent } from "../../server/src/services/webhookDispatcher";
import { recordAuditEvent } from "../../server/src/services/auditTrail";
import { apiError, ErrorCode } from "../../src/lib/api/errorCodes";
import { validateUnlockSecrets } from "../../src/lib/validation/envValidator";
import { unlockSchema } from "../../src/lib/validation/apiSchemas";
import {
  POLICY_UNAVAILABLE_MESSAGE,
  evaluateUnlockFulfillmentPolicy,
  findFulfillmentRecord,
  globalUnlockPolicyCache,
} from "../../src/lib/unlock/unlockPolicy";

export interface UnlockRequest {
  token: string;
  promptId: string;
  address: string;
  signedMessage: string;
}

export interface UnlockSuccessResponse {
  promptId: string;
  title: string;
  contentHash: string;
  plaintext: string;
}

// Fail-fast module load validation
try {
  validateUnlockSecrets();
} catch (err: any) {
  console.error(err.message);
}

/**
 * Get active secrets for token verification
 * Supports multiple secrets during rotation grace period
 */
function getActiveSecrets(primarySecret: string): string[] {
  const secrets = [primarySecret];
  
  // Check for previous secret within grace period
  const previousSecret = process.env.CHALLENGE_TOKEN_SECRET_PREVIOUS;
  const rotationTimestamp = parseInt(
    process.env.CHALLENGE_TOKEN_ROTATION_TIMESTAMP || "0",
    10
  );
  const gracePeriodMs = parseInt(
    process.env.CHALLENGE_TOKEN_GRACE_PERIOD_MS || "300000", // 5 minutes default
    10
  );
  
  if (previousSecret && rotationTimestamp) {
    const timeSinceRotation = Date.now() - rotationTimestamp;
    if (timeSinceRotation < gracePeriodMs) {
      secrets.push(previousSecret);
    }
  }
  
  return secrets;
}

function getServerConfig(): PromptHashConfig {
  const rpcUrl =
    process.env.PUBLIC_STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
  const networkPassphrase =
    process.env.PUBLIC_STELLAR_NETWORK_PASSPHRASE ??
    "Test SDF Network ; September 2015";
  const promptHashContractId = process.env.PUBLIC_PROMPT_HASH_CONTRACT_ID ?? "";
  const nativeAssetContractId =
    process.env.PUBLIC_STELLAR_NATIVE_ASSET_CONTRACT_ID ??
    "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  const simulationAccount =
    process.env.PUBLIC_STELLAR_SIMULATION_ACCOUNT ?? process.env.UNLOCK_PUBLIC_KEY ?? "";

  return {
    rpcUrl,
    networkPassphrase,
    promptHashContractId,
    nativeAssetContractId,
    simulationAccount,
    allowHttp: new URL(rpcUrl).hostname === "localhost",
  };
}

async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  try {
    validateUnlockSecrets();
  } catch (err: any) {
    console.error("Configuration validation failed", { error: err.message });
    res.status(500).json(apiError(ErrorCode.CONFIGURATION_ERROR, "Configuration error."));
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json(apiError(ErrorCode.METHOD_NOT_ALLOWED, "Method not allowed."));
    return;
  }

 const validation = unlockSchema.safeParse(req.body);

if (!validation.success) {
  res.status(400).json(
    apiError(
      ErrorCode.MISSING_FIELDS,
      "Invalid request payload.",
      {
        details: validation.error.flatten(),
      },
    ),
  );
  return;
}

const { token, promptId, address, signedMessage } = validation.data;

const clientIp = String(
  req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown",
);

const redactedAddress = String(address).slice(0, 8) + "...";

  // Authenticated bucket: wallet address is present.
  const isAuthenticated = Boolean(address);

  // Rate limit by IP (unauthenticated bucket — strictest guard).
  const ipRateLimit = await checkRateLimit("unlock", clientIp, false);
  if (!ipRateLimit.success) {
    req.logger.warn({ clientIp }, "Rate limit exceeded for unlock (IP)");
    metrics.trackRateLimitHit("unlock_ip", clientIp);
    void recordAuditEvent({
      action: "unlock_rate_limited",
      result: "blocked",
      promptId: promptId ? String(promptId) : null,
      walletAddress: address ? String(address) : null,
      requestId: req.requestId ?? null,
      clientIp,
      reason: "ip_rate_limit_exceeded",
    });
    res.setHeader("X-RateLimit-Limit", ipRateLimit.limit);
    res.setHeader("X-RateLimit-Remaining", 0);
    res.setHeader("X-RateLimit-Reset", ipRateLimit.reset);
    res.status(429).json(
      apiError(ErrorCode.RATE_LIMIT_IP, "Too many requests. Please try again later.", {
        reset: ipRateLimit.reset,
      }),
    );
    return;
  }

  // Rate limit by wallet address (authenticated bucket — per-wallet brute-force guard).
  if (address) {
    const walletRateLimit = await checkRateLimit("unlock", String(address), isAuthenticated);
    if (!walletRateLimit.success) {
      req.logger.warn({ address: redactedAddress }, "Rate limit exceeded for unlock (Wallet)");
      metrics.trackRateLimitHit("unlock_wallet", String(address));
      void recordAuditEvent({
        action: "unlock_rate_limited",
        result: "blocked",
        promptId: promptId ? String(promptId) : null,
        walletAddress: String(address),
        requestId: req.requestId ?? null,
        clientIp,
        reason: "wallet_rate_limit_exceeded",
      });
      res.setHeader("X-RateLimit-Limit", walletRateLimit.limit);
      res.setHeader("X-RateLimit-Remaining", 0);
      res.setHeader("X-RateLimit-Reset", walletRateLimit.reset);
      res.status(429).json(
        apiError(ErrorCode.RATE_LIMIT_WALLET, "Too many unlock attempts for this wallet.", {
          reset: walletRateLimit.reset,
        }),
      );
      return;
    }
  }

  const challengeSecret = process.env.CHALLENGE_TOKEN_SECRET;
  const unlockPublicKey = process.env.UNLOCK_PUBLIC_KEY;
  const unlockPrivateKey = process.env.UNLOCK_PRIVATE_KEY;

  if (!challengeSecret || !unlockPublicKey || !unlockPrivateKey) {
    req.logger.error("Unlock service is missing configuration secrets.");
    res.status(500).json(apiError(ErrorCode.CONFIGURATION_ERROR, "Configuration error."));
    return;
  }

  

  try {
    // 1. Verify challenge token signature & payload parameters
    const activeSecrets = getActiveSecrets(challengeSecret);
    const payload = verifyChallengeToken(
      activeSecrets,
      String(token),
      String(address),
      String(promptId),
    );

    // 2. Prevent challenge token replay via globalNonceLedger
    const nonceConsumed = globalNonceLedger.consume(payload.nonce, payload.expiresAt);
    if (!nonceConsumed) {
      req.logger.warn({ address: redactedAddress, promptId }, "Challenge nonce replay detected");
      metrics.trackUnlockFailure(String(address), String(promptId), "replay_detected");
      void recordAuditEvent({
        action: "unlock_replay_detected",
        result: "blocked",
        promptId: String(promptId),
        walletAddress: String(address),
        requestId: req.requestId ?? null,
        clientIp,
        reason: "nonce_reused",
      });
      res.status(400).json(
        apiError(ErrorCode.TEMPORARY_FAILURE, "This unlock request has already been processed."),
      );
      return;
    }

    // 3. Verify challenge message signature against payload address
    const challengeMessage = buildChallengeMessage(payload);
    const validSignature = verifyChallengeSignature(
      payload.address,
      challengeMessage,
      String(signedMessage),
    );

    if (!validSignature) {
      req.logger.warn({ address: redactedAddress, promptId }, "Invalid wallet signature");
      metrics.trackUnlockFailure(String(address), String(promptId), "invalid_signature");
      void recordAuditEvent({
        action: "unlock_invalid_signature",
        result: "failure",
        promptId: String(promptId),
        walletAddress: String(address),
        requestId: req.requestId ?? null,
        clientIp,
        reason: "invalid_signature",
      });
      res.status(401).json(apiError(ErrorCode.INVALID_SIGNATURE, "Invalid wallet signature."));
      return;
    }

    // 4. Secondary replay protection guard
    const replayCheck = await checkReplayProtection(
      String(token),
      String(signedMessage),
    );
    if (!replayCheck.valid) {
      req.logger.warn({ address: redactedAddress, promptId }, "Replay attack detected in store");
      metrics.trackUnlockFailure(String(address), String(promptId), "replay_detected");
      void recordAuditEvent({
        action: "unlock_replay_detected",
        result: "blocked",
        promptId: String(promptId),
        walletAddress: String(address),
        requestId: req.requestId ?? null,
        clientIp,
        reason: "replay_attack",
      });
      res.status(400).json(
        apiError(ErrorCode.TEMPORARY_FAILURE, "This unlock request has already been processed."),
      );
      return;
    }

    // 5. On-chain Soroban access verification
    const config = getServerConfig();
    const id = BigInt(promptId);
    const access = await hasAccess(config, String(address), id);
    if (!access) {
      req.logger.warn({ address: redactedAddress, promptId }, "Prompt access denied");
      metrics.trackUnlockFailure(String(address), String(promptId), "no_access");
      void recordAuditEvent({
        action: "unlock_no_access",
        result: "failure",
        promptId: String(promptId),
        walletAddress: String(address),
        requestId: req.requestId ?? null,
        clientIp,
        reason: "no_access",
      });
      res.status(403).json(
        apiError(ErrorCode.ACCESS_NOT_PURCHASED, "Prompt access has not been purchased."),
      );
      return;
    }

    // Check key policy rules (retention/hold/delisting)
    try {
      validateKeyPolicy(String(promptId));
    } catch (policyErr: any) {
      req.logger.warn({ address: redactedAddress, promptId }, policyErr.message);
      res.status(403).json(apiError(ErrorCode.ACCESS_NOT_PURCHASED, policyErr.message));
      return;
    }

    // Dynamic dispute / refund hold — fail closed on lookup errors (#166).
    // Delisting / retention already enforced above via validateKeyPolicy.
    const policyDecision = await evaluateUnlockFulfillmentPolicy({
      promptId: String(promptId),
      buyerWallet: String(address),
      findFulfillment: findFulfillmentRecord,
      signingSecret: challengeSecret,
      cache: globalUnlockPolicyCache,
    });
    if (policyDecision.outcome === "deny") {
      req.logger.warn(
        { address: redactedAddress, promptId, reason: policyDecision.reason },
        "Unlock blocked by fulfillment policy",
      );
      metrics.trackUnlockFailure(String(address), String(promptId), policyDecision.reason);
      void recordAuditEvent({
        action: "unlock_policy_denied",
        result: "blocked",
        promptId: String(promptId),
        walletAddress: String(address),
        requestId: req.requestId ?? null,
        clientIp,
        reason: policyDecision.reason,
      });
      res.status(403).json(
        apiError(ErrorCode.ACCESS_NOT_PURCHASED, policyDecision.message),
      );
      return;
    }
    if (policyDecision.outcome === "unavailable") {
      req.logger.warn(
        {
          address: redactedAddress,
          promptId,
          cause: policyDecision.cause,
        },
        "Unlock policy lookup unavailable (fail closed)",
      );
      metrics.trackUnlockFailure(String(address), String(promptId), "policy_unavailable");
      void recordAuditEvent({
        action: "unlock_policy_unavailable",
        result: "blocked",
        promptId: String(promptId),
        walletAddress: String(address),
        requestId: req.requestId ?? null,
        clientIp,
        reason: "policy_lookup_failed",
      });
      res.status(503).json(
        apiError(ErrorCode.TEMPORARY_FAILURE, POLICY_UNAVAILABLE_MESSAGE),
      );
      return;
    }

    // 6. Decrypt plaintext content
    const prompt = await getPrompt(config, id);
    const wrappedKeyStr = prompt.wrappedKey;

    const ciphertext = isIpfsReference(prompt.encryptedPrompt)
      ? await fetchCiphertextFromIpfs(prompt.encryptedPrompt)
      : prompt.encryptedPrompt;

    let keyBytes: Uint8Array;
    let plaintext: string;

    if (wrappedKeyStr.startsWith("env:v2:")) {
      // Envelope-encrypted DEK format: env:v2:<kmsKeyVersion>:<iv>:<tag>:<ciphertext>
      const [, , kmsKeyVersion, kmsIv, kmsTag, kmsCiphertext] = wrappedKeyStr.split(":");
      
      const kmsAad = buildKmsAAD({
        promptId: promptId.toString(),
        creator: prompt.creator || "",
        contentHash: prompt.contentHash || "",
        version: "2.0.0",
        nonce: prompt.encryptionIv,
        ciphertext,
      });

      const kmsMasterKey = getKmsMasterKeySync(kmsKeyVersion);
      keyBytes = decryptSymmetricSync(kmsCiphertext, kmsIv, kmsTag, kmsMasterKey, kmsAad);

      const promptAad = buildPromptAAD({
        promptId: promptId.toString(),
        creator: prompt.creator || "",
        contentHash: prompt.contentHash || "",
        version: "2.0.0",
        nonce: prompt.encryptionIv,
      });
      
      plaintext = decryptPromptCiphertextWithAADSync(
        ciphertext,
        prompt.encryptionIv,
        keyBytes,
        promptAad,
      );
    } else {
      // Legacy fallback
      const decryptedPrivateKey = unwrapServerPrivateKey(unlockPrivateKey);
      keyBytes = await unwrapPromptKey(
        wrappedKeyStr,
        unlockPublicKey,
        decryptedPrivateKey,
      );
      plaintext = await decryptPromptCiphertext(
        ciphertext,
        prompt.encryptionIv,
        keyBytes,
      );
    }
    const contentHash = await hashPromptPlaintext(plaintext);
    const storedHash = normalizeContentHash(prompt.contentHash);
    if (contentHash !== storedHash) {
      req.logger.error({ address: redactedAddress, promptId }, "Prompt integrity check failed");
      metrics.trackUnlockFailure(String(address), String(promptId), "integrity_failure");
      void recordAuditEvent({
        action: "unlock_integrity_failure",
        result: "failure",
        promptId: String(promptId),
        walletAddress: String(address),
        requestId: req.requestId ?? null,
        clientIp,
        reason: "integrity_failure",
      });
      res.status(500).json(
        apiError(ErrorCode.INTEGRITY_FAILURE, "Prompt integrity check failed."),
      );
      return;
    }

    metrics.trackUnlockSuccess(String(address), String(promptId));
    req.logger.info({ address: redactedAddress, promptId }, "Prompt unlocked successfully");
    void recordAuditEvent({
      action: "unlock_success",
      result: "success",
      promptId: String(promptId),
      walletAddress: String(address),
      requestId: req.requestId ?? null,
      clientIp,
      reason: null,
    });

    // Fire-and-forget webhook dispatch
    void Promise.resolve(
      dispatchEvent(prompt.creator ?? "", "PromptPurchased", {
        promptId: prompt.id.toString(),
        buyer: String(address),
        title: prompt.title,
      }),
    ).catch(() => {});

    const successResponse: UnlockSuccessResponse = {
      promptId: prompt.id.toString(),
      title: prompt.title,
      contentHash,
      plaintext,
    };
    res.status(200).json(successResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to unlock prompt.";
    req.logger.error({ address: redactedAddress, promptId, error: message }, "Unlock attempt failed");
    metrics.trackUnlockFailure(String(address), String(promptId), "error");

    const isExpired = message.toLowerCase().includes("expired");
    const isMismatch = message.toLowerCase().includes("mismatch") || message.toLowerCase().includes("does not match");
    const isInvalidSig = message.toLowerCase().includes("invalid challenge token signature");

    void recordAuditEvent({
      action: isExpired ? "unlock_expired_challenge" : "unlock_error",
      result: "failure",
      promptId: promptId ? String(promptId) : null,
      walletAddress: address ? String(address) : null,
      requestId: req.requestId ?? null,
      clientIp,
      reason: isExpired ? "expired_challenge" : isMismatch ? "mismatch" : "error",
    });

    if (isExpired) {
      res.status(401).json(
        apiError(ErrorCode.CHALLENGE_EXPIRED, "The challenge token has expired. Please request a new one."),
      );
    } else if (isMismatch || isInvalidSig) {
      res.status(401).json(
        apiError(ErrorCode.INVALID_SIGNATURE, message),
      );
    } else {
      res.status(400).json(
        apiError(ErrorCode.TEMPORARY_FAILURE, message),
      );
    }
  }
}

export default withObservability(handler, "prompts/unlock");
