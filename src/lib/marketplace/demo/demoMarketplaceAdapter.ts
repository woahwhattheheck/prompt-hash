/**
 * Deterministic demo/test marketplace adapter (#154).
 *
 * Callers must gate with `isDemoMarketplaceEnabled()`. Outcomes are fixed by
 * scenario key — never Math.random().
 */

import { requireDemoMarketplace } from "../demoMode";
import type {
  BuyAssetResult,
  DemoScenario,
  ListAssetInput,
  ListAssetResult,
  MarketplaceTxListener,
  PurchaseFlowOptions,
} from "../types";

const DEMO_HASHES: Record<DemoScenario, string> = {
  success: "tx_demo_success_00000001",
  user_rejected: "tx_demo_rejected_00000002",
  network_error: "tx_demo_network_00000003",
  finalization_error: "tx_demo_final_00000004",
  op_not_authorized: "tx_demo_auth_00000005",
  op_underfunded: "tx_demo_funds_00000006",
};

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function emit(
  onEvent: MarketplaceTxListener | undefined,
  event: Parameters<MarketplaceTxListener>[0],
) {
  onEvent?.(event);
}

export async function demoListAsset(
  _input: ListAssetInput,
  scenario: DemoScenario = "success",
): Promise<ListAssetResult> {
  requireDemoMarketplace("demoListAsset");
  await delay(50);
  if (scenario === "op_not_authorized") throw new Error("op_not_authorized");
  if (scenario === "network_error") throw new Error("network_error");
  return { success: true, txHash: DEMO_HASHES[scenario] };
}

export async function demoBuyAsset(
  itemId: string,
  _userAddress: string,
  scenario: DemoScenario = "success",
): Promise<BuyAssetResult> {
  requireDemoMarketplace("demoBuyAsset");
  void itemId;
  await delay(50);
  if (scenario === "op_underfunded") throw new Error("op_underfunded");
  if (scenario === "network_error") throw new Error("network_error");
  if (scenario === "user_rejected") throw new Error("user_rejected");
  return { success: true, txHash: DEMO_HASHES[scenario] };
}

export async function demoRunPurchaseFlow(
  options: PurchaseFlowOptions,
): Promise<BuyAssetResult> {
  requireDemoMarketplace("demoRunPurchaseFlow");
  const scenario = options.scenario ?? "success";
  const { onEvent, signal } = options;

  emit(onEvent, {
    phase: "signature",
    status: "pending",
    message: "Awaiting wallet signature...",
  });
  await delay(40, signal);

  if (scenario === "user_rejected") {
    emit(onEvent, {
      phase: "error",
      status: "error",
      message: "Transaction Failed: User rejected signature.",
    });
    throw new Error("user_rejected");
  }

  emit(onEvent, {
    phase: "network",
    status: "pending",
    message: "Broadcasting transaction to network...",
  });
  await delay(40, signal);

  if (scenario === "network_error" || scenario === "op_underfunded") {
    const message =
      scenario === "op_underfunded"
        ? "Transaction Failed: op_underfunded."
        : "Transaction Failed: network error or timeout.";
    emit(onEvent, { phase: "error", status: "error", message });
    throw new Error(scenario);
  }

  emit(onEvent, {
    phase: "confirming",
    status: "pending",
    message: "Confirming transaction and granting access...",
  });
  await delay(40, signal);

  if (scenario === "finalization_error" || scenario === "op_not_authorized") {
    emit(onEvent, {
      phase: "error",
      status: "error",
      message: "Transaction Failed: finalization error.",
    });
    throw new Error(scenario);
  }

  const txHash = DEMO_HASHES.success;
  emit(onEvent, {
    phase: "success",
    status: "success",
    message: "Access Granted! Your prompt is now unlocked.",
    txHash,
  });
  return { success: true, txHash };
}

export function demoTxHashFor(scenario: DemoScenario): string {
  return DEMO_HASHES[scenario];
}
