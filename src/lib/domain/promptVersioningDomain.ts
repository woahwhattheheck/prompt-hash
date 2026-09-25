/**
 * Authoritative prompt-versioning domain (#184).
 *
 * Serverless (`api/prompts/version.ts`) and Express (`versioningControllers`)
 * both call these functions so validation, entitlement, and error mapping
 * cannot drift between adapters.
 */

import type { DomainResult } from "./domainResult";
import { created, fail, ok } from "./domainResult";

export type PurchaseRecord = {
  versionIndex: number;
  createdAt: Date | string | null;
};

export type VersionRecord = {
  versionIndex: number;
  content?: string | null;
  changeNote?: string;
};

export type PromptRecord = {
  _id: unknown;
  content?: string | null;
  currentVersionIndex?: number;
  owner?: unknown;
};

export type UserRecord = {
  _id: unknown;
  walletAddress: string;
};

export type PromptVersioningDeps = {
  findPurchase: (promptId: string, buyerWallet: string) => Promise<PurchaseRecord | null>;
  findVersion: (promptId: string, versionIndex: number) => Promise<VersionRecord | null>;
  findPromptById: (promptId: string) => Promise<PromptRecord | null>;
  findUserByWallet: (wallet: string) => Promise<UserRecord | null>;
  findOwnedPrompt: (promptId: string, ownerId: unknown) => Promise<PromptRecord | null>;
  publishVersion: (params: {
    promptId: string;
    content: string;
    changeNote?: string;
    createdBy: string;
  }) => Promise<{ versionIndex: number }>;
  listVersionHistory: (promptId: string) => Promise<unknown[]>;
  recordPurchase: (params: {
    promptId: string;
    buyerWallet: string;
    versionIndex: number;
    txHash: string;
  }) => Promise<{
    purchase: PurchaseRecord & { createdAt: Date; updatedAt: Date; versionIndex: number };
    created: boolean;
  }>;
};

export type BuyerVersionBody = {
  versionIndex: number;
  content: string | null;
  changeNote: string;
  purchasedAt: Date | string | null;
};

/**
 * Return the versioned content a buyer is entitled to.
 *
 * Authoritative security rule: a purchase record is required. Silent fallback
 * to v1 content without entitlement is intentionally not supported (closes the
 * serverless/Express drift where serverless previously returned v1 anyway).
 */
export async function getBuyerVersion(
  deps: PromptVersioningDeps,
  input: { promptId?: unknown; buyerWallet?: unknown },
): Promise<DomainResult<BuyerVersionBody | { error: string }>> {
  const promptId = input.promptId != null ? String(input.promptId) : "";
  const buyerWallet = input.buyerWallet != null ? String(input.buyerWallet) : "";

  if (!promptId || !buyerWallet) {
    return fail(400, "promptId and buyerWallet are required.");
  }

  const purchase = await deps.findPurchase(promptId, buyerWallet.toLowerCase());
  if (!purchase) {
    return fail(404, "No purchase record found.");
  }

  const version = await deps.findVersion(promptId, purchase.versionIndex);
  const prompt = await deps.findPromptById(promptId);

  return ok({
    versionIndex: purchase.versionIndex,
    changeNote: version?.changeNote ?? "",
    content: version?.content ?? prompt?.content ?? null,
    purchasedAt: purchase.createdAt ?? null,
  });
}

/**
 * Creator publishes a new prompt version.
 */
export async function publishPromptVersionForOwner(
  deps: PromptVersioningDeps,
  input: {
    promptId?: unknown;
    walletAddress?: unknown;
    content?: unknown;
    changeNote?: unknown;
  },
): Promise<DomainResult<{ message: string; versionIndex: number } | { error: string }>> {
  const promptId = input.promptId != null ? String(input.promptId) : "";
  const walletAddress = input.walletAddress != null ? String(input.walletAddress) : "";
  const content = input.content != null ? String(input.content) : "";
  const changeNote =
    input.changeNote != null && input.changeNote !== undefined
      ? String(input.changeNote)
      : undefined;

  if (!promptId || !walletAddress || !content) {
    return fail(400, "promptId, walletAddress, and content are required.");
  }

  const user = await deps.findUserByWallet(walletAddress.toLowerCase());
  if (!user) return fail(404, "User not found.");

  const prompt = await deps.findOwnedPrompt(promptId, user._id);
  if (!prompt) {
    return fail(403, "Prompt not found or not owned by this wallet.");
  }

  const { versionIndex } = await deps.publishVersion({
    promptId: String(prompt._id),
    content,
    changeNote,
    createdBy: walletAddress,
  });

  return created({ message: "Version posted.", versionIndex });
}

/**
 * List version history metadata (no content) for a prompt.
 */
export async function listPromptVersionHistory(
  deps: PromptVersioningDeps,
  input: { promptId?: unknown },
): Promise<DomainResult<unknown | { error: string }>> {
  const promptId = input.promptId != null ? String(input.promptId) : "";
  if (!promptId) return fail(400, "promptId is required.");
  const versions = await deps.listVersionHistory(promptId);
  return ok(versions);
}

/**
 * Idempotently record a purchase entitlement at the current version index.
 */
export async function recordPromptPurchase(
  deps: PromptVersioningDeps,
  input: { promptId?: unknown; buyerWallet?: unknown; txHash?: unknown },
): Promise<DomainResult<{ message: string; versionIndex: number } | { error: string }>> {
  const promptId = input.promptId != null ? String(input.promptId) : "";
  const buyerWallet = input.buyerWallet != null ? String(input.buyerWallet) : "";
  const txHash = input.txHash != null ? String(input.txHash) : "";

  if (!promptId || !buyerWallet) {
    return fail(400, "promptId and buyerWallet are required.");
  }

  const prompt = await deps.findPromptById(promptId);
  if (!prompt) return fail(404, "Prompt not found.");

  const versionIndex = prompt.currentVersionIndex ?? 1;
  const { purchase, created: wasCreated } = await deps.recordPurchase({
    promptId,
    buyerWallet: buyerWallet.toLowerCase(),
    versionIndex,
    txHash,
  });

  return {
    status: wasCreated ? 201 : 200,
    body: {
      message: wasCreated ? "Purchase recorded." : "Already purchased.",
      versionIndex: purchase.versionIndex,
    },
  };
}

/** Dispatch GET/POST for the dual-mounted `/api/prompts/version` surface. */
export async function handlePromptVersionHttp(
  deps: PromptVersioningDeps,
  input: {
    method?: string;
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
  },
): Promise<DomainResult> {
  const method = String(input.method || "GET").toUpperCase();
  if (method === "GET") {
    return getBuyerVersion(deps, {
      promptId: input.query?.promptId,
      buyerWallet: input.query?.buyerWallet,
    });
  }
  if (method === "POST") {
    return publishPromptVersionForOwner(deps, {
      promptId: input.body?.promptId,
      walletAddress: input.body?.walletAddress,
      content: input.body?.content,
      changeNote: input.body?.changeNote,
    });
  }
  return fail(405, "Method not allowed.");
}
