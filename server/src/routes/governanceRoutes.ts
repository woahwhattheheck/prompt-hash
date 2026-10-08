import express, { Request, Response } from "express";
import { requireWalletPrincipal } from "../auth/walletPrincipalHttp";
import asyncHandler from "express-async-handler";
import Vote from "../models/Vote";
import Purchase from "../models/Purchase";

/**
 * Governance / voting routes — Issue #113
 *
 * POST /api/governance/vote/:promptId   — cast an upvote
 * DELETE /api/governance/vote/:promptId — remove an upvote
 * GET  /api/governance/votes/:promptId  — get vote count for a prompt
 * GET  /api/governance/top              — top-ranked prompts by votes
 */

export const governanceRouter = express.Router();

/** A request body is never proof of a wallet's identity. */
function authenticatedVoterWallet(req: Request, res: Response): string | null {
  const principalAddress = res.locals.walletPrincipal?.address;
  if (typeof principalAddress !== "string") {
    res.status(401).json({ error: "Wallet session required." });
    return null;
  }

  const claimedWallet = req.body?.voterWallet;
  if (claimedWallet !== undefined &&
      (typeof claimedWallet !== "string" || claimedWallet.toLowerCase() !== principalAddress.toLowerCase())) {
    res.status(403).json({ error: "Wallet does not match authenticated session." });
    return null;
  }
  return principalAddress.toLowerCase();
}

// ── Cast upvote ───────────────────────────────────────────────────────────────

governanceRouter.post(
  "/vote/:promptId",
  requireWalletPrincipal,
  asyncHandler(async (req, res) => {
    const { promptId } = req.params;
    const voterWallet = authenticatedVoterWallet(req, res);
    if (!voterWallet) return;

    // Eligibility: voter must have purchased this prompt
    const hasPurchased = await Purchase.exists({
      promptId,
      buyerWallet: voterWallet,
    });

    if (!hasPurchased) {
      res.status(403).json({ error: "Only buyers may vote on a prompt" });
      return;
    }

    try {
      await Vote.create({ promptId, voterWallet });
      const count = await Vote.countDocuments({ promptId });
      res.status(201).json({ success: true, upvotes: count });
    } catch (err: unknown) {
      // Duplicate key = already voted
      if ((err as { code?: number }).code === 11000) {
        res.status(409).json({ error: "You have already voted for this prompt" });
      } else {
        throw err;
      }
    }
  })
);

// ── Remove upvote ─────────────────────────────────────────────────────────────

governanceRouter.delete(
  "/vote/:promptId",
  requireWalletPrincipal,
  asyncHandler(async (req, res) => {
    const { promptId } = req.params;
    const voterWallet = authenticatedVoterWallet(req, res);
    if (!voterWallet) return;

    const deleted = await Vote.findOneAndDelete({
      promptId,
      voterWallet,
    });

    if (!deleted) {
      res.status(404).json({ error: "Vote not found" });
      return;
    }

    const count = await Vote.countDocuments({ promptId });
    res.json({ success: true, upvotes: count });
  })
);

// ── Get vote count ────────────────────────────────────────────────────────────

governanceRouter.get(
  "/votes/:promptId",
  asyncHandler(async (req, res) => {
    const { promptId } = req.params;
    const count = await Vote.countDocuments({ promptId });
    res.json({ promptId, upvotes: count });
  })
);

// ── Top-ranked prompts ────────────────────────────────────────────────────────

governanceRouter.get(
  "/top",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 10, 50);

    const top = await Vote.aggregate([
      { $group: { _id: "$promptId", upvotes: { $sum: 1 } } },
      { $sort: { upvotes: -1 } },
      { $limit: limit },
      { $project: { _id: 0, promptId: "$_id", upvotes: 1 } },
    ]);

    res.json({ prompts: top });
  })
);
