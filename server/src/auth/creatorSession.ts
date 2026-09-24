/**
 * Signed creator session for private owned/draft reads and version writes (#142).
 *
 * Identity comes only from a verified session: HMAC-signed claims + Stellar
 * Ed25519 signature over a canonical challenge. Caller-provided walletAddress
 * fields are never trusted for authorization.
 *
 * Compatible with the wallet-session pattern used elsewhere, but intentionally
 * a separate module/audience so this change does not depend on unmerged
 * governance session work.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from "crypto";
import { verifyChallengeSignature } from "../utils/challengeSignature";

export const CREATOR_OWNED_READ = "creator_owned_read" as const;
export const CREATOR_DRAFTS_READ = "creator_drafts_read" as const;
export const CREATOR_VERSION_WRITE = "creator_version_write" as const;

export type CreatorSessionAction =
  | typeof CREATOR_OWNED_READ
  | typeof CREATOR_DRAFTS_READ
  | typeof CREATOR_VERSION_WRITE;

export const CREATOR_SESSION_AUD = "prompt-hash:creator-privacy";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 10 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MIN_SECRET_LENGTH = 32;

export interface CreatorSessionClaims {
  address: string;
  action: CreatorSessionAction;
  network: string;
  nonce: string;
  iat: number;
  exp: number;
  aud: string;
  /** Bound for version writes; "*" for list reads. */
  promptId: string;
  /** SHA-256 hex of content for version writes; empty for reads. */
  contentDigest: string;
}

export interface IssuedCreatorSession {
  sessionToken: string;
  challenge: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  network: string;
  action: CreatorSessionAction;
  promptId: string;
  contentDigest: string;
}

export interface VerifiedCreatorSession {
  address: string;
  action: CreatorSessionAction;
  network: string;
  nonce: string;
  promptId: string;
  contentDigest: string;
  exp: number;
}

export type CreatorSessionErrorCode =
  | "missing_credentials"
  | "malformed_credentials"
  | "invalid_token"
  | "expired_token"
  | "invalid_signature"
  | "replay"
  | "wrong_network"
  | "prompt_mismatch"
  | "action_mismatch"
  | "digest_mismatch"
  | "wallet_mismatch"
  | "configuration";

export class CreatorSessionError extends Error {
  readonly code: CreatorSessionErrorCode;

  constructor(code: CreatorSessionErrorCode, message: string) {
    super(message);
    this.name = "CreatorSessionError";
    this.code = code;
  }
}

function getSecret(override?: string): string {
  const secret = override ?? process.env.CHALLENGE_TOKEN_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new CreatorSessionError(
      "configuration",
      "Creator session secret is not configured.",
    );
  }
  return secret;
}

