import type { RequestHandler } from "express";
import { productionWalletSessions } from "./mongoWalletSessions";
import { WalletPrincipalError, walletRequestOrigin, type WalletPrincipal } from "./walletPrincipal";

interface WalletRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface WalletResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): WalletResponse;
  json(value: unknown): unknown;
}

function requestOrigin(req: WalletRequest) {
  const allowed = (process.env.WALLET_SESSION_ORIGINS || "")
    .split(",").map(value => value.trim()).filter(Boolean);
  if (!allowed.length) throw new WalletPrincipalError("configuration", 503);
  return walletRequestOrigin(req.headers.origin, allowed);
}

function bearer(req: WalletRequest): string {
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string") throw new WalletPrincipalError("missing_credentials");
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization);
  if (!match) throw new WalletPrincipalError("missing_credentials");
  return match[1];
}

/** One verifier for Express and serverless wallet-bound handlers. */
export async function readWalletPrincipal(req: WalletRequest): Promise<WalletPrincipal> {
  const origin = requestOrigin(req);
  return productionWalletSessions().authenticate(bearer(req), origin);
}

export function walletAuthenticationFailure(res: WalletResponse, error: unknown) {
  const known = error instanceof WalletPrincipalError;
  return res.status(known ? error.status : 503).json({
    error: "Wallet authentication failed.",
    code: known ? error.code : "authentication_unavailable",
  });
}

/** Downstream controllers use res.locals.walletPrincipal, never body identity. */
export const requireWalletPrincipal: RequestHandler = async (req, res, next) => {
  try {
    res.locals.walletPrincipal = await readWalletPrincipal(req);
    next();
  } catch (error) {
    walletAuthenticationFailure(res, error);
  }
};

/** Shared lifecycle handler, mounted by both HTTP transports. */
export async function walletSessionHandler(req: WalletRequest, res: WalletResponse): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed." });
    return;
  }
  try {
    const origin = requestOrigin(req);
    const sessions = productionWalletSessions();
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      throw new WalletPrincipalError("invalid_request", 400);
    }
    const body = req.body as Record<string, unknown>;
    switch (body.action) {
      case "challenge":
        res.status(200).json(sessions.issueChallenge(body.address, origin));
        break;
      case "exchange":
        res.status(200).json(await sessions.exchange(body.challengeToken, body.signature, origin));
        break;
      case "revoke":
        await sessions.revoke(bearer(req), origin);
        res.status(200).json({ revoked: true });
        break;
      default:
        throw new WalletPrincipalError("invalid_action", 400);
    }
  } catch (error) {
    walletAuthenticationFailure(res, error);
  }
}
