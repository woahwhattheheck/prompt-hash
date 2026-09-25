/**
 * Production PromptVersioningDeps wired to mongoose models (#184).
 */

import connectDb from "../../../server/src/db/connectDb";
import Prompt from "../../../server/src/models/Prompt";
import PromptVersion from "../../../server/src/models/PromptVersion";
import Purchase from "../../../server/src/models/Purchase";
import User from "../../../server/src/models/User";
import { publishPromptVersion } from "../../../server/src/services/promptVersioning";
import type { PromptVersioningDeps } from "./promptVersioningDomain";

export async function ensureDb(): Promise<void> {
  await connectDb();
}

export function createPromptVersioningDeps(): PromptVersioningDeps {
  return {
    findPurchase: async (promptId, buyerWallet) => {
      const purchase = await Purchase.findOne({ promptId, buyerWallet });
      if (!purchase) return null;
      return {
        versionIndex: purchase.versionIndex,
        createdAt: purchase.createdAt ?? null,
      };
    },
    findVersion: async (promptId, versionIndex) => {
      const version = await PromptVersion.findOne({ promptId, versionIndex });
      if (!version) return null;
      return {
        versionIndex: version.versionIndex,
        content: version.content,
        changeNote: version.changeNote ?? "",
      };
    },
    findPromptById: async (promptId) => {
      const prompt = await Prompt.findById(promptId).lean();
      if (!prompt) return null;
      return {
        _id: (prompt as { _id: unknown })._id,
        content: (prompt as { content?: string }).content ?? null,
        currentVersionIndex: (prompt as { currentVersionIndex?: number }).currentVersionIndex,
        owner: (prompt as { owner?: unknown }).owner,
      };
    },
    findUserByWallet: async (wallet) => {
      const user = await User.findOne({ walletAddress: wallet });
      if (!user) return null;
      return { _id: user._id, walletAddress: user.walletAddress };
    },
    findOwnedPrompt: async (promptId, ownerId) => {
      const prompt = await Prompt.findOne({ _id: promptId, owner: ownerId });
      if (!prompt) return null;
      return {
        _id: prompt._id,
        content: prompt.content,
        currentVersionIndex: prompt.currentVersionIndex,
        owner: prompt.owner,
      };
    },
    publishVersion: async ({ promptId, content, changeNote, createdBy }) => {
      return publishPromptVersion({
        promptId,
        content,
        changeNote,
        createdBy,
      });
    },
    listVersionHistory: async (promptId) => {
      return PromptVersion.find({ promptId })
        .sort({ versionIndex: -1 })
        .select("-content")
        .lean();
    },
    recordPurchase: async ({ promptId, buyerWallet, versionIndex, txHash }) => {
      let purchase;
      try {
        purchase = await Purchase.findOneAndUpdate(
          { promptId, buyerWallet },
          {
            $setOnInsert: {
              promptId,
              buyerWallet,
              versionIndex,
              txHash: txHash || "",
            },
          },
          { new: true, upsert: true, setDefaultsOnInsert: true },
        );
      } catch (upsertErr) {
        if ((upsertErr as { code?: number }).code === 11000) {
          purchase = await Purchase.findOne({ promptId, buyerWallet });
        } else {
          throw upsertErr;
        }
      }
      if (!purchase) {
        throw new Error("Failed to record purchase.");
      }
      const created =
        purchase.createdAt.getTime() === purchase.updatedAt.getTime();
      return {
        purchase: {
          versionIndex: purchase.versionIndex,
          createdAt: purchase.createdAt,
          updatedAt: purchase.updatedAt,
        },
        created,
      };
    },
  };
}