export function getExpectedNetworkPassphrase(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const passphrase = env.PUBLIC_STELLAR_NETWORK_PASSPHRASE;
  if (!passphrase || typeof passphrase !== "string" || !passphrase.trim()) {
    throw new CreatorSessionError(
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

function encodeClaims(claims: CreatorSessionClaims): string {
  return Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
}

function decodeClaims(encoded: string): CreatorSessionClaims {
  return JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  ) as CreatorSessionClaims;
}

export function isCreatorSessionAction(
  value: unknown,
): value is CreatorSessionAction {
  return (
    value === CREATOR_OWNED_READ ||
    value === CREATOR_DRAFTS_READ ||
    value === CREATOR_VERSION_WRITE
  );
}

/** SHA-256 hex digest of version content — bound into write sessions. */
export function digestVersionContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function buildCreatorSessionMessage(
  claims: CreatorSessionClaims,
): string {
  return (
    `prompt-hash creator:${claims.action}:${claims.address}:` +
    `${claims.promptId}:${claims.contentDigest}:${claims.network}:` +
    `${claims.nonce}:${claims.iat}:${claims.exp}`
  );
}

/**
 * In-process nonce ledger — one nonce = one successful authenticated use.
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

export const creatorSessionNonceLedger = new SessionNonceLedger();

export function createCreatorSessionToken(opts: {
  address: string;
  action: CreatorSessionAction;
  promptId?: string;
  contentDigest?: string;
  network?: string;
  secret?: string;
  now?: number;
  ttlMs?: number;
}): IssuedCreatorSession {
  const secret = getSecret(opts.secret);
  const now = opts.now ?? Date.now();
  const ttlMs = Math.min(opts.ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS);
  const network = (opts.network ?? getExpectedNetworkPassphrase()).trim();
  const address = opts.address.trim();

  if (!address) {
    throw new CreatorSessionError(
      "malformed_credentials",
      "address is required.",
    );
  }
  if (!isCreatorSessionAction(opts.action)) {
    throw new CreatorSessionError(
      "action_mismatch",
      "Unsupported creator action.",
    );
  }

  const isWrite = opts.action === CREATOR_VERSION_WRITE;
  const promptId = isWrite
    ? String(opts.promptId ?? "").trim()
    : String(opts.promptId ?? "*").trim() || "*";
  const contentDigest = isWrite
    ? String(opts.contentDigest ?? "").trim().toLowerCase()
    : "";

  if (isWrite && (!promptId || promptId === "*")) {
    throw new CreatorSessionError(
      "malformed_credentials",
      "promptId is required for version writes.",
    );
  }
  if (isWrite && !/^[a-f0-9]{64}$/.test(contentDigest)) {
    throw new CreatorSessionError(
      "malformed_credentials",
      "contentDigest (sha256 hex) is required for version writes.",
    );
  }

  const claims: CreatorSessionClaims = {
    address,
    action: opts.action,
    network,
    nonce: randomUUID(),
    iat: now,
    exp: now + ttlMs,
    aud: CREATOR_SESSION_AUD,
    promptId,
    contentDigest,
  };

  const encoded = encodeClaims(claims);
  const signature = signBody(secret, encoded);

  return {
    sessionToken: `${encoded}.${signature}`,
    challenge: buildCreatorSessionMessage(claims),
    issuedAt: claims.iat,
    expiresAt: claims.exp,
    nonce: claims.nonce,
    network: claims.network,
    action: claims.action,
    promptId: claims.promptId,
    contentDigest: claims.contentDigest,
  };
}

export function verifyCreatorSessionToken(
  sessionToken: string,
  opts?: {
    secret?: string;
    now?: number;
    expectedAction?: CreatorSessionAction;
    expectedNetwork?: string;
    expectedPromptId?: string;
    expectedContentDigest?: string;
  },
): CreatorSessionClaims {
  if (!sessionToken || typeof sessionToken !== "string") {
    throw new CreatorSessionError(
      "malformed_credentials",
      "Malformed session token.",
    );
  }

  const parts = sessionToken.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new CreatorSessionError(
      "malformed_credentials",
      "Malformed session token.",
    );
  }

  const [encoded, signature] = parts;
  const secret = getSecret(opts?.secret);
  const expectedSig = signBody(secret, encoded);
  if (!signaturesEqual(signature, expectedSig)) {
    throw new CreatorSessionError("invalid_token", "Invalid session token.");
  }

  let claims: CreatorSessionClaims;
  try {
    claims = decodeClaims(encoded);
  } catch {
    throw new CreatorSessionError("invalid_token", "Invalid session token.");
  }

  const now = opts?.now ?? Date.now();

  if (
    !claims ||
    typeof claims.address !== "string" ||
    !claims.address ||
    !isCreatorSessionAction(claims.action) ||
    typeof claims.network !== "string" ||
    !claims.network ||
    typeof claims.nonce !== "string" ||
    !claims.nonce ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number" ||
    claims.aud !== CREATOR_SESSION_AUD ||
    typeof claims.promptId !== "string" ||
    typeof claims.contentDigest !== "string"
  ) {
    throw new CreatorSessionError("invalid_token", "Invalid session token.");
  }

  if (claims.exp < now) {
    throw new CreatorSessionError("expired_token", "Session expired.");
  }

  if (claims.iat > now + MAX_CLOCK_SKEW_MS) {
    throw new CreatorSessionError("invalid_token", "Invalid session token.");
  }

  if (
    opts?.expectedAction !== undefined &&
    claims.action !== opts.expectedAction
  ) {
    throw new CreatorSessionError(
      "action_mismatch",
      "Session action does not match request.",
    );
  }

  const expectedNetwork = (
    opts?.expectedNetwork ?? getExpectedNetworkPassphrase()
  ).trim();
  if (claims.network !== expectedNetwork) {
    throw new CreatorSessionError(
      "wrong_network",
      "Session network does not match server network.",
    );
  }

  if (
    opts?.expectedPromptId !== undefined &&
    String(claims.promptId) !== String(opts.expectedPromptId)
  ) {
    throw new CreatorSessionError(
      "prompt_mismatch",
      "Session prompt does not match request.",
    );
  }

  if (
    opts?.expectedContentDigest !== undefined &&
    claims.contentDigest.toLowerCase() !==
      opts.expectedContentDigest.toLowerCase()
  ) {
    throw new CreatorSessionError(
      "digest_mismatch",
      "Session content digest does not match request body.",
    );
  }

  return claims;
}

/**
 * Full authentication: HMAC token + wallet signature + single-use nonce.
 */
export function authenticateCreatorSession(opts: {
  sessionToken: string;
  signature: string;
  expectedAction: CreatorSessionAction;
  expectedPromptId?: string;
  expectedContentDigest?: string;
  expectedWallet?: string;
  secret?: string;
  now?: number;
  expectedNetwork?: string;
  ledger?: SessionNonceLedger;
}): VerifiedCreatorSession {
  if (!opts.signature || typeof opts.signature !== "string") {
    throw new CreatorSessionError(
      "missing_credentials",
      "Wallet signature is required.",
    );
  }

  const claims = verifyCreatorSessionToken(opts.sessionToken, {
    secret: opts.secret,
    now: opts.now,
    expectedAction: opts.expectedAction,
    expectedNetwork: opts.expectedNetwork,
    expectedPromptId: opts.expectedPromptId,
    expectedContentDigest: opts.expectedContentDigest,
  });

  if (
    opts.expectedWallet !== undefined &&
    claims.address.toLowerCase() !== opts.expectedWallet.toLowerCase()
  ) {
    throw new CreatorSessionError(
      "wallet_mismatch",
      "Session wallet does not match requested creator.",
    );
  }

  const message = buildCreatorSessionMessage(claims);
  const ok = verifyChallengeSignature(
    claims.address,
    message,
    opts.signature,
  );
  if (!ok) {
    throw new CreatorSessionError(
      "invalid_signature",
      "Invalid wallet signature.",
    );
  }

  const ledger = opts.ledger ?? creatorSessionNonceLedger;
  const now = opts.now ?? Date.now();
  if (!ledger.consume(claims.nonce, claims.exp, now)) {
    throw new CreatorSessionError("replay", "Session nonce already used.");
  }

  return {
    address: claims.address.toLowerCase(),
    action: claims.action,
    network: claims.network,
    nonce: claims.nonce,
    promptId: claims.promptId,
    contentDigest: claims.contentDigest,
    exp: claims.exp,
  };
}

export function creatorSessionHttpStatus(err: CreatorSessionError): number {
  switch (err.code) {
    case "wallet_mismatch":
    case "wrong_network":
    case "prompt_mismatch":
    case "action_mismatch":
    case "digest_mismatch":
      return 403;
    case "replay":
      return 409;
    case "configuration":
      return 500;
    case "missing_credentials":
    case "malformed_credentials":
    case "invalid_token":
    case "expired_token":
    case "invalid_signature":
    default:
      return 401;
  }
}

/** Extract Bearer token from Authorization header. */
export function readBearerToken(
  authorization: string | undefined,
): string | undefined {
  if (!authorization || typeof authorization !== "string") return undefined;
  const match = /^Bearer\s+(\S+)/i.exec(authorization.trim());
  return match?.[1];
}
