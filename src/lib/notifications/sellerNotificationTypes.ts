/**
 * Seller in-app notifications driven by indexed events (#181).
 *
 * Notification identity comes from indexer event ids, not localStorage
 * snapshot diffs. Read state and the wallet cursor live in durable storage.
 */

export type SellerNotificationType = "sale" | "listing";

export type SellerEventTopic =
  | "PromptPurchased"
  | "PromptSaleStatusUpdated"
  | "PromptPriceUpdated";

/** Append-only seller-relevant indexed event. */
export interface IndexedSellerEvent {
  /** Stable id: network:contract:ledger:tx:eventIndex:schema */
  eventId: string;
  network: string;
  contract: string;
  ledger: number;
  transaction: string;
  eventIndex: number;
  schemaIdentity: string;
  topic: SellerEventTopic;
  /** Seller / creator wallet (normalized lowercase). */
  wallet: string;
  promptId: string;
  title: string;
  /** Wall-clock or indexer ingest time (ms). */
  createdAt: number;
  buyer?: string;
  active?: boolean;
  priceStroops?: string;
  /**
   * Logical key for reorg/correction supersede.
   * Same key + newer (ledger, tx, eventIndex) replaces the older row.
   */
  logicalKey: string;
  /** When set, this event explicitly tombstones / replaces another event id. */
  correctionOf?: string;
  /** Soft-delete flag applied during reconciliation. */
  tombstoned?: boolean;
}

export interface SellerNotification {
  id: string;
  type: SellerNotificationType;
  promptId: string;
  title: string;
  message: string;
  createdAt: number;
  read: boolean;
  eventId: string;
  logicalKey: string;
  ledger: number;
}

/** Wallet-scoped durable cursor + server-side read set. */
export interface SellerNotificationCursorState {
  wallet: string;
  /** Last consumed event id; null means "start of log". */
  cursorEventId: string | null;
  lastLedger: number;
  readIds: string[];
  updatedAt: number;
}

export interface SellerActivitySummary {
  totalListings: number;
  activeListings: number;
  totalSales: number;
}

export interface SellerNotificationFeed {
  notifications: SellerNotification[];
  cursorEventId: string | null;
  lastLedger: number;
  unreadCount: number;
}

export const MAX_STORED_NOTIFICATIONS = 50;

export const SELLER_EVENT_TOPICS: readonly SellerEventTopic[] = [
  "PromptPurchased",
  "PromptSaleStatusUpdated",
  "PromptPriceUpdated",
] as const;

export function normalizeWallet(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Build the stable indexer-style event id used across the pipeline.
 * Mirrors `server/src/services/indexerPipeline.eventId`.
 */
export function buildEventId(parts: {
  network: string;
  contract: string;
  ledger: number;
  transaction: string;
  eventIndex: number;
  schemaIdentity: string;
}): string {
  return [
    parts.network,
    parts.contract,
    parts.ledger,
    parts.transaction,
    parts.eventIndex,
    parts.schemaIdentity,
  ].join(":");
}

/** Deterministic notification id from an indexed event. */
export function notificationIdFromEvent(event: IndexedSellerEvent): string {
  return `notif:${event.eventId}`;
}

export function logicalKeyForEvent(
  topic: SellerEventTopic,
  promptId: string,
  extras?: { transaction?: string; priceStroops?: string; active?: boolean },
): string {
  switch (topic) {
    case "PromptPurchased":
      // One sale alert per on-chain purchase tx (not by rolling salesCount).
      return `sale:${promptId}:${extras?.transaction ?? ""}`;
    case "PromptSaleStatusUpdated":
      return `listing-active:${promptId}`;
    case "PromptPriceUpdated":
      return `listing-price:${promptId}`;
    default: {
      const _exhaustive: never = topic;
      return _exhaustive;
    }
  }
}

export function compareIndexedEvents(a: IndexedSellerEvent, b: IndexedSellerEvent): number {
  return (
    a.ledger - b.ledger ||
    a.transaction.localeCompare(b.transaction) ||
    a.eventIndex - b.eventIndex ||
    a.eventId.localeCompare(b.eventId)
  );
}
