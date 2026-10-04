/**
 * Express adapter for prompt versioning (#184).
 *
 * Controllers are thin wrappers around the shared domain. Business rules live
 * in `src/lib/domain/promptVersioningDomain.ts`.
 */
import { Request, Response } from "express";
import { internalServerError, sendDomainResult } from "../../../src/lib/domain/domainResult";
import {
  getBuyerVersion,
  listPromptVersionHistory,
  publishPromptVersionForOwner,
  recordPromptPurchase,
} from "../../../src/lib/domain/promptVersioningDomain";
import {
  createPromptVersioningDeps,
  ensureDb,
} from "../../../src/lib/domain/promptVersioningDeps";

export const PostPromptUpdate = async (req: Request, res: Response): Promise<Response> => {
  try {
    await ensureDb();
    const result = await publishPromptVersionForOwner(createPromptVersioningDeps(), {
      promptId: req.body?.promptId,
      walletAddress: req.body?.walletAddress,
      content: req.body?.content,
      changeNote: req.body?.changeNote,
    });
    return sendDomainResult(res, result) as Response;
  } catch {
    return sendDomainResult(res, internalServerError()) as Response;
  }
};

export const GetPromptVersions = async (req: Request, res: Response): Promise<Response> => {
  try {
    await ensureDb();
    const result = await listPromptVersionHistory(createPromptVersioningDeps(), {
      promptId: req.params.promptId,
    });
    return sendDomainResult(res, result) as Response;
  } catch {
    return sendDomainResult(res, internalServerError()) as Response;
  }
};

export const RecordPurchase = async (req: Request, res: Response): Promise<Response> => {
  try {
    await ensureDb();
    const result = await recordPromptPurchase(createPromptVersioningDeps(), {
      promptId: req.body?.promptId,
      buyerWallet: req.body?.buyerWallet,
      txHash: req.body?.txHash,
    });
    return sendDomainResult(res, result) as Response;
  } catch {
    return sendDomainResult(res, internalServerError()) as Response;
  }
};

export const GetBuyerVersion = async (req: Request, res: Response): Promise<Response> => {
  try {
    await ensureDb();
    const result = await getBuyerVersion(createPromptVersioningDeps(), {
      promptId: req.query?.promptId,
      buyerWallet: req.query?.buyerWallet,
    });
    return sendDomainResult(res, result) as Response;
  } catch {
    return sendDomainResult(res, internalServerError()) as Response;
  }
};
