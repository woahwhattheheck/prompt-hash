/**
 * Authoritative adapter auth helpers (#184).
 *
 * Admin-token and signed-owner checks for webhook (and similar) domain
 * services live here once. Adapters must not reimplement these rules.
 */

import { verifyChallengeSignature } from "../auth/challenge";

export type AuthHeaders = Record<string, string | string[] | undefined>;

export type AuthBagFields = {
  walletAddress?: unknown;
  signedMessage?: unknown;
  timestamp?: unknown;
};

function headerValue(headers: AuthHeaders | undefined, name: string): string {
  if (!headers) return "";
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
    }
  }
  return "";
}

/**
 * True when the request carries a valid admin rotation bearer token.
 * Empty / unset ADMIN_ROTATION_TOKEN never authenticates.
 */
export function isAdminRequest(
  headers: AuthHeaders | undefined,
  adminToken = process.env.ADMIN_ROTATION_TOKEN || "",
): boolean {
  const auth = headerValue(headers, "authorization");
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice("Bearer ".length).trim();
  return Boolean(token && adminToken && token === adminToken);
}

/**
 * Validate a signed ownership proof for webhook management.
 *
 * Expected message: `prompt-hash webhooks:{addr}:{timestamp}`
 * Returns the normalized (lowercase) wallet address on success, else null.
 */
export function validateSignedWebhookOwner(
  fields: AuthBagFields,
  address?: string,
): string | null {
  const addr = String(address ?? fields.walletAddress ?? "").toLowerCase();
  const signedMessage = fields.signedMessage;
  const timestamp = fields.timestamp;
  if (
    !addr ||
    signedMessage == null ||
    timestamp == null ||
    signedMessage === "" ||
    timestamp === ""
  ) {
    return null;
  }
  const expected = `prompt-hash webhooks:${addr}:${timestamp}`;
  try {
    if (verifyChallengeSignature(addr, expected, String(signedMessage))) {
      return addr;
    }
  } catch {
    return null;
  }
  return null;
}

/** Merge body + query auth fields (query fills gaps). */
export function mergeAuthFields(
  body?: AuthBagFields,
  query?: AuthBagFields,
): AuthBagFields {
  return {
    walletAddress: body?.walletAddress ?? query?.walletAddress,
    signedMessage: body?.signedMessage ?? query?.signedMessage,
    timestamp: body?.timestamp ?? query?.timestamp,
  };
}
