import mongoose from "mongoose";

// Kept with the decision so each override and its audit append are one atomic
// document update. Actor subjects retain the exact verified principal identity.
const similarityOverrideSchema = new mongoose.Schema({
  promptId: { type: String, required: true },
  actorAddress: { type: String, required: true },
  previousDecision: { type: String, enum: ["allow", "review", "block"], required: true },
  newDecision: { type: String, enum: ["allow", "review", "block"], required: true },
  reason: { type: String, required: true, trim: true },
  score: { type: Number, required: true, min: 0, max: 1 },
  similarTo: { type: String, default: null },
  at: { type: String, required: true },
  decisionVersion: { type: Number, required: true, min: 2, validate: Number.isSafeInteger },
  // Preconditions for the optional Appeal projection, retained for safe retry.
  appealId: { type: String },
  appealPreviousVersion: { type: Number, min: 1, validate: Number.isSafeInteger },
  appealPreviousUpdatedAt: { type: Date },
}, { _id: false });

const promptSchema = new mongoose.Schema(
  {
    image: {
      type: String,
      required: true,
      trim: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      minLength: 3,
      maxLength: 100,
    },
    content: {
      type: String,
      required: true,
      trim: true,
      minLength: 10,
    },
    // Off-chain rich metadata (#333)
    description: {
      type: String,
      trim: true,
      maxLength: 4000,
      default: "",
    },
    tags: {
      type: [String],
      default: [],
      validate: {
        validator: (v: string[]) => v.length <= 10,
        message: "A prompt may have at most 10 tags",
      },
    },
    // References the on-chain listing so the two data stores stay in sync
    onChainReference: {
      type: String,
      trim: true,
      default: "",
    },
    rating: {
      type: Number,
      default: 1,
      min: 1,
      max: 5,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    category: {
      type: String,
      required: true,
      enum: [
        "Marketing",
        "Creative Writing",
        "Programming",
        "Music",
        "Gaming",
        "Other",
      ],
      default: "Other",
    },
    currentVersionIndex: {
      type: Number,
      default: 1,
      min: 1,
    },
    // Anti-plagiarism fields (Issue #133, #157)
    // Scan state (queued, retryable processing)
    similarityScanStatus: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending",
      index: true,
    },
    similarityScanJobId: {
      // Reference to SimilarityJob document
      type: mongoose.Schema.Types.ObjectId,
      ref: "SimilarityJob",
      default: null,
    },
    
    // Results (updated when scan completes)
    similarityFlag: {
      type: String,
      enum: ["clean", "suspicious", "highly_similar"],
      default: "clean",
      index: true,
    },
    similarityScore: {
      type: Number,
      default: null,
      min: 0,
      max: 1,
    },
    similarTo: {
      // onChainId of the most similar existing prompt, if flagged.
      type: String,
      default: null,
    },
    similarityCheckedAt: {
      type: Date,
      default: null,
    },
    
    similarityDecisionVersion: {
      type: Number,
      default: 1,
      min: 1,
      validate: Number.isSafeInteger,
    },
    similarityOverrides: {
      type: [similarityOverrideSchema],
      default: [],
    },

    // Privacy-preserving fingerprint (no plaintext)
    // Allows efficient similarity scanning without loading full content
    fingerprintVersion: {
      type: String,
      default: "1.0",
    },
    fingerprint: {
      minHash: [Number], // MinHash signature
      tokenHistogram: Buffer, // Quantized token frequencies
      contentHash: String, // SHA256 for verification only
      tokenCount: Number,
      length: Number,
    },
    onChainId: {
      type: String,
      default: null,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    listingStatus: {
      type: String,
      enum: ['draft', 'ready', 'published', 'archived'],
      default: 'draft',
      index: true,
    },
    savedPrompts: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'User',
      default: [],
    },
    salesCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    previewCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    currentRevision: {
      type: Number,
      default: 0,
      min: 0,
    },
    revisionNotes: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    timestamps: true,
  },
);
promptSchema.index({ title: 1 });
promptSchema.index({ isActive: 1, listingStatus: 1, price: 1 });
promptSchema.index({ category: 1, isActive: 1 });
promptSchema.index({ title: 1, isActive: 1 });

// Check if the model exists before creating it
const Prompt = mongoose.models.Prompt || mongoose.model("Prompt", promptSchema);

export default Prompt;

