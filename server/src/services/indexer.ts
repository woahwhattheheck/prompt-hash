import { scValToNative } from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";
import Prompt from "../models/Prompt";
import User from "../models/User";
import Purchase from "../models/Purchase";
import { IndexerState } from "../models/IndexerState";
import { enqueueSimilarityScan, startSimilarityWorker } from "./similarityJobQueue";
import { indexPromptProjection } from "./promptSearchIndex";
import { stellarConfig } from "../config/stellar";
import { cacheDel, cacheDelPattern, CACHE_KEYS } from "./cacheService";
import { ingestSellerNotificationEvent } from "./sellerNotificationIngest";

const CONTRACT_ID = stellarConfig.PUBLIC_PROMPT_HASH_CONTRACT_ID;
const rpc = new Server(stellarConfig.PUBLIC_STELLAR_RPC_URL);

/**
 * Main entry point to start the background indexing process.
 */
export async function startIndexer() {
  const state = await IndexerState.findOneAndUpdate(
    { key: "prompt_hash_contract" },
    { $setOnInsert: { lastIndexedLedger: 0 } },
    { upsert: true, new: true },
  );

  // Start the similarity scan worker (processes queued jobs)
  // Non-blocking, runs on 5-second intervals
  startSimilarityWorker(5000);

  // Poll for new blockchain events every 5 seconds
  setInterval(async () => {
    try {
      const latestLedger = await rpc.getLatestLedger();
      const startLedger = (state.lastIndexedLedger || 0) + 1;

      // Only fetch if there are new ledgers to process
      if (startLedger > latestLedger.sequence) return;

      const response = await rpc.getEvents({
        startLedger,
        filters: [
          {
            type: "contract",
            contractIds: [CONTRACT_ID],
          },
        ],
      });

      for (const event of response.events) {
        await processEvent(event);
      }

      // Update the cursor to the last processed ledger
      state.lastIndexedLedger = latestLedger.sequence;
      await state.save();
    } catch (err) {
      console.error("Indexer Error:", err);
    }
  }, 5000);
}

/**
 * Decodes and routes Soroban events to the appropriate database action.
 */
async function processEvent(event: any) {
  // Decode the topic and value from XDR to Native JS types
  const topic = scValToNative(event.topic[0]);
  const data = scValToNative(event.value);

  console.log(`Processing Event: ${topic}`, data);

  switch (topic) {
    case "PromptCreated": {
      const { prompt_id, creator, price_stroops } = data;

      // Ensure the creator exists in our User collection
      let user = await User.findOne({ walletAddress: creator.toLowerCase() });
      if (!user) {
        user = await User.create({
          walletAddress: creator.toLowerCase(),
          username: `user_${creator.slice(0, 6)}`,
          rating: 4,
        });
      }

      // handles discovery of prompts created off-platform
      const upserted = await Prompt.findOneAndUpdate(
        { onChainId: prompt_id.toString() },
        {
          $set: {
            onChainId: prompt_id.toString(),
            owner: user._id,
            price: Number(price_stroops) / 10_000_000,
            isActive: true,
          },
        },
        { upsert: true, new: true },
      );

      await indexPromptProjection(upserted, creator, Number(event.ledger || 0));

      // Enqueue similarity scan job (non-blocking, processed by worker)
      // New prompts without fingerprints will have them generated on first scan
      if (upserted?.content) {
        enqueueSimilarityScan(prompt_id.toString()).catch((err) =>
          console.error(
            "[similarity-queue] Failed to enqueue scan for prompt",
            prompt_id.toString(),
            err,
          ),
        );
      }
      break;
    }

    case "PromptPurchased": {
      const { prompt_id, buyer, tx_hash, version_index } = data;
      await Prompt.findOneAndUpdate(
        { onChainId: prompt_id.toString() },
        { $inc: { salesCount: 1 } },
      );
      if (buyer) {
        await Purchase.findOneAndUpdate(
          { promptId: prompt_id.toString(), buyerWallet: String(buyer).toLowerCase() },
          {
            $set: {
              promptId: prompt_id.toString(),
              buyerWallet: String(buyer).toLowerCase(),
              versionIndex: version_index ?? 1,
              txHash: tx_hash ?? event.txHash ?? "",
            },
          },
          { upsert: true }
        );
      }
      break;
    }

    case "PromptPriceUpdated": {
      const { prompt_id, price_stroops } = data;
      await Prompt.findOneAndUpdate(
        { onChainId: prompt_id.toString() },
        { $set: { price: Number(price_stroops) / 10_000_000 } },
      );
      break;
    }

    case "PromptSaleStatusUpdated": {
      const { prompt_id, active } = data;
      await Prompt.findOneAndUpdate(
        { onChainId: prompt_id.toString() },
        { $set: { isActive: active } },
      );
      const indexed = await Prompt.findOne({ onChainId: prompt_id.toString() }).populate("owner").lean();
      if (indexed) await indexPromptProjection(indexed, indexed.owner?.walletAddress || "unknown", Number(event.ledger || 0));
      break;
    }

    default:
      console.log(`Unhandled event topic: ${topic}`);
      break;
  }

  // Drive in-app seller alerts from indexed events (#181). Best-effort;
  // failures must not block projection. Email delivery is unchanged.
  try {
    if (["PromptPurchased", "PromptPriceUpdated", "PromptSaleStatusUpdated"].includes(String(topic))) {
      let wallet = data?.creator
        ? String(data.creator)
        : data?.seller
          ? String(data.seller)
          : "";
      if (!wallet) {
        const prompt = await Prompt.findOne({ onChainId: data?.prompt_id?.toString() }).populate("owner");
        wallet = (prompt as { owner?: { walletAddress?: string } })?.owner?.walletAddress || "";
      }
      if (wallet) {
        await ingestSellerNotificationEvent({
          ledger: Number(event.ledger || 0),
          transaction: String(event.txHash || event.transaction || `ledger-${event.ledger}`),
          eventIndex: Number(event.eventIndex ?? 0),
          topic: String(topic),
          wallet,
          promptId: data?.prompt_id?.toString?.() ?? String(data?.prompt_id ?? ""),
          buyer: data?.buyer ? String(data.buyer) : undefined,
          active: typeof data?.active === "boolean" ? data.active : undefined,
          priceStroops: data?.price_stroops,
        });
      }
    }
  } catch (err) {
    console.error("[seller-notifications] ingest failed", err);
  }

  // Invalidate caches if this event updated a prompt
  if (["PromptCreated", "PromptPurchased", "PromptPriceUpdated", "PromptSaleStatusUpdated"].includes(topic)) {
    const promptIdStr = data.prompt_id?.toString();
    if (promptIdStr) {
      await cacheDel(CACHE_KEYS.promptDetail(promptIdStr));
      await cacheDelPattern("prompts:list:*");
      await cacheDelPattern("prompts:search:*");
    }
  }
}
