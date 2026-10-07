import mongoose from "mongoose";

/**
 * Durable one-time-use ledger for signed creator sessions.
 *
 * The session nonce itself is the Mongo document _id, so duplicate consumption
 * is race-safe across Express/serverless processes without relying on a
 * separately-created unique index. The TTL index is cleanup only; token expiry
 * is still checked cryptographically before this ledger is consulted.
 */
const creatorSessionNonceSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    versionKey: false,
  },
);

creatorSessionNonceSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 },
);

const CreatorSessionNonce =
  mongoose.models.CreatorSessionNonce ||
  mongoose.model("CreatorSessionNonce", creatorSessionNonceSchema);

export default CreatorSessionNonce;
