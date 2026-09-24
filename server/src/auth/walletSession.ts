/**
 * Signed wallet session for governance vote mutations (#147).
 *
 * Identity for create/delete votes comes only from a verified session:
 * HMAC-signed claims + Stellar Ed25519 signature over a canonical message.
 * Caller-provided `voterWallet` body fields are never trusted.
 */

import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { verifyChallengeSignature } from "../utils/challengeSignature";

export const VOTE_CREATE_ACTION = "governance_vote_create" as const;
export const VOTE_DELETE_ACTION = "governance_vote_delete" as const;

export type VoteSessionAction =
  | typeof VOTE_CREATE_ACTION
  | typeof VOTE_DELETE_ACTION;

export const WALLET_SESSION_AUD = "prompt-hash:governance-vote";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 10 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MIN_SECRET_LENGTH = 32;

export interface WalletSessionClaims {
  address: string;
  promptId: string;
  network: string;
  action: VoteSessionAction;
  nonce: string;
  iat: number;
  exp: number;
  aud: string;
}

export interface IssuedWalletSession {
  sessionToken: string;
  challenge: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  network: string;
  action: VoteSessionAction;
}

export interface VerifiedWalletSession {
  address: string;
  promptId: string;
  network: string;
  action: VoteSessionAction;
  nonce: string;
  exp: number;
}

export type WalletSessionErrorCode =
  | "missing_credentials"
  | "malformed_credentials"
  | "invalid_token"
  | "expired_token"
  | "invalid_signature"
  | "replay"
  | "wrong_network"
  | "prompt_mismatch"
  | "action_mismatch"
  | "configuration";

export class WalletSessionError extends Error {
  readonly code: WalletSessionErrorCode;

  constructor(code: WalletSessionErrorCode, message: string) {
    super(message);
    this.name = "WalletSessionError";
    this.code = code;
  }
}

function getSecret(override?: string): string {
  const secret = override ?? process.env.CHALLENGE_TOKEN_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new WalletSessionError(
      "configuration",
      "Wallet session secret is not configured.",
    );
  }
  return secret;
}

export function getExpectedNetworkPassphrase(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const passphrase = env.PUBLIC_STELLAR_NETWORK_PASSPHRASE;
  if (!passphrase || typeof passphrase !== "string" || !passphrase.trim()) {
    throw new WalletSessionError(
      "configuration",
      "PUBLIC_STELLAR_NETWORK_PASSPHRASE is not configured.",
    );
  }
  return passphrase.trim();
}

function signBody(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function signaturesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function encodeClaims(claims: WalletSessionClaims): string {
  return Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
}

function decodeClaims(encoded: string): WalletSessionClaims {
  return JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  ) as WalletSessionClaims;
}

export function buildWalletSessionMessage(claims: WalletSessionClaims): string {
  return (
    `prompt-hash governance-vote:${claims.action}:${claims.address}:` +
    `${claims.promptId}:${claims.network}:${claims.nonce}:${claims.iat}:${claims.exp}`
  );
}

export function isVoteSessionAction(value: unknown): value is VoteSessionAction {
  return value === VOTE_CREATE_ACTION || value === VOTE_DELETE_ACTION;
}

/**
 * In-process nonce ledger — one nonce = one successful authenticated mutation.
 */
export class SessionNonceLedger {
  private readonly used = new Map<string, number>();

  consume(nonce: string, expiresAt: number, now = Date.now()): boolean {
    this.prune(now);
    if (this.used.has(nonce)) return false;
    this.used.set(nonce, expiresAt);
    return true;
  }

  private prune(now: number): void {
    for (const [nonce, expiresAt] of this.used) {
      if (expiresAt < now) this.used.delete(nonce);
    }
  }

  clear(): void {
    this.used.clear();
  }
}

export const governanceSessionNonceLedger = new SessionNonceLedger();

export function createWalletSessionToken(opts: {
  address: string;
  promptId: string;
  action: VoteSessionAction;
  network?: string;
  secret?: string;
  now?: number;
  ttlMs?: number;
}): IssuedWalletSession {
  const secret = getSecret(opts.secret);
  const now = opts.now ?? Date.now();
  const ttlMs = Math.min(opts.ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS);
  const network = (opts.network ?? getExpectedNetworkPassphrase()).trim();
  const address = opts.address.trim();
  const promptId = String(opts.promptId).trim();

  if (!address || !promptId) {
    throw new WalletSessionError(
      "malformed_credentials",
      "address and promptId are required.",
    );
  }
  if (!isVoteSessionAction(opts.action)) {
    throw new WalletSessionError("action_mismatch", "Unsupported vote action.");
  }

  const claims: WalletSessionClaims = {
    address,
    promptId,
    network,
    action: opts.action,
    nonce: randomUUID(),
    iat: now,
    exp: now + ttlMs,
    aud: WALLET_SESSION_AUD,
  };

  const encoded = encodeClaims(claims);
  const signature = signBody(secret, encoded);

  return {
    sessionToken: `${encoded}.${signature}`,
    challenge: buildWalletSessionMessage(claims),
    issuedAt: claims.iat,
    expiresAt: claims.exp,
    nonce: claims.nonce,
    network: claims.network,
    action: claims.action,
  };
}

