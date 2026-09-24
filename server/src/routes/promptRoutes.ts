import express from "express";
import asyncHandler from "express-async-handler";
import {
  GetPrompts,
  GetOwnedPrompts,
  GetSavedPrompts,
  GetDraftPrompts,
  SubmitPromptReport,
  GetPromptReports,
  RecordPreview,
  GetPreviewStats,
  GetPreviewToken,
} from "../controllers/controllers";
import {
  CREATOR_DRAFTS_READ,
  CREATOR_OWNED_READ,
  CREATOR_VERSION_WRITE,
  CreatorSessionError,
  createCreatorSessionToken,
  creatorSessionHttpStatus,
  digestVersionContent,
  getExpectedNetworkPassphrase,
  isCreatorSessionAction,
  type CreatorSessionAction,
} from "../auth/creatorSession";

export const promptRouter = express.Router();

/**
 * OFF-CHAIN INDEXING ONLY
 *
 * The Soroban smart contract at contracts/prompt-hash is the single source of
 * truth for prompt ownership, listing state, and purchase records. This server
 * is strictly a read-through cache and event indexer — it must never originate
 * state changes that should be governed by the on-chain contract.
 *
 * Write operations (create, publish, archive, save) are DEPRECATED. The Stellar
 * contract's create_prompt, set_prompt_sale_status, set_prompt_max_supply, and
 * buy_prompt methods control all prompt lifecycle transitions.
 *
 * DEPRECATED ROUTES (removed — do not restore without on-chain verification):
 *   POST /              → CreatePrompt  (duplicates create_prompt)
 *   POST /buyer/save    → SavePrompt    (client-side preference, not authoritative)
 *   POST /buyer/unsave  → UnsavePrompt  (client-side preference)
 *   POST /:id/publish   → PublishPrompt (duplicates set_prompt_sale_status)
 *   POST /:id/archive   → ArchivePrompt (duplicates set_prompt_sale_status)
 *
 * Creator privacy (#142): owned/drafts reads and version writes require a
 * signed creator session. Issue sessions via POST /creator-session.
 */

promptRouter.route("/").get(GetPrompts);

// ── Issue creator session (#142) ─────────────────────────────────────────────

promptRouter.post(
  "/creator-session",
  asyncHandler(async (req, res) => {
    const { address, action, promptId, content, contentDigest } = req.body as {
      address?: string;
      action?: string;
      promptId?: string;
      content?: string;
      contentDigest?: string;
    };

    if (!address || !action) {
      res.status(400).json({ error: "address and action are required" });
      return;
    }

    if (!isCreatorSessionAction(action)) {
      res.status(400).json({
        error:
          "action must be creator_owned_read, creator_drafts_read, or creator_version_write",
      });
      return;
    }

    const secret = process.env.CHALLENGE_TOKEN_SECRET;
    if (!secret || secret.length < 32) {
      res.status(500).json({ error: "Configuration error." });
      return;
    }

    try {
      const network = getExpectedNetworkPassphrase();
      let digest = contentDigest;
      if (action === CREATOR_VERSION_WRITE) {
        if (content && typeof content === "string") {
          digest = digestVersionContent(content);
        }
        if (!promptId || !digest) {
          res.status(400).json({
            error:
              "promptId and content (or contentDigest) are required for creator_version_write",
          });
          return;
        }
      }

      const issued = createCreatorSessionToken({
        address,
        action: action as CreatorSessionAction,
        promptId,
        contentDigest: digest,
        network,
        secret,
      });
      res.status(200).json(issued);
    } catch (err) {
      if (err instanceof CreatorSessionError) {
        res.status(creatorSessionHttpStatus(err)).json({
          error: err.message,
          code: err.code,
        });
        return;
      }
      throw err;
    }
  }),
);

promptRouter.get("/buyer/:walletAddress/owned", GetOwnedPrompts);
promptRouter.get("/buyer/:walletAddress/saved", GetSavedPrompts);
promptRouter.get("/creator/:walletAddress/drafts", GetDraftPrompts);

// Preview analytics (#257)
promptRouter.get("/preview/token", GetPreviewToken);
promptRouter.post("/preview", RecordPreview);
promptRouter.get("/preview/stats", GetPreviewStats);

// Report endpoints — off-chain moderation data, does not affect access control
promptRouter.post("/reports", SubmitPromptReport);
promptRouter.get("/reports", GetPromptReports);

// Re-export action constants for tests / docs consumers
export {
  CREATOR_OWNED_READ,
  CREATOR_DRAFTS_READ,
  CREATOR_VERSION_WRITE,
};
