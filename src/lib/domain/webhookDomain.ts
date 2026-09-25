/**
 * Authoritative webhook-subscription domain (#184).
 *
 * Serverless (`api/webhooks/index.ts`) and Express (`webhookControllers`) both
 * call these functions so SSRF checks, admin/signed-owner auth, event
 * filtering, and error mapping cannot drift between adapters.
 */

import { randomBytes } from "crypto";
import type { DomainResult } from "./domainResult";
import { created, fail, ok } from "./domainResult";
import {
  isAdminRequest,
  mergeAuthFields,
  validateSignedWebhookOwner,
  type AuthHeaders,
  type AuthBagFields,
} from "./adapterAuth";

export type WebhookSubscriptionRecord = {
  _id: unknown;
  walletAddress: string;
  url: string;
  events: string[];
  active: boolean;
  failureCount: number;
  secret?: string;
  save?: () => Promise<unknown>;
};

export type WebhookDomainDeps = {
  allowedEvents: readonly string[];
  validateDestinationUrl: (url: string) => Promise<{ valid: boolean }>;
  findByWallet: (wallet: string) => Promise<WebhookSubscriptionRecord | null>;
  /** Find by wallet with secret excluded (for GET responses). */
  findByWalletPublic: (wallet: string) => Promise<Omit<WebhookSubscriptionRecord, "secret"> | null>;
  createSubscription: (data: {
    walletAddress: string;
    url: string;
    secret: string;
    events: string[];
  }) => Promise<WebhookSubscriptionRecord>;
  deleteByWallet: (wallet: string) => Promise<void>;
  generateSecret?: () => string;
  adminToken?: string;
};

function resolveEvents(
  events: unknown,
  allowed: readonly string[],
): string[] {
  if (!Array.isArray(events)) return ["PromptPurchased"];
  return events.filter((e): e is string => typeof e === "string" && allowed.includes(e));
}

function defaultSecret(): string {
  return randomBytes(32).toString("hex");
}

export async function getWebhookSubscription(
  deps: WebhookDomainDeps,
  input: {
    headers?: AuthHeaders;
    body?: AuthBagFields;
    query?: AuthBagFields & Record<string, unknown>;
  },
): Promise<DomainResult> {
  if (isAdminRequest(input.headers, deps.adminToken)) {
    const walletAddress = input.query?.walletAddress;
    if (!walletAddress) {
      return fail(400, "walletAddress query param is required.");
    }
    const sub = await deps.findByWalletPublic(String(walletAddress).toLowerCase());
    if (!sub) return fail(404, "No webhook registered for this wallet.");
    return ok(sub);
  }

  const fields = mergeAuthFields(input.body, input.query);
  const owner = validateSignedWebhookOwner(
    fields,
    input.query?.walletAddress != null
      ? String(input.query.walletAddress)
      : undefined,
  );
  if (!owner) {
    return fail(401, "Unauthorized: signed ownership proof required.");
  }

  const sub = await deps.findByWalletPublic(owner);
  if (!sub) return fail(404, "No webhook registered for this wallet.");
  return ok(sub);
}

export async function registerWebhookSubscription(
  deps: WebhookDomainDeps,
  input: {
    headers?: AuthHeaders;
    body?: AuthBagFields & { url?: unknown; events?: unknown };
  },
): Promise<DomainResult> {
  const url = input.body?.url;
  if (!url) return fail(400, "url is required.");

  const ssrf = await deps.validateDestinationUrl(String(url));
  if (!ssrf.valid) {
    return fail(400, "Invalid or blocked webhook destination URL.");
  }

  let owner: string | null = null;
  if (isAdminRequest(input.headers, deps.adminToken) && input.body?.walletAddress) {
    owner = String(input.body.walletAddress).toLowerCase();
  } else {
    owner = validateSignedWebhookOwner(
      mergeAuthFields(input.body, undefined),
      input.body?.walletAddress != null ? String(input.body.walletAddress) : undefined,
    );
  }

  if (!owner) {
    return fail(401, "Unauthorized: signed ownership proof required.");
  }

  const secret = (deps.generateSecret ?? defaultSecret)();
  const resolvedEvents = resolveEvents(input.body?.events, deps.allowedEvents);
  const existing = await deps.findByWallet(owner);

  if (existing) {
    existing.url = String(url);
    existing.events = resolvedEvents;
    existing.active = true;
    existing.failureCount = 0;
    if (existing.save) await existing.save();
    return ok({ message: "Webhook updated.", id: existing._id, secret });
  }

  const sub = await deps.createSubscription({
    walletAddress: owner,
    url: String(url),
    secret,
    events: resolvedEvents,
  });

  return created({ message: "Webhook registered.", id: sub._id, secret });
}

export async function deleteWebhookSubscription(
  deps: WebhookDomainDeps,
  input: {
    headers?: AuthHeaders;
    body?: AuthBagFields;
  },
): Promise<DomainResult> {
  if (isAdminRequest(input.headers, deps.adminToken) && input.body?.walletAddress) {
    await deps.deleteByWallet(String(input.body.walletAddress).toLowerCase());
    return ok({ message: "Webhook removed." });
  }

  const owner = validateSignedWebhookOwner(
    mergeAuthFields(input.body, undefined),
    input.body?.walletAddress != null ? String(input.body.walletAddress) : undefined,
  );
  if (!owner) {
    return fail(401, "Unauthorized: signed ownership proof required.");
  }

  await deps.deleteByWallet(owner);
  return ok({ message: "Webhook removed." });
}

/** Dispatch GET/POST/DELETE for the dual-mounted `/api/webhooks` surface. */
export async function handleWebhookHttp(
  deps: WebhookDomainDeps,
  input: {
    method?: string;
    headers?: AuthHeaders;
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
  },
): Promise<DomainResult> {
  const method = String(input.method || "GET").toUpperCase();
  if (method === "GET") {
    return getWebhookSubscription(deps, {
      headers: input.headers,
      body: input.body,
      query: input.query,
    });
  }
  if (method === "POST") {
    return registerWebhookSubscription(deps, {
      headers: input.headers,
      body: input.body,
    });
  }
  if (method === "DELETE") {
    return deleteWebhookSubscription(deps, {
      headers: input.headers,
      body: input.body,
    });
  }
  return fail(405, "Method not allowed.");
}
