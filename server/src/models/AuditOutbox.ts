/**
 * AuditOutbox — durable acceptance buffer for critical unlock audit events (#167).
 */

import mongoose, { Schema } from "mongoose";

export type AuditOutboxStatus = "accepted" | "draining" | "drained" | "dlq";

const redactedPayloadSchema = new Schema(
  {
    action: { type: String, required: true },
    result: { type: String, required: true },
    promptId: { type: String, default: null },
    walletHash: { type: String, default: null },
    requestId: { type: String, default: null },
    clientIpHash: { type: String, default: null },
    reason: { type: String, default: null },
  },
  { _id: false },
);

const auditOutboxSchema = new Schema(
  {
    acceptanceId: { type: String, required: true, unique: true, index: true },
    deliveryKey: { type: String, required: true, unique: true, index: true },
    payload: { type: redactedPayloadSchema, required: true },
    status: {
      type: String,
      required: true,
      enum: ["accepted", "draining", "drained", "dlq"] as AuditOutboxStatus[],
      index: true,
      default: "accepted",
    },
    attemptCount: { type: Number, default: 0 },
    maxRetries: { type: Number, default: 5 },
    acceptedAt: { type: Date, default: Date.now },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    lastError: { type: String, default: null },
  },
  { timestamps: true },
);

auditOutboxSchema.index({ status: 1, nextAttemptAt: 1 });

export const AuditOutbox =
  mongoose.models.AuditOutbox ||
  mongoose.model("AuditOutbox", auditOutboxSchema);
