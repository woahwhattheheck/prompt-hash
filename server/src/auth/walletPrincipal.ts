import { createHmac, randomUUID, timingSafeEqual } from "crypto";

const AUDIENCE = "prompt-hash:wallet-principal:v1";
const CHALLENGE_TTL = 5 * 60 * 1000;
const SESSION_TTL = 15 * 60 * 1000;

export interface WalletPrincipal {
  address: string;
  network: string;
  origin: string;
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
}

interface Claims extends WalletPrincipal {
  audience: typeof AUDIENCE;
  kind: "challenge" | "session";
}

/** The production implementation is durable; no process-local replay ledger. */
export interface WalletSessionStore {
  consumeChallenge(nonce: string, expiresAt: number): Promise<boolean>;
  createSession(principal: WalletPrincipal): Promise<void>;
  useSession(principal: WalletPrincipal, now: number): Promise<boolean>;
  revokeSession(principal: WalletPrincipal, now: number): Promise<boolean>;
}

export class WalletPrincipalError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 401) {
    super("Wallet authentication failed.");
    this.name = "WalletPrincipalError";
    this.code = code;
    this.status = status;
  }
}

/** Canonical JSON separates this proof from unlock/creator/governance proofs. */
export function walletChallengeMessage(claims: WalletPrincipal): string {
  return JSON.stringify([
    AUDIENCE, "challenge", claims.address, claims.network, claims.origin,
    claims.sessionId, claims.issuedAt, claims.expiresAt,
  ]);
}

export function walletRequestOrigin(
  origin: unknown,
  allowedOrigins: readonly string[],
): string {
  if (typeof origin !== "string" || !allowedOrigins.includes(origin)) {
    throw new WalletPrincipalError("wrong_origin", 403);
  }
  try {
    const parsed = new URL(origin);
    // Match the Origin header literally; paths, credentials and opaque origins
    // are never silently canonicalized into an allowed origin.
    if (parsed.origin !== origin || !["https:", "http:"].includes(parsed.protocol)) {
      throw new Error("Invalid origin");
    }
  } catch {
    throw new WalletPrincipalError("wrong_origin", 403);
  }
  return origin;
}

export class WalletSessions {
  private readonly secret: string;
  private readonly network: string;
  private readonly store: WalletSessionStore;
  private readonly verifyWallet: (address: string, message: string, signature: string) => boolean;

  constructor(options: {
    secret: string;
    network: string;
    store: WalletSessionStore;
    verifyWallet: (address: string, message: string, signature: string) => boolean;
  }) {
    if (!options.secret || options.secret.length < 32 || !options.network?.trim()) {
      throw new WalletPrincipalError("configuration", 503);
    }
    this.secret = options.secret;
    this.network = options.network.trim();
    this.store = options.store;
    this.verifyWallet = options.verifyWallet;
  }

  private encode(claims: Claims): string {
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${body}.${createHmac("sha256", this.secret).update(body).digest("base64url")}`;
  }

  private decode(token: unknown, kind: Claims["kind"], origin: string, now: number): Claims {
    if (typeof token !== "string" || token.length > 4096) {
      throw new WalletPrincipalError("invalid_token");
    }
    const parts = token.split(".");
    if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) {
      throw new WalletPrincipalError("invalid_token");
    }
    const signature = Buffer.from(parts[1], "utf8");
    const expected = Buffer.from(createHmac("sha256", this.secret).update(parts[0]).digest("base64url"));
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
      throw new WalletPrincipalError("invalid_token");
    }
    let claims: Claims;
    try {
      claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    } catch {
      throw new WalletPrincipalError("invalid_token");
    }
    const ttl = kind === "challenge" ? CHALLENGE_TTL : SESSION_TTL;
    if (!claims || claims.audience !== AUDIENCE || claims.kind !== kind ||
        typeof claims.address !== "string" || !/^G[A-Z2-7]{55}$/.test(claims.address) ||
        typeof claims.sessionId !== "string" || !/^[a-f0-9-]{36}$/.test(claims.sessionId) ||
        typeof claims.origin !== "string" || typeof claims.network !== "string" ||
        !Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt) ||
        claims.expiresAt <= claims.issuedAt || claims.expiresAt - claims.issuedAt > ttl ||
        claims.issuedAt > now) {
      throw new WalletPrincipalError("invalid_token");
    }
    if (claims.expiresAt <= now) throw new WalletPrincipalError("expired_token");
    if (claims.network !== this.network) throw new WalletPrincipalError("wrong_network", 403);
    if (claims.origin !== origin) throw new WalletPrincipalError("wrong_origin", 403);
    return claims;
  }

  issueChallenge(address: unknown, origin: string, now = Date.now()) {
    // Stellar addresses are case sensitive; do not lower-case the signing key.
    if (typeof address !== "string" || !/^G[A-Z2-7]{55}$/.test(address)) {
      throw new WalletPrincipalError("invalid_wallet", 400);
    }
    const claims: Claims = {
      audience: AUDIENCE, kind: "challenge", address, origin, network: this.network,
      sessionId: randomUUID(), issuedAt: now, expiresAt: now + CHALLENGE_TTL,
    };
    return {
      challengeToken: this.encode(claims), challenge: walletChallengeMessage(claims),
      issuedAt: now, expiresAt: claims.expiresAt, network: claims.network, origin,
    };
  }

  async exchange(challengeToken: unknown, signature: unknown, origin: string, now = Date.now()) {
    const claims = this.decode(challengeToken, "challenge", origin, now);
    if (typeof signature !== "string" || signature.length > 256 ||
        !this.verifyWallet(claims.address, walletChallengeMessage(claims), signature)) {
      throw new WalletPrincipalError("invalid_signature");
    }
    // The shared Mongo _id insert wins once across every process/replica.
    // Consume only after all proof checks, so invalid requests cannot burn it.
    if (!await this.store.consumeChallenge(claims.sessionId, claims.expiresAt)) {
      throw new WalletPrincipalError("replay", 409);
    }
    const session: Claims = {
      ...claims, kind: "session", sessionId: randomUUID(),
      issuedAt: now, expiresAt: now + SESSION_TTL,
    };
    const principal = this.principal(session);
    await this.store.createSession(principal);
    return { sessionToken: this.encode(session), principal };
  }

  private principal(claims: Claims): WalletPrincipal {
    const { address, network, origin, sessionId, issuedAt, expiresAt } = claims;
    return { address, network, origin, sessionId, issuedAt, expiresAt };
  }

  async authenticate(sessionToken: unknown, origin: string, now = Date.now()): Promise<WalletPrincipal> {
    const principal = this.principal(this.decode(sessionToken, "session", origin, now));
    if (!await this.store.useSession(principal, now)) {
      throw new WalletPrincipalError("revoked_or_missing_session");
    }
    return principal;
  }

  async revoke(sessionToken: unknown, origin: string, now = Date.now()): Promise<void> {
    const principal = this.principal(this.decode(sessionToken, "session", origin, now));
    // Repeated revocation is safe; this cannot revoke another token's session.
    await this.store.revokeSession(principal, now);
  }
}
