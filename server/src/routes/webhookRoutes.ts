import express, { type RequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";
import { requireWalletPrincipal } from "../auth/walletPrincipalHttp";
import { DeleteWebhook, GetWebhook, RegisterWebhook } from "../controllers/webhookControllers";

export const webhookRouter = express.Router();

/**
 * Ordinary wallet owners authenticate through the common revocable session.
 * The pre-existing admin rotation endpoint is a distinct privileged backend
 * capability, accepted only with an explicitly configured high-entropy token.
 */
export const requireWebhookAuthority: RequestHandler = (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  const configured = process.env.ADMIN_ROTATION_TOKEN;
  const header = req.headers.authorization;
  if (configured && Buffer.byteLength(configured, "utf8") >= 32 &&
      typeof header === "string" && header.startsWith("Bearer ")) {
    const supplied = Buffer.from(header.slice(7), "utf8");
    const expected = Buffer.from(configured, "utf8");
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) {
      res.locals.webhookAdmin = true;
      next();
      return;
    }
  }
  // A missing or invalid admin credential never grants admin access;
  // only the signed wallet-principal verifier can authorize an owner.
  requireWalletPrincipal(req, res, next);
};

webhookRouter.use(requireWebhookAuthority);
webhookRouter.post("/", RegisterWebhook);
webhookRouter.get("/", GetWebhook);
webhookRouter.delete("/", DeleteWebhook);
