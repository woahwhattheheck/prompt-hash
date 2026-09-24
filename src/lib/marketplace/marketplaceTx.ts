/**
 * Marketplace transaction facade (#154).
 *
 * Production paths never use stochastic mocks. Demo adapters are opt-in and
 * deterministic.
 */

import {
  assertDemoMarketplaceSafe,
  isDemoMarketplaceEnabled,
  isProductionBuild,
  requireDemoMarketplace,
} from "./demoMode";
import {
  productionListAsset,
  productionBuyAsset,
  productionRunPurchaseFlow,
} from "./productionMarketplaceAdapter";
import type {
  BuyAssetResult,
  DemoScenario,
  ListAssetInput,
  ListAssetResult,
  MarketplaceTxListener,
  PurchaseFlowOptions,
} from "./types";

export type {
  BuyAssetResult,
  DemoScenario,
  ListAssetInput,
  ListAssetResult,
  MarketplaceTxEvent,
  MarketplaceTxListener,
  MarketplaceTxPhase,
  MarketplaceTxStatus,
  PurchaseFlowOptions,
} from "./types";

export {
  assertDemoMarketplaceSafe,
  isDemoMarketplaceEnabled,
  isProductionBuild,
  requireDemoMarketplace,
};

async function loadDemo() {
  return import("./demo/demoMarketplaceAdapter");
}

export async function listAsset(
  input: ListAssetInput,
  options?: { scenario?: DemoScenario },
): Promise<ListAssetResult> {
  if (isDemoMarketplaceEnabled()) {
    const demo = await loadDemo();
    return demo.demoListAsset(input, options?.scenario ?? "success");
  }
  if (isProductionBuild()) {
    return productionListAsset(input);
  }
  throw new Error(
    "Listing mocks are disabled. Enable demo mode (?demo=1) for deterministic fixtures, or use the live listing path (#154).",
  );
}

export async function buyAsset(
  itemId: string,
  userAddress: string,
  options?: { scenario?: DemoScenario; onEvent?: MarketplaceTxListener },
): Promise<BuyAssetResult> {
  if (isDemoMarketplaceEnabled()) {
    const demo = await loadDemo();
    return demo.demoBuyAsset(
      itemId,
      userAddress,
      options?.scenario ?? "success",
    );
  }
  return productionBuyAsset(itemId, userAddress, options?.onEvent);
}

export async function runPurchaseFlow(
  options: PurchaseFlowOptions,
): Promise<BuyAssetResult> {
  if (isDemoMarketplaceEnabled()) {
    const demo = await loadDemo();
    return demo.demoRunPurchaseFlow(options);
  }
  return productionRunPurchaseFlow(options);
}
