/**
 * Seller notification center — event-cursor derivation (#181).
 *
 * In-app alerts are driven from indexed seller events with a wallet-scoped
 * durable cursor and server-side read state. localStorage snapshots are no
 * longer the source of truth (legacy helpers remain only for migration tests).
 *
 * Email notification delivery is out of scope.
 */

import type { PromptRecord } from "@/lib/stellar/promptHashClient";
import {
  buildFeedFromCursor,
  emptyCursor,
  reconcileEvents,
} from "./sellerNotificationCursor";
import type {
  IndexedSellerEvent,
  SellerActivitySummary,
  SellerNotification,
  SellerNotificationCursorState,
  SellerNotificationFeed,
} from "./sellerNotificationTypes";
import {
  MAX_STORED_NOTIFICATIONS,
  buildEventId,
  logicalKeyForEvent,
  notificationIdFromEvent,
  normalizeWallet,
} from "./sellerNotificationTypes";

export type {
  SellerNotification,
  SellerNotificationType,
  SellerActivitySummary,
  IndexedSellerEvent,
  SellerNotificationCursorState,
  SellerNotificationFeed,
  SellerEventTopic,
} from "./sellerNotificationTypes";

export {
  MAX_STORED_NOTIFICATIONS,
  buildEventId,
  logicalKeyForEvent,
  notificationIdFromEvent,
  normalizeWallet,
} from "./sellerNotificationTypes";

export {
  buildFeedFromCursor,
  backfillFromCursor,
  advanceCursorToTip,
  emptyCursor,
  eventsAfterCursor,
  eventToNotification,
  markAllReadInFeed,
  markNotificationsRead,
  reconcileEvents,
} from "./sellerNotificationCursor";

export function summariseActivity(prompts: PromptRecord[]): SellerActivitySummary {
  return {
    totalListings: prompts.length,
    activeListings: prompts.filter((prompt) => prompt.active).length,
    totalSales: prompts.reduce((sum, prompt) => sum + (prompt.salesCount ?? 0), 0),
  };
}

/** Prepends fresh notifications, dropping duplicates and capping the stored feed. */
export function mergeNotifications(
  existing: SellerNotification[],
  incoming: SellerNotification[],
): SellerNotification[] {
  const seen = new Set(existing.map((notification) => notification.id));
  const fresh = incoming.filter((notification) => !seen.has(notification.id));
  return [...fresh, ...existing].slice(0, MAX_STORED_NOTIFICATIONS);
}

/**
 * Deterministic feed from indexed events + cursor (primary API for #181).
 */
export function deriveNotificationsFromEvents(
  events: IndexedSellerEvent[],
  cursor: SellerNotificationCursorState | null,
): SellerNotification[] {
  const state = cursor ?? emptyCursor(events[0]?.wallet ?? "");
  return buildFeedFromCursor(events, state).notifications;
}

/** Helper to build a seller event from indexer fields. */
export function makeSellerEvent(input: {
  network: string;
  contract: string;
  ledger: number;
  transaction: string;
  eventIndex: number;
  schemaIdentity?: string;
  topic: IndexedSellerEvent["topic"];
  wallet: string;
  promptId: string;
  title: string;
  createdAt?: number;
  buyer?: string;
  active?: boolean;
  priceStroops?: string;
  correctionOf?: string;
}): IndexedSellerEvent {
  const schemaIdentity = input.schemaIdentity ?? "prompt-hash:v1";
  const eventId = buildEventId({ ...input, schemaIdentity });
  return {
    eventId,
    network: input.network,
    contract: input.contract,
    ledger: input.ledger,
    transaction: input.transaction,
    eventIndex: input.eventIndex,
    schemaIdentity,
    topic: input.topic,
    wallet: normalizeWallet(input.wallet),
    promptId: String(input.promptId),
    title: input.title,
    createdAt: input.createdAt ?? Date.now(),
    buyer: input.buyer,
    active: input.active,
    priceStroops: input.priceStroops,
    logicalKey: logicalKeyForEvent(input.topic, String(input.promptId), {
      transaction: input.transaction,
      priceStroops: input.priceStroops,
      active: input.active,
    }),
    correctionOf: input.correctionOf,
  };
}

// ── Legacy snapshot helpers (deprecated; kept for call-site compatibility) ──

