import type { VercelRequest, VercelResponse } from "@vercel/node";
import { walletSessionHandler } from "../../server/src/auth/walletPrincipalHttp";
import { checkRateLimit } from "../../src/lib/observability/rateLimiter";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "POST") {
    try {
      // A body wallet is unverified, so retain the unauthenticated limit.
      const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown");
      const limit = await checkRateLimit("challenge", ip, false);
      if (!limit.success) {
        res.status(429).json({ error: "Too many authentication requests." });
        return;
      }
    } catch {
      res.status(503).json({ error: "Authentication rate limiter unavailable." });
      return;
    }
  }
  await walletSessionHandler(req, res);
}
