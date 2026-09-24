import mongoose from "mongoose";

const evidenceRefSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: [
        "content_hash",
        "ipfs_cid",
        "url_ref",
        "tx_hash",
        "screenshot_hash",
      ],
      required: true,
    },
    ref: {
      type: String,
      required: true,
      maxlength: 512,
    },
    note: {
      type: String,
      maxlength: 200,
      default: undefined,
    },
  },
  { _id: false },
);

const statusHistorySchema = new mongoose.Schema(
  {
    from: {
      type: String,
      enum: ["pending", "investigating", "resolved", "dismissed"],
      required: true,
    },
    to: {
      type: String,
      enum: ["pending", "investigating", "resolved", "dismissed"],
      required: true,
    },
    actor: {
      type: String,
      required: true,
      lowercase: true,
    },
    notes: {
      type: String,
      maxlength: 500,
      default: undefined,
    },
    at: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  { _id: false },
);

const reportSchema = new mongoose.Schema(
  {
    promptId: {
      type: String,
      required: true,
      index: true,
    },
    reporterAddress: {
      type: String,
      required: true,
      lowercase: true,
    },
    /** When true, non-admin responses must redact the reporter wallet. */
    reporterPrivate: {
      type: Boolean,
      default: true,
    },
    reason: {
      type: String,
      enum: [
        "quality-issue",
        "misleading-content",
        "plagiarism",
        "harmful-content",
        "copyright",
        "other",
      ],
      required: true,
    },
    description: {
      type: String,
      maxlength: 500,
    },
    evidence: {
      type: [evidenceRefSchema],
      default: [],
      validate: {
        validator(v: unknown[]) {
          return Array.isArray(v) && v.length <= 5;
        },
        message: "At most 5 evidence items are allowed",
      },
    },
    status: {
      type: String,
      enum: ["pending", "investigating", "resolved", "dismissed"],
      default: "pending",
      index: true,
    },
    statusHistory: {
      type: [statusHistorySchema],
      default: [],
    },
    adminNotes: {
      type: String,
      default: "",
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    moderatedBy: {
      type: String,
      default: null,
      lowercase: true,
    },
  },
  {
    timestamps: true,
  },
);

// Index for finding reports by prompt
reportSchema.index({ promptId: 1, createdAt: -1 });
// Duplicate open-report lookups: same reporter + prompt + reason
reportSchema.index(
  { promptId: 1, reporterAddress: 1, reason: 1, status: 1 },
  { name: "report_duplicate_open_lookup" },
);

const Report = mongoose.models.Report || mongoose.model("Report", reportSchema);

export default Report;