/** @deprecated Snapshot diffs are replaced by indexed event cursors (#181). */
export interface PromptSnapshot {
  salesCount: number;
  active: boolean;
  priceStroops: string;
}

/** @deprecated */
export type SnapshotMap = Record<string, PromptSnapshot>;

/** @deprecated */
export function snapshotOf(prompts: PromptRecord[]): SnapshotMap {
  const map: SnapshotMap = {};
  for (const prompt of prompts) {
    map[prompt.id.toString()] = {
      salesCount: prompt.salesCount ?? 0,
      active: prompt.active,
      priceStroops: prompt.priceStroops.toString(),
    };
  }
  return map;
}

/**
 * @deprecated Prefer `deriveNotificationsFromEvents` / `buildFeedFromCursor`.
 * Retained so existing unit tests document the old behaviour until removed.
 */
export function deriveNotifications(
  previous: SnapshotMap | null,
  prompts: PromptRecord[],
  now: number,
): SellerNotification[] {
  if (!previous) return [];

  const notifications: SellerNotification[] = [];
  for (const prompt of prompts) {
    const id = prompt.id.toString();
    const before = previous[id];
    if (!before) continue;

    const sales = prompt.salesCount ?? 0;
    if (sales > before.salesCount) {
      const delta = sales - before.salesCount;
      notifications.push({
        id: `sale:${id}:${sales}`,
        type: "sale",
        promptId: id,
        title: prompt.title,
        message:
          delta === 1
            ? `New sale — "${prompt.title}" was purchased (${sales} total).`
            : `${delta} new sales — "${prompt.title}" now has ${sales} total.`,
        createdAt: now,
        read: false,
        eventId: `legacy:sale:${id}:${sales}`,
        logicalKey: `sale:${id}:legacy`,
        ledger: 0,
      });
    }

    if (before.active !== prompt.active) {
      notifications.push({
        id: `listing-active:${id}:${prompt.active}`,
        type: "listing",
        promptId: id,
        title: prompt.title,
        message: prompt.active
          ? `"${prompt.title}" is now listed and available to buyers.`
          : `"${prompt.title}" was delisted and is no longer for sale.`,
        createdAt: now,
        read: false,
        eventId: `legacy:listing-active:${id}:${prompt.active}`,
        logicalKey: `listing-active:${id}`,
        ledger: 0,
      });
    }

    const price = prompt.priceStroops.toString();
    if (before.priceStroops !== price) {
      notifications.push({
        id: `listing-price:${id}:${price}`,
        type: "listing",
        promptId: id,
        title: prompt.title,
        message: `Price updated for "${prompt.title}".`,
        createdAt: now,
        read: false,
        eventId: `legacy:listing-price:${id}:${price}`,
        logicalKey: `listing-price:${id}`,
        ledger: 0,
      });
    }
  }
  return notifications;
}

const NOTIFICATIONS_PREFIX = "prompt-hash:seller-notifications:";
const SNAPSHOT_PREFIX = "prompt-hash:seller-snapshot:";

function readJson<T>(key: string): T | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota / unavailable storage
  }
}

/** @deprecated Ephemeral UI cache only — durable feed lives server-side. */
export function loadStoredNotifications(address: string): SellerNotification[] {
  return readJson<SellerNotification[]>(`${NOTIFICATIONS_PREFIX}${address}`) ?? [];
}

/** @deprecated */
export function saveStoredNotifications(
  address: string,
  notifications: SellerNotification[],
): void {
  writeJson(`${NOTIFICATIONS_PREFIX}${address}`, notifications);
}

/** @deprecated */
export function loadSnapshot(address: string): SnapshotMap | null {
  return readJson<SnapshotMap>(`${SNAPSHOT_PREFIX}${address}`);
}

/** @deprecated */
export function saveSnapshot(address: string, prompts: PromptRecord[]): void {
  writeJson(`${SNAPSHOT_PREFIX}${address}`, snapshotOf(prompts));
}

/** Clear legacy local snapshot/feed keys (e.g. after migrating to cursors). */
export function clearLegacyLocalNotificationState(address: string): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(`${NOTIFICATIONS_PREFIX}${address}`);
    window.localStorage.removeItem(`${SNAPSHOT_PREFIX}${address}`);
  } catch {
    // ignore
  }
}

