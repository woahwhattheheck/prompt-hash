/**
 * Shared verified admin principal (#146).
 *
 * Issues and verifies HMAC-SHA256-signed credentials used by privileged
 * server endpoints. The signature is checked before any claim is trusted.
 * Actor identity (`sub`) and roles come only from verified claims — never
 * from query params, bodies, or client-controlled fields.
 *
 * Token format: `<base64url(json-claims)>.<base64url(hmac-sha256)>`
 */

import { createHmac, randomUUID, timingSafeEqual } from "crypto";

export const ADMIN_ROLE = "admin";
export const REPORT_REVIEWER_ROLE = "report_reviewer";

export type AdminRole = typeof ADMIN_ROLE | typeof REPORT_REVIEWER_ROLE | string;

export interface AdminPrincipalClaims {
  /** Verified actor id (operator id or wallet). */
  sub: string;
  /** Roles granted to this principal. */
  roles: string[];
  /** Unique token id — used for revocation. */
  jti: string;
  /** Issued-at (ms since epoch). */
  iat: number;
  /** Expiry (ms since epoch). */
  exp: number;
  /** Audience binding (optional but recommended). */
  aud?: string;
}

export interface VerifiedAdminPrincipal {
  sub: string;
  roles: string[];
  jti: string;
  exp: number;
  aud?: string;
}

export type AdminAuthErrorCode =
  | "missing_credentials"
  | "malformed_credentials"
  | "invalid_token"
  | "expired_token"
  | "revoked_token"
  | "forbidden";

export class AdminAuthError extends Error {
  readonly code: AdminAuthErrorCode;

  constructor(code: AdminAuthErrorCode, message: string) {
    super(message);
    this.name = "AdminAuthError";
    this.code = code;
  }
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MIN_SECRET_LENGTH = 32;

function getSecret(override?: string): string {
  const secret = override ?? process.env.ADMIN_PRINCIPAL_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new AdminAuthError(
      "invalid_token",
      "Admin principal credentials are not configured.",
    );
  }
  return secret;
}

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function parseB64urlJson(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
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

/**
 * In-process revocation registry. Seeded from ADMIN_PRINCIPAL_REVOKED_JTIS
 * (comma-separated) and extensible via revokeAdminPrincipalToken().
 */
const revokedJtis = new Set<string>(loadRevokedJtisFromEnv());

function loadRevokedJtisFromEnv(): string[] {
  const raw = process.env.ADMIN_PRINCIPAL_REVOKED_JTIS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function revokeAdminPrincipalToken(jti: string): void {
  revokedJtis.add(jti);
}

export function isAdminPrincipalRevoked(jti: string): boolean {
  return revokedJtis.has(jti);
}

/** Test helper — clears in-process revocations (does not re-read env). */
export function clearAdminPrincipalRevocations(): void {
  revokedJtis.clear();
}

/** Test helper — re-seed revocations from the current env value. */
export function reloadAdminPrincipalRevocationsFromEnv(): void {
  revokedJtis.clear();
  for (const jti of loadRevokedJtisFromEnv()) {
    revokedJtis.add(jti);
  }
}

export function signAdminPrincipalToken(opts: {
  sub: string;
  roles: string[];
  secret?: string;
  jti?: string;
  now?: number;
  ttlMs?: number;
  aud?: string;
}): string {
  if (!opts.sub || typeof opts.sub !== "string") {
    throw new Error("signAdminPrincipalToken: sub is required");
  }
  if (!Array.isArray(opts.roles) || opts.roles.length === 0) {
    throw new Error("signAdminPrincipalToken: roles must be a non-empty array");
  }

  const secret = getSecret(opts.secret);
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

  const claims: AdminPrincipalClaims = {
    sub: opts.sub,
    roles: [...opts.roles],
    jti: opts.jti ?? randomUUID(),
    iat: now,
    exp: now + ttlMs,
  };
  if (opts.aud) claims.aud = opts.aud;

  const encoded = b64urlJson(claims);
  return `${encoded}.${signBody(secret, encoded)}`;
}

export function verifyAdminPrincipalToken(
  token: string,
  opts?: { secret?: string; now?: number; expectedAud?: string },
): AdminPrincipalClaims {
  const secret = getSecret(opts?.secret);
  const now = opts?.now ?? Date.now();

  if (!token || typeof token !== "string") {
    throw new AdminAuthError("malformed_credentials", "Malformed credentials.");
  }

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new AdminAuthError("malformed_credentials", "Malformed credentials.");
  }

  const [encoded, signature] = parts;

  // Verify signature BEFORE trusting any decoded claim.
  const expected = signBody(secret, encoded);
  if (!signaturesEqual(signature, expected)) {
    throw new AdminAuthError("invalid_token", "Invalid credentials.");
  }

  let claims: AdminPrincipalClaims;
  try {
    claims = parseB64urlJson(encoded) as AdminPrincipalClaims;
  } catch {
    throw new AdminAuthError("invalid_token", "Invalid credentials.");
  }

  if (
    !claims ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    !Array.isArray(claims.roles) ||
    claims.roles.length === 0 ||
    !claims.roles.every((r) => typeof r === "string" && r.length > 0) ||
    typeof claims.jti !== "string" ||
    !claims.jti ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number"
  ) {
    throw new AdminAuthError("invalid_token", "Invalid credentials.");
  }

  if (opts?.expectedAud) {
    if (claims.aud !== opts.expectedAud) {
      throw new AdminAuthError("invalid_token", "Invalid credentials.");
    }
  }

  if (claims.exp < now) {
    throw new AdminAuthError("expired_token", "Credentials expired.");
  }

  if (claims.iat > now + MAX_CLOCK_SKEW_MS) {
    throw new AdminAuthError("invalid_token", "Invalid credentials.");
  }

  if (isAdminPrincipalRevoked(claims.jti)) {
    throw new AdminAuthError("revoked_token", "Credentials revoked.");
  }

  return claims;
}

/**
 * Parse `Authorization: Bearer <token>`, verify the principal, and optionally
 * require at least one of `requiredRoles`.
 */
export function authorizeAdminPrincipal(
  authorizationHeader: string | undefined | null,
  opts?: {
    secret?: string;
    now?: number;
    expectedAud?: string;
    requiredRoles?: readonly string[];
  },
): VerifiedAdminPrincipal {
  if (authorizationHeader === undefined || authorizationHeader === null) {
    throw new AdminAuthError("missing_credentials", "Missing credentials.");
  }

  const trimmed = authorizationHeader.trim();
  if (trimmed === "") {
    throw new AdminAuthError("malformed_credentials", "Malformed credentials.");
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 2 || parts[0] !== "Bearer" || !parts[1]) {
    throw new AdminAuthError("malformed_credentials", "Malformed credentials.");
  }

  const claims = verifyAdminPrincipalToken(parts[1], {
    secret: opts?.secret,
    now: opts?.now,
    expectedAud: opts?.expectedAud,
  });

  if (opts?.requiredRoles && opts.requiredRoles.length > 0) {
    const hasRole = opts.requiredRoles.some((role) =>
      claims.roles.includes(role),
    );
    if (!hasRole) {
      throw new AdminAuthError("forbidden", "Forbidden.");
    }
  }

  return {
    sub: claims.sub,
    roles: claims.roles,
    jti: claims.jti,
    exp: claims.exp,
    aud: claims.aud,
  };
}
