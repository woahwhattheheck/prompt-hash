/**
 * Durable seller-notification store (#181).
 *
 * File-backed by default; optional Mongo when MONGODB_URI is set via the
 * server model. Tests inject an in-memory repository.
 */

import os from "os";
import path from "path";
import {
  advanceCursorToTip,
  buildFeedFromCursor,
  markAllReadInFeed,
  markNotificationsRead,
} from "./sellerNotificationCursor";
import { createFileSellerNotificationRepository } from "./fileSellerNotificationRepository";
import { createMemorySellerNotificationRepository } from "./memorySellerNotificationRepository";
import type { SellerNotificationRepository } from "./sellerNotificationRepository";
import {
  normalizeWallet,
  type IndexedSellerEvent,
  type SellerNotificationCursorState,
  type SellerNotificationFeed,
} from "./sellerNotificationTypes";

export type {
  IndexedSellerEvent,
  SellerNotification,
  SellerNotificationCursorState,
  SellerNotificationFeed,
  SellerEventTopic,
} from "./sellerNotificationTypes";

export {
  buildEventId,
  logicalKeyForEvent,
  notificationIdFromEvent,
  normalizeWallet,
} from "./sellerNotificationTypes";

export {
  advanceCursorToTip,
  backfillFromCursor,
  buildFeedFromCursor,
  emptyCursor,
  eventsAfterCursor,
  eventToNotification,
  markAllReadInFeed,
  markNotificationsRead,
  reconcileEvents,
} from "./sellerNotificationCursor";

let configured: SellerNotificationRepository | null = null;
let defaultPromise: Promise<SellerNotificationRepository> | null = null;

export function configureSellerNotificationRepository(
  repo: SellerNotificationRepository | null,
): void {
  configured = repo;
  defaultPromise = null;
}

export function defaultSellerNotificationStorePath(): string {
  const fromEnv = process.env.SELLER_NOTIFICATION_STORE_PATH?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.tmpdir(), "prompt-hash-seller-notifications", "store.json");
}

async function buildDefaultRepository(): Promise<SellerNotificationRepository> {
  if (process.env.MONGODB_URI) {
    try {
      const [{ default: connectDb }, modelModule] = await Promise.all([
        import("../../../server/src/db/connectDb"),
        import("../../../server/src/models/SellerNotificationState"),
      ]);
      await connectDb();
      const { createMongoSellerNotificationRepository } = await import(
        "./mongoSellerNotificationRepository"
      );
      return createMongoSellerNotificationRepository(modelModule as never);
    } catch {
      // Fall through to file store when server model is unavailable (frontend-only).
    }
  }
  return createFileSellerNotificationRepository(defaultSellerNotificationStorePath());
}

export async function getSellerNotificationRepository(): Promise<SellerNotificationRepository> {
  if (configured) return configured;
  if (!defaultPromise) {
    defaultPromise = buildDefaultRepository();
  }
  return defaultPromise;
}

export async function appendSellerEvent(
  event: IndexedSellerEvent,
): Promise<{ created: boolean; event: IndexedSellerEvent }> {
  const repo = await getSellerNotificationRepository();
  return repo.appendEvent({
    ...event,
    wallet: normalizeWallet(event.wallet),
  });
}

export async function getSellerFeed(
  wallet: string,
  options?: { advance?: boolean },
): Promise<SellerNotificationFeed & { cursor: SellerNotificationCursorState }> {
  const repo = await getSellerNotificationRepository();
  const key = normalizeWallet(wallet);
  const events = await repo.listEventsForWallet(key);
  let cursor = await repo.getCursor(key);
  const feed = buildFeedFromCursor(events, cursor);
  if (options?.advance) {
    cursor = await repo.saveCursor(advanceCursorToTip(events, cursor));
  }
  return { ...feed, cursor };
}

export async function markSellerNotificationsRead(
  wallet: string,
  ids: string[],
): Promise<SellerNotificationCursorState> {
  const repo = await getSellerNotificationRepository();
  const key = normalizeWallet(wallet);
  const cursor = await repo.getCursor(key);
  return repo.saveCursor(markNotificationsRead(cursor, ids));
}

export async function markAllSellerNotificationsRead(
  wallet: string,
): Promise<SellerNotificationCursorState> {
  const repo = await getSellerNotificationRepository();
  const key = normalizeWallet(wallet);
  const events = await repo.listEventsForWallet(key);
  const cursor = await repo.getCursor(key);
  const feed = buildFeedFromCursor(events, cursor);
  return repo.saveCursor(markAllReadInFeed(cursor, feed));
}

export async function advanceSellerCursor(wallet: string): Promise<SellerNotificationCursorState> {
  const repo = await getSellerNotificationRepository();
  const key = normalizeWallet(wallet);
  const events = await repo.listEventsForWallet(key);
  const cursor = await repo.getCursor(key);
  return repo.saveCursor(advanceCursorToTip(events, cursor));
}

export async function resetSellerNotificationStore(): Promise<void> {
  const repo = await getSellerNotificationRepository();
  await repo.clear();
}

export { createFileSellerNotificationRepository } from "./fileSellerNotificationRepository";
export { createMemorySellerNotificationRepository } from "./memorySellerNotificationRepository";

export { createMongoSellerNotificationRepository } from "./mongoSellerNotificationRepository";
