import express from "express";
import asyncHandler from "express-async-handler";
import Vote from "../models/Vote";
import Purchase from "../models/Purchase";
import {
  VOTE_CREATE_ACTION,
  VOTE_DELETE_ACTION,
  WalletSessionError,
  authenticateVoteSession,
  createWalletSessionToken,
  getExpectedNetworkPassphrase,
  isVoteSessionAction,
  walletSessionHttpStatus,
  type VoteSessionAction,
} from "../auth/walletSession";

/**
 * Governance / voting routes — Issue #113 + authenticated votes (#147)
 *
 * POST   /api/governance/session         — issue signed wallet vote session
 * POST   /api/governance/vote/:promptId  — cast an upvote (authenticated)
 * DELETE /api/governance/vote/:promptId  — remove an upvote (authenticated)
 * GET    /api/governance/votes/:promptId — get vote count for a prompt (public)
 * GET    /api/governance/top             — top-ranked prompts by votes (public)
 *
 * Voter identity is derived only from a verified wallet session. Any
 * `voterWallet` (or similar) field in the request body is ignored.
 */

export const governanceRouter = express.Router();

function readSessionSecret(): string | undefined {
  return process.env.CHALLENGE_TOKEN_SECRET;
}

function rejectSessionError(
  res: express.Response,
  err: unknown,
): boolean {
  if (err instanceof WalletSessionError) {
    res.status(walletSessionHttpStatus(err)).json({
      error: err.message,
      code: err.code,
    });
    return true;
  }
  return false;
}

// ── Issue vote session ────────────────────────────────────────────────────────

governanceRouter.post(
  "/session",
  asyncHandler(async (req, res) => {
    const { address, promptId, action } = req.body as {
      address?: string;
      promptId?: string;
      action?: string;
    };

    if (!address || !promptId || !action) {
      res.status(400).json({
        error: "address, promptId, and action are required",
      });
      return;
    }

    if (!isVoteSessionAction(action)) {
      res.status(400).json({
        error:
          "action must be governance_vote_create or governance_vote_delete",
      });
      return;
    }

    const secret = readSessionSecret();
    if (!secret || secret.length < 32) {
      res.status(500).json({ error: "Configuration error." });
      return;
    }

    try {
      const network = getExpectedNetworkPassphrase();
      const issued = createWalletSessionToken({
        address,
        promptId: String(promptId),
        action: action as VoteSessionAction,
        network,
        secret,
      });
      res.status(200).json(issued);
    } catch (err) {
      if (rejectSessionError(res, err)) return;
      throw err;
    }
  }),
);

// ── Cast upvote ───────────────────────────────────────────────────────────────

governanceRouter.post(
  "/vote/:promptId",
  asyncHandler(async (req, res) => {
    const { promptId } = req.params;
    const { sessionToken, signature } = req.body as {
      sessionToken?: string;
      signature?: string;
      // Intentionally ignored — never trust caller-provided wallet identity.
      voterWallet?: string;
    };

    if (!sessionToken || !signature) {
      res.status(400).json({
        error: "sessionToken and signature are required",
      });
      return;
    }

    const secret = readSessionSecret();
    if (!secret || secret.length < 32) {
      res.status(500).json({ error: "Configuration error." });
      return;
    }

    let voterWallet: string;
    try {
      const session = authenticateVoteSession({
        sessionToken,
        signature,
        expectedPromptId: promptId,
        expectedAction: VOTE_CREATE_ACTION,
        secret,
      });
      voterWallet = session.address;
    } catch (err) {
      if (rejectSessionError(res, err)) return;
      throw err;
    }

    // Eligibility: authenticated wallet must have purchased this prompt
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
      // Duplicate key = already voted (one purchase principal ≤1 vote)
      if ((err as { code?: number }).code === 11000) {
        res
          .status(409)
          .json({ error: "You have already voted for this prompt" });
      } else {
        throw err;
      }
    }
  }),
);

// ── Remove upvote ─────────────────────────────────────────────────────────────

governanceRouter.delete(
  "/vote/:promptId",
  asyncHandler(async (req, res) => {
    const { promptId } = req.params;
    const { sessionToken, signature } = req.body as {
      sessionToken?: string;
      signature?: string;
      voterWallet?: string;
    };

    if (!sessionToken || !signature) {
      res.status(400).json({
        error: "sessionToken and signature are required",
      });
      return;
    }

    const secret = readSessionSecret();
    if (!secret || secret.length < 32) {
      res.status(500).json({ error: "Configuration error." });
      return;
    }

    let voterWallet: string;
    try {
      const session = authenticateVoteSession({
        sessionToken,
        signature,
        expectedPromptId: promptId,
        expectedAction: VOTE_DELETE_ACTION,
        secret,
      });
      voterWallet = session.address;
    } catch (err) {
      if (rejectSessionError(res, err)) return;
      throw err;
    }

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
  }),
);

// ── Get vote count (public aggregate) ─────────────────────────────────────────

governanceRouter.get(
  "/votes/:promptId",
  asyncHandler(async (req, res) => {
    const { promptId } = req.params;
    const count = await Vote.countDocuments({ promptId });
    res.json({ promptId, upvotes: count });
  }),
);

// ── Top-ranked prompts (public aggregate) ─────────────────────────────────────

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
  }),
);
