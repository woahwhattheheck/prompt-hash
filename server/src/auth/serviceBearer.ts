/** Single fail-closed backend bearer implementation for distinct service roles. */
import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

/**
 * Each subsystem receives its own token and permission boundary. Do not
 * share report-admin authority with fulfillment or with wallet sessions.
 */
export function serviceBearer(envName: string, purpose: string): RequestHandler {
  return (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    const expected = process.env[envName];
    if (!expected || Buffer.byteLength(expected, "utf8") < 32) {
      res.status(503).json({ error: `${purpose} authentication unavailable.` });
      return;
    }
    const authorization = req.headers.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
      res.status(401).json({ error: `${purpose} credentials required.` });
      return;
    }
    const supplied = Buffer.from(authorization.slice(7), "utf8");
    const trusted = Buffer.from(expected, "utf8");
    if (supplied.length !== trusted.length || !timingSafeEqual(supplied, trusted)) {
      res.status(403).json({ error: `Invalid ${purpose.toLowerCase()} credentials.` });
      return;
    }
    next();
  };
}
