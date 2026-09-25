import { emptyCursor } from "./sellerNotificationCursor";
import type { SellerNotificationRepository } from "./sellerNotificationRepository";
import {
  compareIndexedEvents,
  normalizeWallet,
  type IndexedSellerEvent,
  type SellerNotificationCursorState,
} from "./sellerNotificationTypes";

export function createMemorySellerNotificationRepository(): SellerNotificationRepository {
  const events = new Map<string, IndexedSellerEvent>();
  const cursors = new Map<string, SellerNotificationCursorState>();

  return {
    async appendEvent(event) {
      const existing = events.get(event.eventId);
      if (existing) return { created: false, event: existing };
      const stored = {
        ...event,
        wallet: normalizeWallet(event.wallet),
      };
      events.set(stored.eventId, stored);
      return { created: true, event: stored };
    },

    async listEventsForWallet(wallet) {
      const key = normalizeWallet(wallet);
      return [...events.values()]
        .filter((e) => e.wallet === key)
        .sort(compareIndexedEvents);
    },

    async getEvent(eventId) {
      return events.get(eventId) ?? null;
    },

    async getCursor(wallet) {
      const key = normalizeWallet(wallet);
      return cursors.get(key) ?? emptyCursor(key);
    },

    async saveCursor(state) {
      const key = normalizeWallet(state.wallet);
      const next = { ...state, wallet: key };
      cursors.set(key, next);
      return next;
    },

    async clear() {
      events.clear();
      cursors.clear();
    },

    async countEvents() {
      return events.size;
    },
  };
}
