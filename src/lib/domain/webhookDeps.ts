/**
 * Production WebhookDomainDeps wired to mongoose models (#184).
 */

import connectDb from "../../../server/src/db/connectDb";
import WebhookSubscription from "../../../server/src/models/WebhookSubscription";
import { ALLOWED_EVENTS } from "../../../server/src/services/webhookDispatcher";
import { validateWebhookUrl } from "../../../server/src/services/ssrfProtection";
import type { WebhookDomainDeps } from "./webhookDomain";

export async function ensureWebhookDb(): Promise<void> {
  await connectDb();
}

export function createWebhookDomainDeps(): WebhookDomainDeps {
  return {
    allowedEvents: ALLOWED_EVENTS as unknown as readonly string[],
    validateDestinationUrl: validateWebhookUrl,
    findByWallet: async (wallet) => {
      return WebhookSubscription.findOne({ walletAddress: wallet });
    },
    findByWalletPublic: async (wallet) => {
      return WebhookSubscription.findOne({ walletAddress: wallet }).select("-secret");
    },
    createSubscription: async (data) => {
      const sub = new WebhookSubscription(data);
      await sub.save();
      return sub;
    },
    deleteByWallet: async (wallet) => {
      await WebhookSubscription.deleteOne({ walletAddress: wallet });
    },
  };
}
