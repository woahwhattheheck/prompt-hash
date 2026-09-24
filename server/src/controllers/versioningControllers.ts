import { Request, Response } from "express";
import connectDb from "../db/connectDb";
import Prompt from "../models/Prompt";
import PromptVersion from "../models/PromptVersion";
import Purchase from "../models/Purchase";
import User from "../models/User";
import { publishPromptVersion } from "../services/promptVersioning";
import { requireCreatorVersionWriteSession } from "../services/creatorPrivacy";

export const PostPromptUpdate = async (req: Request, res: Response): Promise<Response> => {
  try {
    await connectDb();
    // walletAddress in the body is intentionally ignored for identity (#142).
    const { promptId, content, changeNote } = req.body;

    if (!promptId || !content) {
      return res.status(400).json({ error: "promptId and content are required." });
    }

    const session = requireCreatorVersionWriteSession(req, res, {
      promptId: String(promptId),
      content: String(content),
    });
    if (!session) return res;

    const user = await User.findOne({ walletAddress: session.address });
    if (!user) return res.status(404).json({ error: "User not found." });

    const prompt = await Prompt.findOne({ _id: promptId, owner: user._id });
    if (!prompt) {
      return res.status(403).json({ error: "Prompt not found or not owned by this wallet." });
    }

    const { versionIndex: nextVersion } = await publishPromptVersion({
      promptId: String(prompt._id),
      content,
      changeNote,
      createdBy: session.address,
    });

    return res.status(201).json({ message: "Version posted.", versionIndex: nextVersion });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
};

export const GetPromptVersions = async (req: Request, res: Response): Promise<Response> => {
  try {
    await connectDb();
    const { promptId } = req.params;
    if (!promptId) return res.status(400).json({ error: "promptId is required." });

    const versions = await PromptVersion.find({ promptId })
      .sort({ versionIndex: -1 })
      .select("-content");

    return res.json(versions);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
};

export const RecordPurchase = async (req: Request, res: Response): Promise<Response> => {
  try {
    await connectDb();
    const { promptId, buyerWallet, txHash } = req.body;

    if (!promptId || !buyerWallet) {
      return res.status(400).json({ error: "promptId and buyerWallet are required." });
    }

    const prompt = await Prompt.findById(promptId);
    if (!prompt) return res.status(404).json({ error: "Prompt not found." });

    const normalizedBuyerWallet = buyerWallet.toLowerCase();

    // Idempotent upsert keyed by the unique (promptId, buyerWallet) index:
    // concurrent confirmations for the same prompt/buyer race safely at the
    // database level instead of via a find-then-create check, so at most one
    // entitlement record can ever be created per pair.
    let purchase;
    let created = true;
    try {
      purchase = await Purchase.findOneAndUpdate(
        { promptId, buyerWallet: normalizedBuyerWallet },
        {
          $setOnInsert: {
            promptId,
            buyerWallet: normalizedBuyerWallet,
            versionIndex: prompt.currentVersionIndex ?? 1,
            txHash: txHash ?? "",
          },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );
    } catch (upsertErr) {
      // A duplicate-key error here means another concurrent request won the
      // race between our upsert attempts; fall back to reading the record
      // that request created rather than failing the request.
      if ((upsertErr as { code?: number }).code === 11000) {
        purchase = await Purchase.findOne({ promptId, buyerWallet: normalizedBuyerWallet });
      } else {
        throw upsertErr;
      }
    }

    if (!purchase) {
      return res.status(500).json({ error: "Failed to record purchase." });
    }

    // Detect whether this request actually inserted the record or found an
    // existing one, purely to keep the response message informative.
    created = purchase.createdAt.getTime() === purchase.updatedAt.getTime();

    return res
      .status(created ? 201 : 200)
      .json({
        message: created ? "Purchase recorded." : "Already purchased.",
        versionIndex: purchase.versionIndex,
      });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
};

export const GetBuyerVersion = async (req: Request, res: Response): Promise<Response> => {
  try {
    await connectDb();
    const { promptId, buyerWallet } = req.query;

    if (!promptId || !buyerWallet) {
      return res.status(400).json({ error: "promptId and buyerWallet query params are required." });
    }

    const purchase = await Purchase.findOne({
      promptId: String(promptId),
      buyerWallet: String(buyerWallet).toLowerCase(),
    });

    if (!purchase) {
      return res.status(404).json({ error: "No purchase record found." });
    }

    const version = await PromptVersion.findOne({
      promptId: String(promptId),
      versionIndex: purchase.versionIndex,
    });

    const prompt = await Prompt.findById(promptId).lean();

    return res.json({
      versionIndex: purchase.versionIndex,
      changeNote: version?.changeNote ?? "",
      content: version?.content ?? (prompt as any)?.content ?? null,
      purchasedAt: purchase.createdAt,
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
};
