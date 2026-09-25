/**
 * Migration 003 — Durable reviews: moderation fields + remove legacy seeds (#179)
 *
 * Run once:  npx ts-node server/src/db/migrations/003_durable_reviews_remove_seeds.ts
 *
 * What it does:
 *   - Backfills status / reports / reportCount / reviewId on existing Review docs
 *   - Deletes known fictional seed reviews from the old in-memory map
 */

import "dotenv/config";
import mongoose from "mongoose";

const LEGACY_SEED_REVIEW_IDS = ["review_1", "review_2", "review_3"];
const LEGACY_SEED_WALLETS = [
  "gabc123xyz456def789ghi012jkl345mno678pqr901stu234vwx567yz",
  "gbcd234abc567efg890hij123klm456nop789qrs012tuv345wxy678za",
  "gcde345bcd678fgh901ijk234lmn567opq890rst123uvw456xyz789ab",
];

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  const reviews = db.collection("reviews");

  const backfill = await reviews.updateMany(
    {
      $or: [
        { status: { $exists: false } },
        { reports: { $exists: false } },
        { reportCount: { $exists: false } },
      ],
    },
    {
      $set: {
        status: "visible",
        reports: [],
        reportCount: 0,
      },
    },
  );
  console.log(`[003] Backfilled moderation fields on ${backfill.modifiedCount} reviews`);

  const missingIds = await reviews.find({ reviewId: { $exists: false } }).toArray();
  let idBackfill = 0;
  for (const doc of missingIds) {
    await reviews.updateOne(
      { _id: doc._id },
      { $set: { reviewId: `review_migrated_${doc._id.toString()}` } },
    );
    idBackfill += 1;
  }
  console.log(`[003] Backfilled reviewId on ${idBackfill} reviews`);

  const deleted = await reviews.deleteMany({
    $or: [
      { reviewId: { $in: LEGACY_SEED_REVIEW_IDS } },
      { userAddress: { $in: LEGACY_SEED_WALLETS } },
    ],
  });
  console.log(`[003] Removed ${deleted.deletedCount} legacy seed reviews`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("[003] Migration failed:", err);
  process.exit(1);
});
