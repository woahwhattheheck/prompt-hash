/**
 * Review List Endpoint
 *
 * Returns public reviews for a specific prompt, sorted by most recent first.
 * Filters out hidden reviews and strips internal moderation metadata.
 * Reads from durable review storage (#179).
 */

import { getPublicReviews } from "../../src/lib/reviews/reviewStore";

export default async function handler(req: any, res: any) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { promptId } = req.query;

  if (!promptId) {
    res.status(400).json({ error: "promptId query parameter is required" });
    return;
  }

  try {
    const publicReviews = await getPublicReviews(String(promptId));

    const averageRating =
      publicReviews.length > 0
        ? publicReviews.reduce((sum, r) => sum + r.rating, 0) / publicReviews.length
        : 0;

    res.status(200).json({
      reviews: publicReviews,
      stats: {
        total: publicReviews.length,
        averageRating: Math.round(averageRating * 10) / 10,
        distribution: {
          5: publicReviews.filter((r) => r.rating === 5).length,
          4: publicReviews.filter((r) => r.rating === 4).length,
          3: publicReviews.filter((r) => r.rating === 3).length,
          2: publicReviews.filter((r) => r.rating === 2).length,
          1: publicReviews.filter((r) => r.rating === 1).length,
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch reviews";
    console.error("Review fetch error:", message);
    res.status(500).json({ error: message });
  }
}
