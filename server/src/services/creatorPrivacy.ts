/**
 * Creator privacy helpers (#142): projections, ownership gate, audit for
 * denied cross-wallet private access.
 */

import { createHash } from "crypto";
import type { Request, Response } from "express";
import {
  CREATOR_DRAFTS_READ,
  CREATOR_OWNED_READ,
  CREATOR_VERSION_WRITE,
  CreatorSessionError,
  authenticateCreatorSession,
  creatorSessionHttpStatus,
  digestVersionContent,
  readBearerToken,
  type CreatorSessionAction,
  type VerifiedCreatorSession,
} from "../auth/creatorSession";

export type CreatorPrivacyEvent =
  | "creator_private_read_denied"
  | "creator_private_read_granted"
  | "creator_version_write_denied"
  | "creator_version_write_granted";

export interface CreatorPrivacyAuditParams {
  event: CreatorPrivacyEvent;
  result: "success" | "blocked" | "failure";
  /** Raw wallet — hashed before emit. */
  walletAddress?: string | null;
  targetWallet?: string | null;
  promptId?: string | null;
  reason?: string | null;
  requestId?: string | null;
}

function hashWallet(address: string): string {
  return createHash("sha256").update(address.toLowerCase()).digest("hex");
}

/**
 * Structured privacy audit. Never logs plaintext prompt content or raw
 * session tokens. Wallet addresses are one-way hashed.
 */
export function recordCreatorPrivacyAudit(
  params: CreatorPrivacyAuditParams,
): void {
  const fields = {
    event: params.event,
    result: params.result,
    walletHash: params.walletAddress
      ? hashWallet(params.walletAddress)
      : undefined,
    targetWalletHash: params.targetWallet
      ? hashWallet(params.targetWallet)
      : undefined,
    promptId: params.promptId ?? undefined,
    reason: params.reason ?? undefined,
    requestId: params.requestId ?? undefined,
  };

  if (params.result === "blocked" || params.result === "failure") {
    console.warn("creator-privacy audit", fields);
  } else {
    console.info("creator-privacy audit", fields);
  }
}

/** Public listing projection — never includes draft plaintext. */
export function toPublicPromptProjection(doc: any): Record<string, unknown> {
  const owner =
    doc?.owner && typeof doc.owner === "object"
      ? {
          username: doc.owner.username ?? null,
          walletAddress: doc.owner.walletAddress ?? null,
        }
      : doc?.owner ?? null;

  return {
    id: String(doc?._id ?? doc?.id ?? ""),
    title: doc?.title ?? "",
    description: doc?.description ?? "",
    image: doc?.image ?? "",
    category: doc?.category ?? "",
    tags: Array.isArray(doc?.tags) ? doc.tags : [],
    price: doc?.price ?? 0,
    rating: doc?.rating ?? null,
    listingStatus: doc?.listingStatus ?? "published",
    isActive: doc?.isActive ?? true,
    currentVersionIndex: doc?.currentVersionIndex ?? 1,
    owner,
    createdAt: doc?.createdAt ?? null,
    updatedAt: doc?.updatedAt ?? null,
    // Explicitly omit: content, draft plaintext, private version bodies
  };
}

/** Authenticated creator private projection — includes content. */
export function toPrivatePromptProjection(doc: any): Record<string, unknown> {
  const base = toPublicPromptProjection(doc);
  return {
    ...base,
    content: doc?.content ?? null,
    onChainReference: doc?.onChainReference ?? "",
  };
}

export function mapPromptsPrivate(docs: any[]): Record<string, unknown>[] {
  return (docs ?? []).map(toPrivatePromptProjection);
}

export function mapPromptsPublic(docs: any[]): Record<string, unknown>[] {
  return (docs ?? [])
    .filter(
      (d) =>
        d?.listingStatus === "published" ||
        d?.listingStatus === undefined ||
        d?.listingStatus === null,
    )
    .filter((d) => d?.listingStatus !== "draft")
    .map(toPublicPromptProjection);
}

