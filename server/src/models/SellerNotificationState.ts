/**
 * Durable seller notification event log + wallet cursor (#181).
 */

import mongoose from "mongoose";

const sellerNotificationEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    network: { type: String, required: true },
    contract: { type: String, required: true },
    ledger: { type: Number, required: true, index: true },
    transaction: { type: String, required: true },
    eventIndex: { type: Number, required: true },
    schemaIdentity: { type: String, required: true },
    topic: {
      type: String,
      required: true,
      enum: ["PromptPurchased", "PromptSaleStatusUpdated", "PromptPriceUpdated"],
    },
    wallet: { type: String, required: true, index: true },
    promptId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    createdAt: { type: Number, required: true },
    buyer: { type: String },
    active: { type: Boolean },
    priceStroops: { type: String },
    logicalKey: { type: String, required: true, index: true },
    correctionOf: { type: String },
    tombstoned: { type: Boolean, default: false },
  },
  { timestamps: true },
);

sellerNotificationEventSchema.index({ wallet: 1, ledger: 1, transaction: 1, eventIndex: 1 });

const sellerNotificationCursorSchema = new mongoose.Schema(
  {
    wallet: { type: String, required: true, unique: true, index: true },
    cursorEventId: { type: String, default: null },
    lastLedger: { type: Number, default: 0 },
    readIds: { type: [String], default: [] },
    updatedAt: { type: Number, required: true },
  },
  { timestamps: true },
);

export const SellerNotificationEvent =
  mongoose.models.SellerNotificationEvent ||
  mongoose.model("SellerNotificationEvent", sellerNotificationEventSchema);

export const SellerNotificationCursor =
  mongoose.models.SellerNotificationCursor ||
  mongoose.model("SellerNotificationCursor", sellerNotificationCursorSchema);

export default {
  SellerNotificationEvent,
  SellerNotificationCursor,
};
