/**
 * Pure cursor-based seller notification feed (#181).
 *
 * Given an indexed event log + wallet cursor + read set, produce a
 * deterministic notification feed. No localStorage / snapshot diffs.
 */

import {
  MAX_STORED_NOTIFICATIONS,
  compareIndexedEvents,
  notificationIdFromEvent,
  normalizeWallet,
  type IndexedSellerEvent,
  type SellerNotification,
  type SellerNotificationCursorState,
  type SellerNotificationFeed,
  type SellerNotificationType,
} from "./sellerNotificationTypes";

/** Empty cursor for a wallet (start of log). */
export function emptyCursor(wallet: string, now = Date.now()): SellerNotificationCursorState {
  return {
    wallet: normalizeWallet(wallet),
    cursorEventId: null,
    lastLedger: 0,
    readIds: [],
    updatedAt: now,
  };
}

/**
 * Collapse corrections / reorgs: for each logicalKey keep the newest
 * non-tombstoned event; honor explicit correctionOf links.
 */
export function reconcileEvents(events: IndexedSellerEvent[]): IndexedSellerEvent[] {
  const byId = new Map<string, IndexedSellerEvent>();
  for (const event of events) {
    byId.set(event.eventId, event);
  }

  // Explicit corrections tombstone their targets.
  for (const event of events) {
    if (event.correctionOf && byId.has(event.correctionOf)) {
      const prior = byId.get(event.correctionOf)!;
      byId.set(prior.eventId, { ...prior, tombstoned: true });
    }
  }

  // Per logicalKey keep the newest by (ledger, tx, eventIndex).
  const bestByKey = new Map<string, IndexedSellerEvent>();
  for (const event of [...byId.values()].sort(compareIndexedEvents)) {
    if (event.tombstoned) continue;
    const prev = bestByKey.get(event.logicalKey);
    if (!prev || compareIndexedEvents(event, prev) >= 0) {
      if (prev) {
        byId.set(prev.eventId, { ...prev, tombstoned: true });
      }
      bestByKey.set(event.logicalKey, event);
    } else {
      byId.set(event.eventId, { ...event, tombstoned: true });
    }
  }

  return [...byId.values()]
    .filter((e) => !e.tombstoned)
    .sort(compareIndexedEvents);
}

function messageFor(event: IndexedSellerEvent): { type: SellerNotificationType; message: string } {
  switch (event.topic) {
    case "PromptPurchased":
      return {
        type: "sale",
        message: `New sale — "${event.title}" was purchased.`,
      };
    case "PromptSaleStatusUpdated":
      return {
        type: "listing",
        message: event.active
          ? `"${event.title}" is now listed and available to buyers.`
          : `"${event.title}" was delisted and is no longer for sale.`,
      };
    case "PromptPriceUpdated":
      return {
        type: "listing",
        message: `Price updated for "${event.title}".`,
      };
  }
}

export function eventToNotification(
  event: IndexedSellerEvent,
  readIds: ReadonlySet<string>,
): SellerNotification {
  const { type, message } = messageFor(event);
  const id = notificationIdFromEvent(event);
  return {
    id,
    type,
    promptId: event.promptId,
    title: event.title,
    message,
    createdAt: event.createdAt,
    read: readIds.has(id),
    eventId: event.eventId,
    logicalKey: event.logicalKey,
    ledger: event.ledger,
  };
}

/**
 * Events strictly after the cursor (exclusive). If cursor is null / unknown,
 * return the full reconciled log (deterministic backfill from start).
 */
export function eventsAfterCursor(
  events: IndexedSellerEvent[],
  cursorEventId: string | null,
): IndexedSellerEvent[] {
  const reconciled = reconcileEvents(events);
  if (!cursorEventId) return reconciled;
  const idx = reconciled.findIndex((e) => e.eventId === cursorEventId);
  if (idx === -1) {
    // Cursor recovery: unknown / wiped cursor → full deterministic rebuild.
    return reconciled;
  }
  return reconciled.slice(idx + 1);
}

/**
 * Build the notification feed for a wallet from indexed events + cursor state.
 * Same inputs always produce the same feed (deterministic backfill).
 */
export function buildFeedFromCursor(
  events: IndexedSellerEvent[],
  cursor: SellerNotificationCursorState,
  options?: { includeHistory?: boolean; limit?: number },
): SellerNotificationFeed {
  const limit = options?.limit ?? MAX_STORED_NOTIFICATIONS;
  const includeHistory = options?.includeHistory ?? true;
  const readIds = new Set(cursor.readIds);
  const reconciled = reconcileEvents(events);

  const slice = includeHistory
    ? reconciled
    : eventsAfterCursor(events, cursor.cursorEventId);

  const notifications = slice
    .map((e) => eventToNotification(e, readIds))
    // Newest first for the UI feed.
    .sort((a, b) => b.ledger - a.ledger || b.createdAt - a.createdAt || b.id.localeCompare(a.id))
    .slice(0, limit);

  const last = reconciled[reconciled.length - 1];
  return {
    notifications,
    cursorEventId: cursor.cursorEventId,
    lastLedger: last?.ledger ?? cursor.lastLedger,
    unreadCount: notifications.filter((n) => !n.read).length,
  };
}

/**
 * Advance the cursor to the tip of the reconciled log (after a successful poll).
 */
export function advanceCursorToTip(
  events: IndexedSellerEvent[],
  cursor: SellerNotificationCursorState,
  now = Date.now(),
): SellerNotificationCursorState {
  const reconciled = reconcileEvents(events);
  const tip = reconciled[reconciled.length - 1];
  if (!tip) {
    return { ...cursor, updatedAt: now };
  }
  return {
    ...cursor,
    cursorEventId: tip.eventId,
    lastLedger: tip.ledger,
    updatedAt: now,
  };
}

/** Mark notification ids read (server-side read set). */
export function markNotificationsRead(
  cursor: SellerNotificationCursorState,
  ids: string[],
  now = Date.now(),
): SellerNotificationCursorState {
  const readIds = new Set(cursor.readIds);
  for (const id of ids) readIds.add(id);
  return {
    ...cursor,
    readIds: [...readIds],
    updatedAt: now,
  };
}

export function markAllReadInFeed(
  cursor: SellerNotificationCursorState,
  feed: SellerNotificationFeed,
  now = Date.now(),
): SellerNotificationCursorState {
  return markNotificationsRead(
    cursor,
    feed.notifications.map((n) => n.id),
    now,
  );
}

/**
 * Simulate "missed polls": apply a batch of new events without intermediate
 * cursor advances, then build the feed. Used by tests and gap recovery.
 */
export function backfillFromCursor(
  allEvents: IndexedSellerEvent[],
  cursor: SellerNotificationCursorState,
): SellerNotificationFeed {
  return buildFeedFromCursor(allEvents, cursor, { includeHistory: true });
}
