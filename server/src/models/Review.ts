import mongoose from "mongoose";

const reviewReportSchema = new mongoose.Schema(
  {
    reporterAddress: {
      type: String,
      required: true,
      lowercase: true,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false },
);

const reviewSchema = new mongoose.Schema(
  {
    /** Stable public id used by report/moderate APIs (survives ObjectId drift). */
    reviewId: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },
    promptId: {
      type: String,
      required: true,
      index: true,
    },
    userAddress: {
      type: String,
      required: true,
      lowercase: true,
      index: true,
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },
    text: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2000,
    },
    verified: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: ["visible", "hidden", "flagged", "pending"],
      default: "visible",
      index: true,
    },
    reports: {
      type: [reviewReportSchema],
      default: [],
    },
    reportCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true },
);

// One review per user per prompt — concurrent inserts race to this index.
reviewSchema.index({ promptId: 1, userAddress: 1 }, { unique: true });

const Review = mongoose.models.Review || mongoose.model("Review", reviewSchema);
export default Review;
