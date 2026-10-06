/**
 * Production marketplace transaction adapter (#154).
 *
 * Production purchases use the repository's real wallet -> Stellar ledger ->
 * on-chain access path. Deterministic fixtures stay behind the explicit demo
 * adapter and are never a production fallback.
 */

import { browserStellarConfig } from "@/lib/stellar/browserConfig";
import { PromptHashClient } from "@/lib/stellar/promptHashClient";
import type { WalletTransactionSigner } from "@/lib/stellar/tx";
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

/**
 * Legacy facade hook retained for deterministic demo tests and old callers.
 * The actual production /sell route uses the encrypted CreatePromptForm. A
 * legacy caller may still provide a live submitter; there is no mock fallback.
 */
export async function productionListAsset(
  input: ListAssetInput,
  liveSubmit?: (input: ListAssetInput) => Promise<ListAssetResult>,
): Promise<ListAssetResult> {
  if (!liveSubmit) {
    throw new Error(
      "Live listing submission requires the encrypted CreatePromptForm / wallet contract path (#154).",
    );
  }
  return liveSubmit(input);
}

export async function productionBuyAsset(
  itemId: string,
  userAddress: string,
  signer: WalletTransactionSigner | undefined,
  onEvent?: MarketplaceTxListener,
  signal?: AbortSignal,
): Promise<BuyAssetResult> {
  if (!signer) {
    throw new Error("Wallet signer required for live marketplace purchase.");
  }

  const result = await PromptHashClient.purchasePrompt(itemId, userAddress, {
    live: {
      config: browserStellarConfig,
      signer,
    },
    signal,
    onPhase: (phase) => {
      if (phase === "signature") {
        emit(onEvent, {
          phase,
          status: "pending",
          message: "Approve the marketplace spend in your wallet...",
        });
      } else if (phase === "network") {
        emit(onEvent, {
          phase,
          status: "pending",
          message: "Submitting purchase to the Stellar network...",
        });
      } else {
        emit(onEvent, {
          phase,
          status: "pending",
          message: "Confirming ledger state and on-chain access...",
        });
      }
    },
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
      options.signer,
      options.onEvent,
      options.signal,
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
