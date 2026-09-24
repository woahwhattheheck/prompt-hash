import { ERROR_MESSAGES, type ApiErrorResponse } from "@/lib/api/errorCodes";
import { hashPromptPlaintext } from "@/lib/crypto/promptCrypto";
import {
  diffListingTerms,
  ListingTermsChangedError,
  type ListingQuote,
} from "@/lib/auth/listingTerms";

type SignMessageFn = (_message: string) => Promise<{ signedMessage?: string } | string>;

export interface UnlockResult {
  promptId: string;
  title: string;
  contentHash: string;
  plaintext: string;
  decryptedContent: string;
}

export { ListingTermsChangedError };

async function parseApiError(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as
    | (ApiErrorResponse & { requestId?: string })
    | { error?: string; requestId?: string }
    | null;

  if (payload && typeof payload === "object" && "code" in payload && payload.code) {
    const code = payload.code as keyof typeof ERROR_MESSAGES;
    let baseMsg = ERROR_MESSAGES[code] ?? payload.error ?? "Failed to unlock prompt.";
    if (payload.requestId) {
      baseMsg += ` (Support Ref: ${payload.requestId})`;
    }
    return baseMsg;
  }

  if (payload && typeof payload === "object" && "error" in payload && payload.error) {
    let baseMsg = String(payload.error);
    if (payload.requestId) {
      baseMsg += ` (Support Ref: ${payload.requestId})`;
    }
    return baseMsg;
  }

  return "Failed to unlock prompt.";
}

function extractSignedMessage(
  signature: { signedMessage?: string } | string,
): string {
  if (typeof signature === "string") {
    return signature;
  }
  if (!signature?.signedMessage) {
    throw new Error("Wallet did not return a signed message.");
  }
  return signature.signedMessage;
}

async function requestChallenge(address: string, promptId: string, correlationId?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (correlationId) {
    headers["X-Request-ID"] = correlationId;
    headers["X-Correlation-ID"] = correlationId;
  }

  const response = await fetch("/api/auth/challenge", {
    method: "POST",
    headers,
    body: JSON.stringify({ address, promptId }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorResponse | null;
    if (body?.code === "TERMS_CHANGED" && body.quote) {
      throw new ListingTermsChangedError(
        (body.changes as import("@/lib/auth/listingTerms").ListingTermsChange[]) ?? ["active"],
        body.quote as ListingQuote,
      );
    }
    throw new Error(
      body?.code && ERROR_MESSAGES[body.code]
        ? ERROR_MESSAGES[body.code]
        : body?.error ?? "Failed to unlock prompt.",
    );
  }

  return response.json() as Promise<{
    token: string;
    challenge: string;
    expiresAt: number;
    nonce: string;
    quote?: ListingQuote;
  }>;
}

/**
 * Re-fetch the public listing quote used for the pre-sign stale check (#239).
 */
export async function fetchListingQuote(promptId: string): Promise<ListingQuote> {
  const response = await fetch(
    `/api/prompts/version?promptId=${encodeURIComponent(promptId)}&quote=1`,
  );
  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }
  const body = (await response.json()) as { quote: ListingQuote };
  if (!body?.quote?.termsHash) {
    throw new Error("Listing quote is unavailable.");
  }
  return body.quote;
}

/**
 * Compare a challenge-bound quote against the live listing.
 * Throws ListingTermsChangedError when terms drifted — callers must not sign.
 */
export function assertQuoteFresh(
  bound: ListingQuote,
  live: ListingQuote,
): void {
  const changes = diffListingTerms(bound, live);
  if (changes.length > 0 || bound.termsHash !== live.termsHash) {
    throw new ListingTermsChangedError(changes.length ? changes : ["price"], live);
  }
}

async function requestUnlock(
  params: {
    token: string;
    promptId: string;
    address: string;
    signedMessage: string;
  },
  correlationId?: string,
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (correlationId) {
    headers["X-Request-ID"] = correlationId;
    headers["X-Correlation-ID"] = correlationId;
  }

  const response = await fetch("/api/prompts/unlock", {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorResponse | null;
    if (body?.code === "TERMS_CHANGED" && body.quote) {
      throw new ListingTermsChangedError(
        (body.changes as import("@/lib/auth/listingTerms").ListingTermsChange[]) ?? ["price"],
        body.quote as ListingQuote,
      );
    }
    if (body?.code && ERROR_MESSAGES[body.code]) {
      throw new Error(ERROR_MESSAGES[body.code]);
    }
    throw new Error(body?.error ? String(body.error) : "Failed to unlock prompt.");
  }

  return response.json() as Promise<{
    promptId: string;
    title: string;
    contentHash: string;
    plaintext: string;
  }>;
}

function normalizePromptId(promptId: string | bigint | number): string {
  return typeof promptId === "bigint" ? promptId.toString() : String(promptId);
}

/**
 * Unlock a purchased prompt via challenge → quote refresh → wallet sign → unlock API.
 * Blocks wallet signing when the listing is stale or the price/terms changed (#239).
 */
export async function unlockPromptContent(
  address: string,
  promptId: string | bigint | number,
  signMessage: SignMessageFn,
): Promise<UnlockResult> {
  const id = normalizePromptId(promptId);
  const correlationId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : "f-" + Math.random().toString(36).substring(2, 15) + "-" + Date.now().toString(36);

  console.log(`[Unlock Flow] Started for Prompt ID ${id} with Correlation ID: ${correlationId}`);

  const challenge = await requestChallenge(address, id, correlationId);

  // Pre-sign gate: never ask the wallet to sign a stale quote.
  if (challenge.quote) {
    const liveQuote = await fetchListingQuote(id);
    assertQuoteFresh(challenge.quote, liveQuote);
  }

  const signature = await signMessage(challenge.challenge);

  if (!signature) {
    throw new Error("User declined message signing.");
  }

  const signedMessage = extractSignedMessage(signature);
  const unlocked = await requestUnlock({
    token: challenge.token,
    promptId: id,
    address,
    signedMessage,
  }, correlationId);

  const recomputedHash = await hashPromptPlaintext(unlocked.plaintext);
  if (unlocked.contentHash && recomputedHash !== unlocked.contentHash.toLowerCase()) {
    throw new Error(ERROR_MESSAGES.INTEGRITY_FAILURE);
  }

  return {
    ...unlocked,
    decryptedContent: unlocked.plaintext,
  };
}

/** @deprecated Use unlockPromptContent — txHash is ignored; access is verified on-chain. */
export async function unlockPrompt(
  itemId: string,
  _txHash: string,
  signMessage: SignMessageFn,
  address?: string,
): Promise<{ decryptedContent: string; plaintext: string }> {
  if (!address) {
    throw new Error("Connect a Stellar wallet before unlocking.");
  }

  const result = await unlockPromptContent(address, itemId, signMessage);
  return {
    decryptedContent: result.plaintext,
    plaintext: result.plaintext,
  };
}
