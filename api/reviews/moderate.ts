/**
 * Maintainer/Admin Review Moderation Endpoint
 *
 * Affordances for maintainers to hide, unhide, or dismiss reports on prompt reviews.
 * Unauthorized requests are strictly rejected with 401/403.
 * Transitions are applied atomically on durable storage (#179).
 */

import {
  moderateReview,
  ReviewNotFoundError,
} from "../../src/lib/reviews/reviewStore";

export interface ModerationRequest {
  reviewId: string;
  promptId: string;
  action: "hide" | "unhide" | "dismiss_reports";
  adminAddress: string;
  adminSecretKey?: string;
}

function isAuthorizedAdmin(adminAddress: string, secretKey?: string, authHeader?: string): boolean {
  const configuredAdmin =
    process.env.ADMIN_WALLET_ADDRESS ?? process.env.PUBLIC_STELLAR_SIMULATION_ACCOUNT ?? "";
  const adminApiKey = process.env.ADMIN_API_KEY ?? "admin-secret-key";

  if (secretKey && secretKey === adminApiKey) {
    return true;
  }

  if (authHeader && authHeader === `Bearer ${adminApiKey}`) {
    return true;
  }

  if (
    configuredAdmin &&
    adminAddress &&
    adminAddress.toLowerCase() === configuredAdmin.toLowerCase()
  ) {
    return true;
  }

  return false;
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const authHeader = req.headers?.authorization;
  const { reviewId, promptId, action, adminAddress, adminSecretKey }: ModerationRequest =
    req.body ?? {};

  if (!reviewId || !promptId || !action || !adminAddress) {
    res.status(400).json({ error: "reviewId, promptId, action, and adminAddress are required" });
    return;
  }

  if (!["hide", "unhide", "dismiss_reports"].includes(action)) {
    res.status(400).json({ error: "Action must be 'hide', 'unhide', or 'dismiss_reports'" });
    return;
  }

  if (!isAuthorizedAdmin(adminAddress, adminSecretKey, authHeader)) {
    res.status(403).json({
      error: "Unauthorized: Maintainer/Admin permissions required to moderate reviews",
    });
    return;
  }

  try {
    const updatedReview = await moderateReview(String(reviewId), String(promptId), action);

    console.log(
      `✓ Maintainer ${adminAddress.slice(0, 8)} performed moderation action '${action}' on review ${reviewId}`,
    );

    res.status(200).json({
      success: true,
      action,
      review: {
        id: updatedReview.id,
        promptId: updatedReview.promptId,
        status: updatedReview.status,
        reportCount: updatedReview.reportCount,
        updatedAt: updatedReview.updatedAt,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to moderate review";
    console.error("Moderation error:", message);
    if (error instanceof ReviewNotFoundError || message.includes("not found")) {
      res.status(404).json({ error: message });
    } else {
      res.status(500).json({ error: message });
    }
  }
}
