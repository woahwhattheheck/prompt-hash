import { createHmac, randomUUID } from "crypto";
import WebhookSubscription from "../models/WebhookSubscription";
import WebhookDeliveryLog from "../models/WebhookDeliveryLog";
import {
  buildDeliveryLogEndpointFields,
  computeDeliveryLogExpiresAt,
  normalizeDeliveryError,
  normalizeHttpError,
} from "./webhookLogPrivacy";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2_000;
const MAX_FAILURES_BEFORE_DISABLE = 10;
const DELIVERY_TIMEOUT_MS = 10_000;

export const ALLOWED_EVENTS = [
  "PromptPurchased",
  "PromptCreated",
  "LicenseTransferred",
  "ReviewSubmitted",
] as const;

export type WebhookEvent = (typeof ALLOWED_EVENTS)[number];

export interface WebhookPayload {
  event: string;
  deliveryId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export function signPayload(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifySignature(
  secret: string,
  body: string,
  signature: string,
): boolean {
  const expected = signPayload(secret, body);
  if (expected.length !== signature.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}

import { safeDeliverWebhook } from "./ssrfProtection";

function computeRetryDelay(attempt: number): number {
  return BASE_DELAY_MS * Math.pow(2, attempt);
}

async function deliverOnce(
  url: string,
  secret: string,
  payload: WebhookPayload,
): Promise<number> {
  const body = JSON.stringify(payload);
  const signature = signPayload(secret, body);

  const headers = {
    "Content-Type": "application/json",
    "X-PromptHash-Signature": signature,
    "X-PromptHash-Delivery": payload.deliveryId,
    "X-PromptHash-Event": payload.event,
    "X-PromptHash-Timestamp": payload.timestamp,
  };

  const { status } = await safeDeliverWebhook(url, headers, body, DELIVERY_TIMEOUT_MS);
  return status;
}

async function deliverWithRetry(
  subscriptionId: string,
  url: string,
  secret: string,
  payload: WebhookPayload,
): Promise<void> {
  let logEntry = await WebhookDeliveryLog.findOne({ deliveryId: payload.deliveryId });
  if (!logEntry) {
    // Copy correlation evidence out of the payload so a failed delivery can
    // later be matched back to the specific purchase it belongs to (see
    // reconciliationService.ts). Different callers have historically used
    // either `buyerWallet` or `buyer` as the key - accept both.
    const promptId = payload.data?.promptId != null ? String(payload.data.promptId) : null;
    const buyerWalletRaw = payload.data?.buyerWallet ?? payload.data?.buyer ?? null;
    const buyerWallet = buyerWalletRaw != null ? String(buyerWalletRaw).toLowerCase() : null;

    const endpointFields = buildDeliveryLogEndpointFields(url);

    logEntry = await WebhookDeliveryLog.create({
      deliveryId: payload.deliveryId,
      subscriptionId,
      event: payload.event,
      // Redacted identity only — never credentials or sensitive query values (#176).
      url: endpointFields.url,
      endpointIdentity: endpointFields.endpointIdentity,
      encryptedDestination: endpointFields.encryptedDestination,
      encryptionKeyVersion: endpointFields.encryptionKeyVersion,
      status: "retrying",
      promptId,
      buyerWallet,
      expiresAt: computeDeliveryLogExpiresAt(),
    });
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    logEntry.attempts = attempt + 1;

    try {
      const status = await deliverOnce(url, secret, payload);
      logEntry.lastStatus = status;

      if (status >= 200 && status < 300) {
        logEntry.status = "success";
        logEntry.errorCode = null;
        logEntry.lastError = null;
        logEntry.completedAt = new Date();
        await logEntry.save();

        await WebhookSubscription.findByIdAndUpdate(subscriptionId, {
          lastDeliveredAt: new Date(),
          $set: { failureCount: 0 },
        });
        return;
      }

      if (status >= 400 && status < 500 && status !== 429) {
        logEntry.status = "failed";
        const normalized = normalizeHttpError(status);
        logEntry.errorCode = normalized.errorCode;
        logEntry.lastError = normalized.lastError;
        logEntry.completedAt = new Date();
        await logEntry.save();

        const updated = await WebhookSubscription.findByIdAndUpdate(
          subscriptionId,
          { $inc: { failureCount: 1 } },
          { new: true },
        );
        if (updated && updated.failureCount >= MAX_FAILURES_BEFORE_DISABLE) {
          await WebhookSubscription.findByIdAndUpdate(subscriptionId, { active: false });
        }
        return;
      }

      const normalized = normalizeHttpError(status);
      logEntry.errorCode = normalized.errorCode;
      logEntry.lastError = normalized.lastError;
    } catch (err) {
      const normalized = normalizeDeliveryError(err);
      logEntry.errorCode = normalized.errorCode;
      logEntry.lastError = normalized.lastError;
    }

    const isLastAttempt = attempt === MAX_RETRIES;
    if (!isLastAttempt) {
      const delay = computeRetryDelay(attempt);
      logEntry.nextRetryAt = new Date(Date.now() + delay);
      logEntry.status = "retrying";
      await logEntry.save();
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    logEntry.status = "failed";
    logEntry.completedAt = new Date();
    await logEntry.save();

    const updated = await WebhookSubscription.findByIdAndUpdate(
      subscriptionId,
      { $inc: { failureCount: 1 } },
      { new: true },
    );
    if (updated && updated.failureCount >= MAX_FAILURES_BEFORE_DISABLE) {
      await WebhookSubscription.findByIdAndUpdate(subscriptionId, { active: false });
    }
  }
}

export async function dispatchEvent(
  creatorWallet: string,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!ALLOWED_EVENTS.includes(event as WebhookEvent)) return;

  const subscriptions = await WebhookSubscription.find({
    walletAddress: creatorWallet.toLowerCase(),
    active: true,
    events: event,
  });

  if (subscriptions.length === 0) return;

  const payload: WebhookPayload = {
    event,
    deliveryId: randomUUID(),
    timestamp: new Date().toISOString(),
    data,
  };

  await Promise.allSettled(
    subscriptions.map((sub) =>
      deliverWithRetry(String(sub._id), sub.url, sub.secret, payload),
    ),
  );
}
