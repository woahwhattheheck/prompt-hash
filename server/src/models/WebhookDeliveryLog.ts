import mongoose from "mongoose";

const webhookDeliveryLogSchema = new mongoose.Schema(
  {
    deliveryId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WebhookSubscription",
      required: true,
      index: true,
    },
    event: {
      type: String,
      required: true,
      index: true,
    },
    // Correlation evidence copied from the dispatched payload so a failed
    // delivery can later be matched back to the specific purchase it
    // belongs to (see reconciliationService.ts / issue #177), instead of
    // only being identifiable by its subscription/event.
    promptId: {
      type: String,
      default: null,
      index: true,
    },
    buyerWallet: {
      type: String,
      default: null,
      lowercase: true,
      index: true,
    },
    /**
     * Legacy column. Always stores the redacted endpoint identity (never
     * credentials or sensitive query values). Prefer endpointIdentity.
     * @see issue #176
     */
    url: {
      type: String,
      required: true,
    },
    /**
     * Redacted endpoint identity: scheme/host/port/path with userinfo stripped
     * and sensitive query values replaced by [REDACTED].
     */
    endpointIdentity: {
      type: String,
      required: true,
    },
    /**
     * AES-256-GCM ciphertext of the original destination (iv.tag.ct base64).
     * Null when WEBHOOK_DESTINATION_ENCRYPTION_KEY is unset — plaintext is never stored.
     */
    encryptedDestination: {
      type: String,
      default: null,
      select: false,
    },
    encryptionKeyVersion: {
      type: Number,
      default: null,
      select: false,
    },
    status: {
      type: String,
      enum: ["pending", "success", "failed", "retrying"],
      default: "pending",
      index: true,
    },
    attempts: {
      type: Number,
      default: 0,
    },
    lastStatus: {
      type: Number,
      default: null,
    },
    /** Closed-set error code (see webhookLogPrivacy.WEBHOOK_ERROR_CODES). */
    errorCode: {
      type: String,
      default: null,
    },
    /** Capped, sanitized error summary — never raw network/provider detail. */
    lastError: {
      type: String,
      default: null,
    },
    nextRetryAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    /**
     * Retention deadline. Mongo TTL index removes the document after this time.
     * Default: 30 days (WEBHOOK_DELIVERY_LOG_TTL_DAYS).
     */
    expiresAt: {
      type: Date,
      required: true,
      index: { expireAfterSeconds: 0 },
    },
  },
  { timestamps: true },
);

webhookDeliveryLogSchema.index({ event: 1, createdAt: -1 });
webhookDeliveryLogSchema.index({ subscriptionId: 1, createdAt: -1 });

const WebhookDeliveryLog =
  mongoose.models.WebhookDeliveryLog ||
  mongoose.model("WebhookDeliveryLog", webhookDeliveryLogSchema);

export default WebhookDeliveryLog;
