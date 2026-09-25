/**
 * Frontend client for cursor-based seller notifications (#181).
 */

import type {
  SellerActivitySummary,
  SellerNotification,
  SellerNotificationFeed,
} from "./sellerNotificationTypes";

const API_BASE = "/api/seller-notifications";

export interface SellerNotificationsResponse extends SellerNotificationFeed {
  summary?: SellerActivitySummary;
  hasListings?: boolean;
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message =
      typeof body === "object" && body && "error" in body
        ? String((body as { error: unknown }).error)
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export async function fetchSellerNotificationFeed(
  wallet: string,
  options?: { advance?: boolean },
): Promise<SellerNotificationsResponse> {
  const params = new URLSearchParams({ wallet });
  if (options?.advance) params.set("advance", "1");
  const response = await fetch(`${API_BASE}?${params.toString()}`);
  return parseJson<SellerNotificationsResponse>(response);
}

export async function postSellerNotificationAction(
  wallet: string,
  action: "mark-read" | "mark-all-read" | "advance" | "clear-read",
  ids?: string[],
): Promise<{ ok: boolean; cursorEventId: string | null; readIds: string[] }> {
  const response = await fetch(API_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet, action, ids }),
  });
  return parseJson(response);
}

export type { SellerNotification, SellerNotificationFeed };
