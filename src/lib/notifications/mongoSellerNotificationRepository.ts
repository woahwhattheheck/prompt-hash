/**
 * Mongo-backed seller notification repository (#181).
 *
 * Expects SellerNotificationEvent + SellerNotificationCursor models.
 */

import { emptyCursor } from "./sellerNotificationCursor";
import type { SellerNotificationRepository } from "./sellerNotificationRepository";
import {
  compareIndexedEvents,
  normalizeWallet,
  type IndexedSellerEvent,
  type SellerNotificationCursorState,
} from "./sellerNotificationTypes";

type LeanEvent = IndexedSellerEvent & { _id?: unknown };
type LeanCursor = SellerNotificationCursorState & { _id?: unknown };

type Models = {
  SellerNotificationEvent: {
    findOneAndUpdate: (...args: any[]) => any;
    find: (...args: any[]) => any;
    findOne: (...args: any[]) => any;
    deleteMany: (...args: any[]) => any;
    countDocuments: (...args: any[]) => any;
  };
  SellerNotificationCursor: {
    findOne: (...args: any[]) => any;
    findOneAndUpdate: (...args: any[]) => any;
    deleteMany: (...args: any[]) => any;
  };
};

function strip<T extends { _id?: unknown }>(doc: T | null): Omit<T, "_id"> | null {
  if (!doc) return null;
  const { _id: _ignored, ...rest } = doc;
  return rest;
}

export function createMongoSellerNotificationRepository(
  models: Models,
): SellerNotificationRepository {
  const Event = models.SellerNotificationEvent;
  const Cursor = models.SellerNotificationCursor;

  return {
    async appendEvent(event) {
      const stored = { ...event, wallet: normalizeWallet(event.wallet) };
      const result = await Event.findOneAndUpdate(
        { eventId: stored.eventId },
        { $setOnInsert: stored },
        { upsert: true, new: true, rawResult: true, lean: true },
      );
      // mongoose rawResult shape varies; treat existing id as not created when matched.
      const doc = (result?.value ?? result) as LeanEvent;
      const created = Boolean(result?.lastErrorObject?.upserted || result?.upsertedCount);
      return { created, event: strip(doc) as IndexedSellerEvent };
    },

    async listEventsForWallet(wallet) {
      const key = normalizeWallet(wallet);
      const rows = (await Event.find({ wallet: key }).lean()) as LeanEvent[];
      return rows
        .map((r) => strip(r) as IndexedSellerEvent)
        .sort(compareIndexedEvents);
    },

    async getEvent(eventId) {
      const doc = (await Event.findOne({ eventId }).lean()) as LeanEvent | null;
      return strip(doc) as IndexedSellerEvent | null;
    },

    async getCursor(wallet) {
      const key = normalizeWallet(wallet);
      const doc = (await Cursor.findOne({ wallet: key }).lean()) as LeanCursor | null;
      return (strip(doc) as SellerNotificationCursorState | null) ?? emptyCursor(key);
    },

    async saveCursor(state) {
      const key = normalizeWallet(state.wallet);
      const next = { ...state, wallet: key };
      const doc = (await Cursor.findOneAndUpdate(
        { wallet: key },
        { $set: next },
        { upsert: true, new: true, lean: true },
      )) as LeanCursor;
      return strip(doc) as SellerNotificationCursorState;
    },

    async clear() {
      await Promise.all([Event.deleteMany({}), Cursor.deleteMany({})]);
    },

    async countEvents() {
      return Event.countDocuments({});
    },
  };
}
