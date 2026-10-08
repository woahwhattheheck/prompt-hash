/** Trusted backend/cron bearer boundary. Wallet sessions never grant admin rights. */
import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

/** Deployment must provision a high-entropy server-side token before use. */
export const requireFulfillmentService: RequestHandler = (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  const expected = process.env.FULFILLMENT_SERVICE_TOKEN;
  if (!expected || Buffer.byteLength(expected, "utf8") < 32) {
    res.status(503).json({ error: "Fulfillment service authentication unavailable." });
    return;
  }

  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Fulfillment service credentials required." });
    return;
  }
  const supplied = Buffer.from(header.slice(7), "utf8");
  const trusted = Buffer.from(expected, "utf8");
  if (supplied.length !== trusted.length || !timingSafeEqual(supplied, trusted)) {
    res.status(403).json({ error: "Invalid fulfillment service credentials." });
    return;
  }
  next();
};