function rejectSessionError(res: Response, err: unknown): boolean {
  if (err instanceof CreatorSessionError) {
    res.status(creatorSessionHttpStatus(err)).json({
      error: err.message,
      code: err.code,
    });
    return true;
  }
  return false;
}

export function extractCreatorCredentials(req: Request): {
  sessionToken?: string;
  signature?: string;
} {
  const bearer = readBearerToken(req.headers.authorization);
  const headerSig =
    (req.headers["x-wallet-signature"] as string | undefined) ??
    (req.headers["x-signature"] as string | undefined);
  const body = (req.body ?? {}) as {
    sessionToken?: string;
    signature?: string;
  };
  return {
    sessionToken: bearer ?? body.sessionToken,
    signature: headerSig ?? body.signature,
  };
}

/**
 * Authenticate a private creator read (owned / drafts). Session address must
 * equal the URL walletAddress.
 */
export function requireCreatorReadSession(
  req: Request,
  res: Response,
  opts: {
    expectedAction: typeof CREATOR_OWNED_READ | typeof CREATOR_DRAFTS_READ;
    urlWallet: string;
  },
): VerifiedCreatorSession | null {
  const { sessionToken, signature } = extractCreatorCredentials(req);

  if (!sessionToken || !signature) {
    recordCreatorPrivacyAudit({
      event: "creator_private_read_denied",
      result: "blocked",
      targetWallet: opts.urlWallet,
      reason: "missing_credentials",
    });
    res.status(401).json({
      error: "Creator session credentials required.",
      code: "missing_credentials",
    });
    return null;
  }

  try {
    const session = authenticateCreatorSession({
      sessionToken,
      signature,
      expectedAction: opts.expectedAction,
      expectedWallet: opts.urlWallet,
    });
    recordCreatorPrivacyAudit({
      event: "creator_private_read_granted",
      result: "success",
      walletAddress: session.address,
      targetWallet: opts.urlWallet,
      reason: opts.expectedAction,
    });
    return session;
  } catch (err) {
    const code =
      err instanceof CreatorSessionError ? err.code : "invalid_token";
    recordCreatorPrivacyAudit({
      event: "creator_private_read_denied",
      result: "blocked",
      targetWallet: opts.urlWallet,
      reason: code,
    });
    if (rejectSessionError(res, err)) return null;
    res.status(401).json({ error: "Unauthorized.", code: "invalid_token" });
    return null;
  }
}

/**
 * Authenticate a creator version write. Binds creator, promptId, and content
 * digest. Ignores body walletAddress for identity.
 */
export function requireCreatorVersionWriteSession(
  req: Request,
  res: Response,
  opts: { promptId: string; content: string },
): VerifiedCreatorSession | null {
  const { sessionToken, signature } = extractCreatorCredentials(req);

  if (!sessionToken || !signature) {
    recordCreatorPrivacyAudit({
      event: "creator_version_write_denied",
      result: "blocked",
      promptId: opts.promptId,
      reason: "missing_credentials",
    });
    res.status(401).json({
      error: "Creator session credentials required.",
      code: "missing_credentials",
    });
    return null;
  }

  const contentDigest = digestVersionContent(opts.content);

  try {
    const session = authenticateCreatorSession({
      sessionToken,
      signature,
      expectedAction: CREATOR_VERSION_WRITE,
      expectedPromptId: opts.promptId,
      expectedContentDigest: contentDigest,
    });
    recordCreatorPrivacyAudit({
      event: "creator_version_write_granted",
      result: "success",
      walletAddress: session.address,
      promptId: opts.promptId,
      reason: "creator_version_write",
    });
    return session;
  } catch (err) {
    const code =
      err instanceof CreatorSessionError ? err.code : "invalid_token";
    recordCreatorPrivacyAudit({
      event: "creator_version_write_denied",
      result: "blocked",
      promptId: opts.promptId,
      reason: code,
    });
    if (rejectSessionError(res, err)) return null;
    res.status(401).json({ error: "Unauthorized.", code: "invalid_token" });
    return null;
  }
}

export {
  CREATOR_OWNED_READ,
  CREATOR_DRAFTS_READ,
  CREATOR_VERSION_WRITE,
  digestVersionContent,
};
