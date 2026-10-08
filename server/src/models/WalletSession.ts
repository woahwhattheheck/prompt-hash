import mongoose from "mongoose";

/** Persistent session state and audit timestamps; no secret, proof or token. */
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  address: { type: String, required: true },
  network: { type: String, required: true },
  origin: { type: String, required: true },
  issuedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  lastUsedAt: { type: Date, default: null },
  accessCount: { type: Number, default: 0 },
}, { versionKey: false });

// Retain expired/revoked session audit metadata for 30 days. This index only
// performs cleanup; authentication independently enforces the token's expiry.
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

const WalletSession = mongoose.models.WalletSession || mongoose.model("WalletSession", schema);
export default WalletSession;
