/**
 * Production marketplace transaction adapter (#154).
 *
 * Drives UI from wallet submission → ledger confirmation → fulfillment.
 * Does not invent stochastic outcomes or synthetic random hashes.
 * Does not replace the Stellar client library — delegates to PromptHashClient
 * and only accepts hashes returned by that authoritative path.
 */

import { PromptHashClient } from "@/lib/stellar/promptHashClient";
import type {
  BuyAssetResult,
  ListAssetInput,
  ListAssetResult,
  MarketplaceTxListener,
  PurchaseFlowOptions,
} from "./types";

function emit(
  onEvent: MarketplaceTxListener | undefined,
  event: Parameters<MarketplaceTxListener>[0],
) {
  onEvent?.(event);
}

function assertAuthoritativeHash(
  txHash: string | undefined,
  context: string,
): string {
  if (!txHash || typeof txHash !== "string" || txHash.trim().length === 0) {
    throw new Error(
      `[release-safety] ${context} did not return an authoritative transaction hash.`,
    );
  }
  return txHash;
}

export async function productionListAsset(
  _input: ListAssetInput,
): Promise<ListAssetResult> {
  throw new Error(
    "Listing requires a connected wallet and the live PromptHashClient createPrompt path. Stochastic mock listing is disabled in production (#154).",
  );
}

export async function productionBuyAsset(
  itemId: string,
  userAddress: string,
  onEvent?: MarketplaceTxListener,
): Promise<BuyAssetResult> {
  emit(onEvent, {
    phase: "signature",
    status: "pending",
    message: "Awaiting wallet signature...",
  });

  emit(onEvent, {
    phase: "network",
    status: "pending",
    message: "Broadcasting transaction to network...",
  });

  const result = await PromptHashClient.purchasePrompt(itemId, userAddress);

  emit(onEvent, {
    phase: "confirming",
    status: "pending",
    message: "Confirming transaction and granting access...",
  });

  const txHash = assertAuthoritativeHash(result.txHash, "purchasePrompt");

  emit(onEvent, {
    phase: "success",
    status: "success",
    message: "Access Granted! Your prompt is now unlocked.",
    txHash,
  });

  return { success: true, txHash };
}

export async function productionRunPurchaseFlow(
  options: PurchaseFlowOptions,
): Promise<BuyAssetResult> {
  try {
    return await productionBuyAsset(
      options.itemId,
      options.userAddress,
      options.onEvent,
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Transaction failed.";
    emit(options.onEvent, {
      phase: "error",
      status: "error",
      message: message.startsWith("Transaction Failed")
        ? message
        : `Transaction Failed: ${message}`,
    });
    throw err;
  }
}
