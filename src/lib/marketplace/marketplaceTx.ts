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
  // Keep the import behind a compile-time branch so production bundles omit it.
  if (import.meta.env.PROD) {
    throw new Error(
      "[release-safety] Demo marketplace adapters are excluded from production builds (#154).",
    );
  }
  return import("./demo/demoMarketplaceAdapter");
}

export async function listAsset(
  input: ListAssetInput,
  options?: {
    scenario?: DemoScenario;
    liveSubmit?: (input: ListAssetInput) => Promise<ListAssetResult>;
  },
): Promise<ListAssetResult> {
  if (isDemoMarketplaceEnabled()) {
    const demo = await loadDemo();
    return demo.demoListAsset(input, options?.scenario ?? "success");
  }
  return productionListAsset(input, options?.liveSubmit);
}

export async function buyAsset(
  itemId: string,
  userAddress: string,
  options?: {
    scenario?: DemoScenario;
    onEvent?: MarketplaceTxListener;
    signer?: PurchaseFlowOptions["signer"];
    signal?: AbortSignal;
  },
): Promise<BuyAssetResult> {
  if (isDemoMarketplaceEnabled()) {
    const demo = await loadDemo();
    return demo.demoBuyAsset(
      itemId,
      userAddress,
      options?.scenario ?? "success",
    );
  }
  return productionBuyAsset(
    itemId,
    userAddress,
    options?.signer,
    options?.onEvent,
    options?.signal,
  );
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
