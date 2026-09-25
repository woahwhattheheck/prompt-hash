/**
 * Express adapter for webhook subscriptions (#184).
 *
 * Controllers are thin wrappers around the shared domain. Auth, SSRF, and
 * event filtering live in `src/lib/domain/webhookDomain.ts`.
 */
import { Request, Response } from "express";
import { sendDomainResult } from "../../../src/lib/domain/domainResult";
import {
  deleteWebhookSubscription,
  getWebhookSubscription,
  registerWebhookSubscription,
} from "../../../src/lib/domain/webhookDomain";
import {
  createWebhookDomainDeps,
  ensureWebhookDb,
} from "../../../src/lib/domain/webhookDeps";

export const RegisterWebhook = async (req: Request, res: Response): Promise<Response> => {
  try {
    await ensureWebhookDb();
    const result = await registerWebhookSubscription(createWebhookDomainDeps(), {
      headers: req.headers as Record<string, string | string[] | undefined>,
      body: req.body,
    });
    return sendDomainResult(res, result) as Response;
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
};

export const GetWebhook = async (req: Request, res: Response): Promise<Response> => {
  try {
    await ensureWebhookDb();
    const result = await getWebhookSubscription(createWebhookDomainDeps(), {
      headers: req.headers as Record<string, string | string[] | undefined>,
      body: req.body,
      query: req.query as Record<string, unknown>,
    });
    return sendDomainResult(res, result) as Response;
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
};

export const DeleteWebhook = async (req: Request, res: Response): Promise<Response> => {
  try {
    await ensureWebhookDb();
    const result = await deleteWebhookSubscription(createWebhookDomainDeps(), {
      headers: req.headers as Record<string, string | string[] | undefined>,
      body: req.body,
    });
    return sendDomainResult(res, result) as Response;
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
};
