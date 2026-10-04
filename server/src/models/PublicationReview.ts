import mongoose from "mongoose";

export type PublicationReviewDecision = "allow" | "review" | "block";

const publicationReviewAuditSchema = new mongoose.Schema(
  {
    actorAddress: { type: String, required: true },
    previousDecision: {
      type: String,
      enum: ["allow", "review", "block"],
      required: true,
    },
    newDecision: {
      type: String,
      enum: ["allow", "review", "block"],
      required: true,
    },
    reason: { type: String, required: true, trim: true },
    at: { type: Date, required: true },
    decisionVersion: {
      type: Number,
      required: true,
      min: 2,
      validate: Number.isSafeInteger,
    },
  },
  { _id: false },
);

const publicationReviewSchema = new mongoose.Schema(
  {
    // Exact wallet string from the creator flow. This record does not grant
    // wallet authority; the eventual contract transaction still owns that.
    creatorAddress: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    // SHA-256(JSON.stringify([title, content])). Plaintext is never stored.
    contentCommitment: {
      type: String,
      required: true,
      match: /^[a-f\d]{64}$/i,
      index: true,
    },
    initialDecision: {
      type: String,
      enum: ["review", "block"],
      required: true,
    },
    decision: {
      type: String,
      enum: ["allow", "review", "block"],
      required: true,
      index: true,
    },
    score: {
      type: Number,
      required: true,
      min: 0,
      max: 1,
    },
    similarTo: {
      type: String,
      default: null,
    },
    decisionVersion: {
      type: Number,
      default: 1,
      min: 1,
      validate: Number.isSafeInteger,
    },
    audits: {
      type: [publicationReviewAuditSchema],
      default: [],
    },
  },
  { timestamps: true },
);

publicationReviewSchema.index(
  { creatorAddress: 1, contentCommitment: 1 },
  { unique: true },
);

const PublicationReview =
  mongoose.models.PublicationReview ||
  mongoose.model("PublicationReview", publicationReviewSchema);

export default PublicationReview;