export function verifyWalletSessionToken(
  sessionToken: string,
  opts?: {
    secret?: string;
    now?: number;
    expectedPromptId?: string;
    expectedAction?: VoteSessionAction;
    expectedNetwork?: string;
  },
): WalletSessionClaims {
  if (!sessionToken || typeof sessionToken !== "string") {
    throw new WalletSessionError(
      "malformed_credentials",
      "Malformed session token.",
    );
  }

  const parts = sessionToken.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new WalletSessionError(
      "malformed_credentials",
      "Malformed session token.",
    );
  }

  const [encoded, signature] = parts;
  const secret = getSecret(opts?.secret);
  const expectedSig = signBody(secret, encoded);
  if (!signaturesEqual(signature, expectedSig)) {
    throw new WalletSessionError("invalid_token", "Invalid session token.");
  }

  let claims: WalletSessionClaims;
  try {
    claims = decodeClaims(encoded);
  } catch {
    throw new WalletSessionError("invalid_token", "Invalid session token.");
  }

  const now = opts?.now ?? Date.now();

  if (
    !claims ||
    typeof claims.address !== "string" ||
    !claims.address ||
    typeof claims.promptId !== "string" ||
    !claims.promptId ||
    typeof claims.network !== "string" ||
    !claims.network ||
    !isVoteSessionAction(claims.action) ||
    typeof claims.nonce !== "string" ||
    !claims.nonce ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number" ||
    claims.aud !== WALLET_SESSION_AUD
  ) {
    throw new WalletSessionError("invalid_token", "Invalid session token.");
  }

  if (claims.exp < now) {
    throw new WalletSessionError("expired_token", "Session expired.");
  }

  if (claims.iat > now + MAX_CLOCK_SKEW_MS) {
    throw new WalletSessionError("invalid_token", "Invalid session token.");
  }

  if (
    opts?.expectedPromptId !== undefined &&
    String(claims.promptId) !== String(opts.expectedPromptId)
  ) {
    throw new WalletSessionError(
      "prompt_mismatch",
      "Session prompt does not match request.",
    );
  }

  if (
    opts?.expectedAction !== undefined &&
    claims.action !== opts.expectedAction
  ) {
    throw new WalletSessionError(
      "action_mismatch",
      "Session action does not match request.",
    );
  }

  const expectedNetwork = (
    opts?.expectedNetwork ?? getExpectedNetworkPassphrase()
  ).trim();
  if (claims.network !== expectedNetwork) {
    throw new WalletSessionError(
      "wrong_network",
      "Session network does not match server network.",
    );
  }

  return claims;
}

/**
 * Full authentication for a vote mutation: HMAC token + wallet signature +
 * single-use nonce. Returns the verified buyer address (lowercase).
 */
export function authenticateVoteSession(opts: {
  sessionToken: string;
  signature: string;
  expectedPromptId: string;
  expectedAction: VoteSessionAction;
  secret?: string;
  now?: number;
  expectedNetwork?: string;
  ledger?: SessionNonceLedger;
}): VerifiedWalletSession {
  if (!opts.signature || typeof opts.signature !== "string") {
    throw new WalletSessionError(
      "missing_credentials",
      "Wallet signature is required.",
    );
  }

  const claims = verifyWalletSessionToken(opts.sessionToken, {
    secret: opts.secret,
    now: opts.now,
    expectedPromptId: opts.expectedPromptId,
    expectedAction: opts.expectedAction,
    expectedNetwork: opts.expectedNetwork,
  });

  const message = buildWalletSessionMessage(claims);
  const ok = verifyChallengeSignature(
    claims.address,
    message,
    opts.signature,
  );
  if (!ok) {
    throw new WalletSessionError(
      "invalid_signature",
      "Invalid wallet signature.",
    );
  }

  const ledger = opts.ledger ?? governanceSessionNonceLedger;
  const now = opts.now ?? Date.now();
  if (!ledger.consume(claims.nonce, claims.exp, now)) {
    throw new WalletSessionError("replay", "Session nonce already used.");
  }

  return {
    address: claims.address.toLowerCase(),
    promptId: claims.promptId,
    network: claims.network,
    action: claims.action,
    nonce: claims.nonce,
    exp: claims.exp,
  };
}

/** Map auth errors to HTTP status codes for route handlers. */
export function walletSessionHttpStatus(err: WalletSessionError): number {
  switch (err.code) {
    case "missing_credentials":
    case "malformed_credentials":
    case "invalid_token":
    case "expired_token":
    case "invalid_signature":
    case "replay":
    case "wrong_network":
    case "prompt_mismatch":
    case "action_mismatch":
      return err.code === "wrong_network" ||
        err.code === "prompt_mismatch" ||
        err.code === "action_mismatch"
        ? 403
        : err.code === "replay"
          ? 409
          : 401;
    case "configuration":
      return 500;
    default:
      return 401;
  }
}
