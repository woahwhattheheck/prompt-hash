import express from "express";
import { requireWalletPrincipal } from "../auth/walletPrincipalHttp";
import { requireFulfillmentService } from "../auth/fulfillmentService";
import {
  GetBuyerVersion,
  GetPromptVersions,
  PostPromptUpdate,
  RecordPurchase,
} from "../controllers/versioningControllers";

export const versioningRouter = express.Router();

// Creator posts a new content version.
versioningRouter.post("/update", PostPromptUpdate);
// List version history for a prompt (metadata only, no content).
versioningRouter.get("/:promptId/history", GetPromptVersions);
// Index only purchase state already verified by the trusted backend.\n// A browser wallet session cannot mint this entitlement record.\nversioningRouter.post("/purchase", requireFulfillmentService, RecordPurchase);
// Get the version a specific buyer purchased (for unlock).
versioningRouter.get("/buyer-version", requireWalletPrincipal, GetBuyerVersion);
