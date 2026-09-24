import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createChallengeToken } from "../../src/lib/auth/challenge";
import { resolveListingQuote } from "../../src/lib/auth/resolveListingQuote";
import type { ListingQuote } from "../../src/lib/auth/listingTerms";
import { withObservability } from "../../src/lib/observability/wrapper";
import { checkRateLimit } from "../../src/lib/observability/rateLimiter";
import { metrics } from "../../src/lib/observability/metrics";
import { recordAuditEvent } from "../../server/src/services/auditTrail";
import { apiError, ErrorCode } from "../../src/lib/api/errorCodes";
import { isPlaceholder } from "../../src/lib/validation/envValidator";
import { challengeSchema } from "../../src/lib/validation/apiSchemas";

type ExtendedRequest = VercelRequest & {
  logger: {
    info: (meta: any, msg: string) => void;
    warn: (meta: any, msg: string) => void;
    error: (msg: string) => void;
  };
  requestId?: string | null;
};

export interface ChallengeRequest {
  address: string;
  promptId: string;
}

export interface ChallengeResponse {
  token: string;
  challenge: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  /** Immutable listing quote bound into the challenge (#239). */
  quote: ListingQuote;
}

// Fail-fast module-load validation: reject startup if secrets are missing.
(function validateEnv(): void {
  const secret = process.env.CHALLENGE_TOKEN_SECRET;
  if (!secret || isPlaceholder(secret) || secret.length < 16) {
    console.error(
      "FATAL: CHALLENGE_TOKEN_SECRET is missing, placeholder, or too short (< 16 chars).",
    );
    if (process.env.NODE_ENV === "production") {
      throw new Error("CHALLENGE_TOKEN_SECRET not configured.");
    }
  }
})();

async function handler(
  req: ExtendedRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== "POST") {
    res
      .status(405)
      .json(apiError(ErrorCode.METHOD_NOT_ALLOWED, "Method not allowed."));
    return;
  }

  const validation = challengeSchema.safeParse(req.body);

  if (!validation.success) {
  res.status(400).json(
    apiError(
      ErrorCode.MISSING_FIELDS,
      "Invalid request payload.",
    ),
  );
  return;
}

  const { address, promptId } = validation.data;

  const clientIp = String(
    req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown",
  );

  const isAuthenticated = Boolean(address);

  const rateLimit = await checkRateLimit(
    "challenge",
    clientIp,
    isAuthenticated,
  );

  if (!rateLimit.success) {
    req.logger.warn({ clientIp }, "Rate limit exceeded for challenge issuance");
    metrics.trackRateLimitHit("challenge", clientIp);

    void recordAuditEvent({
      action: "challenge_rate_limited",
      result: "blocked",
      promptId: address && promptId ? String(promptId) : null,
      walletAddress: address ? String(address) : null,
      requestId: req.requestId ?? null,
      clientIp,
      reason: "rate_limit_exceeded",
    });

    res.setHeader("X-RateLimit-Limit", rateLimit.limit);
    res.setHeader("X-RateLimit-Remaining", 0);
    res.setHeader("X-RateLimit-Reset", rateLimit.reset);

    res.status(429).json(
      apiError(
        ErrorCode.RATE_LIMIT_IP,
        "Too many requests. Please try again later.",
        {
          reset: rateLimit.reset,
        },
      ),
    );
    return;
  }

  res.setHeader("X-RateLimit-Limit", rateLimit.limit);
  res.setHeader("X-RateLimit-Remaining", rateLimit.remaining);
  res.setHeader("X-RateLimit-Reset", rateLimit.reset);

  const secret = process.env.CHALLENGE_TOKEN_SECRET;

  if (!secret || isPlaceholder(secret) || secret.length < 16) {
    req.logger.error("CHALLENGE_TOKEN_SECRET is not configured correctly.");
    res
      .status(500)
      .json(apiError(ErrorCode.CONFIGURATION_ERROR, "Configuration error."));
    return;
  }

  let quote: ListingQuote;
  try {
    quote = await resolveListingQuote(String(promptId));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Listing unavailable.";
    req.logger.warn({ promptId: String(promptId), error: message }, "Failed to resolve listing quote for challenge");
    void recordAuditEvent({
      action: "challenge_listing_unavailable",
      result: "failure",
      promptId: String(promptId),
      walletAddress: String(address),
      requestId: req.requestId ?? null,
      clientIp,
      reason: "listing_unavailable",
    });
    res.status(404).json(
      apiError(
        ErrorCode.MISSING_FIELDS,
        "Prompt listing is unavailable. Refresh the page and try again.",
      ),
    );
    return;
  }

  if (!quote.active) {
    res.status(409).json(
      apiError(
        ErrorCode.TERMS_CHANGED,
        "This listing is no longer available for unlock. Refresh to see current status.",
        { quote, changes: ["active"] },
      ),
    );
    return;
  }

  const MAX_TTL_MS = 10 * 60 * 1000;
  const ttlMs = Math.min(5 * 60 * 1000, MAX_TTL_MS);

  const challenge = createChallengeToken(secret, String(address), String(promptId), {
    now: Date.now(),
    ttlMs,
    terms: quote,
  });

  const response: ChallengeResponse = {
    token: challenge.token,
    challenge: challenge.challenge,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    nonce: challenge.nonce,
    quote,
  };

  metrics.trackChallengeIssued(String(address), String(promptId));

  const redactedAddress = String(address).slice(0, 8) + "...";

  req.logger.info(
    { address: redactedAddress, promptId: String(promptId), termsHash: quote.termsHash },
    "Challenge token issued successfully",
  );

  void recordAuditEvent({
    action: "challenge_issued",
    result: "success",
    promptId: String(promptId),
    walletAddress: String(address),
    requestId: req.requestId ?? null,
    clientIp,
    reason: null,
  });

  res.status(200).json(response);
}

export default withObservability(handler, "auth/challenge");
