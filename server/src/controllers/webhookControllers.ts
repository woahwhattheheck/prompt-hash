import { Request, Response } from "express";
import { randomBytes } from "crypto";
import connectDb from "../db/connectDb";
import WebhookSubscription from "../models/WebhookSubscription";
import { ALLOWED_EVENTS } from "../services/webhookDispatcher";
import { validateWebhookUrl } from "../services/ssrfProtection";

/**
 * The authenticated principal is selected by the route middleware, never by
 * an unsigned query/body wallet string. Admin rotation is a separate bearer
 * capability and must explicitly name the target wallet.
 */
function authorizedOwner(req: Request, res: Response, walletSelector: unknown): string | null {
  if (res.locals.webhookAdmin === true) {
    if (typeof walletSelector !== "string" || !walletSelector.trim()) {
      res.status(400).json({ error: "walletAddress is required for admin operations." });
      return null;
    }
    return walletSelector.toLowerCase();
  }

  const principal = res.locals.walletPrincipal?.address;
  if (typeof principal !== "string") {
    res.status(401).json({ error: "Wallet session required." });
    return null;
  }
  // Legacy callers may send a selector, but cannot use it as identity.
  if (walletSelector !== undefined &&
      (typeof walletSelector !== "string" || walletSelector.toLowerCase() !== principal.toLowerCase())) {
    res.status(403).json({ error: "Wallet does not match authenticated session." });
    return null;
  }
  return principal.toLowerCase();
}

export const RegisterWebhook = async (req: Request, res: Response): Promise<Response> => {
  try {
    const owner = authorizedOwner(req, res, req.body?.walletAddress);
    if (!owner) return res;
    const { url, events } = req.body ?? {};
    if (typeof url !== "string" || !url) {
      return res.status(400).json({ error: "url is required." });
    }

    const ssrfCheck = await validateWebhookUrl(url);
    if (!ssrfCheck.valid) {
      return res.status(400).json({ error: "Invalid or blocked webhook destination URL." });
    }
    await connectDb();
    const secret = randomBytes(32).toString("hex");
    const resolvedEvents = Array.isArray(events)
      ? events.filter((e: unknown) => typeof e === "string" && ALLOWED_EVENTS.includes(e as any))
      : ["PromptPurchased"];

    const existing = await WebhookSubscription.findOne({ walletAddress: owner });
    if (existing) {
      existing.url = url;
      existing.events = resolvedEvents;
      existing.active = true;
      existing.failureCount = 0;
      // A previously returned rotation secret was never persisted; webhooks
      // would then be signed with the OLD secret while clients stored the new.
      existing.secret = secret;
      await existing.save();
      return res.status(200).json({ message: "Webhook updated.", id: existing._id, secret });
    }

    const sub = new WebhookSubscription({
      walletAddress: owner, url, secret, events: resolvedEvents,
    });
    await sub.save();
    return res.status(201).json({ message: "Webhook registered.", id: sub._id, secret });
  } catch {
    return res.status(500).json({ error: "Webhook registration failed." });
  }
};

export const GetWebhook = async (req: Request, res: Response): Promise<Response> => {
  try {
    const owner = authorizedOwner(req, res, req.query.walletAddress);
    if (!owner) return res;
    await connectDb();
    const sub = await WebhookSubscription.findOne({ walletAddress: owner }).select("-secret");
    if (!sub) return res.status(404).json({ error: "No webhook registered for this wallet." });
    return res.json(sub);
  } catch {
    return res.status(500).json({ error: "Failed to fetch webhook." });
  }
};

export const DeleteWebhook = async (req: Request, res: Response): Promise<Response> => {
  try {
    const owner = authorizedOwner(req, res, req.body?.walletAddress);
    if (!owner) return res;
    await connectDb();
    await WebhookSubscription.deleteOne({ walletAddress: owner });
    return res.status(200).json({ message: "Webhook removed." });
  } catch {
    return res.status(500).json({ error: "Failed to delete webhook." });
  }
};
