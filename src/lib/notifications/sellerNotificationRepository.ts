/**
 * Durable seller-notification repository (#181).
 *
 * Stores the append-only indexed event log and per-wallet cursor / read state.
 */

import type {
  IndexedSellerEvent,
  SellerNotificationCursorState,
} from "./sellerNotificationTypes";

export interface SellerNotificationRepository {
  /** Insert event by eventId (idempotent). Returns whether it was new. */
  appendEvent(event: IndexedSellerEvent): Promise<{ created: boolean; event: IndexedSellerEvent }>;

  /** All events for a seller wallet, ordered by ledger/tx/index. */
  listEventsForWallet(wallet: string): Promise<IndexedSellerEvent[]>;

  getEvent(eventId: string): Promise<IndexedSellerEvent | null>;

  /** Load or create empty cursor for wallet. */
  getCursor(wallet: string): Promise<SellerNotificationCursorState>;

  /** Persist cursor + read set atomically. */
  saveCursor(state: SellerNotificationCursorState): Promise<SellerNotificationCursorState>;

  clear(): Promise<void>;

  countEvents(): Promise<number>;
}
