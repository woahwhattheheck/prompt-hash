/** Authoritative purchase / listing phases driven by wallet → ledger → fulfillment. */
export type MarketplaceTxPhase =
  | "idle"
  | "signature"
  | "network"
  | "confirming"
  | "success"
  | "error";

export type MarketplaceTxStatus = "idle" | "pending" | "success" | "error";

export interface MarketplaceTxEvent {
  phase: MarketplaceTxPhase;
  status: MarketplaceTxStatus;
  message: string;
  /** Present only after an authoritative ledger / adapter result — never synthesized randomly. */
  txHash?: string;
}

export type MarketplaceTxListener = (event: MarketplaceTxEvent) => void;

export type DemoScenario =
  | "success"
  | "user_rejected"
  | "network_error"
  | "finalization_error"
  | "op_not_authorized"
  | "op_underfunded";

export interface ListAssetInput {
  name: string;
  price: string;
  description: string;
}

export interface ListAssetResult {
  success: true;
  txHash: string;
}

export interface BuyAssetResult {
  success: true;
  txHash: string;
}

export interface PurchaseFlowOptions {
  itemId: string;
  userAddress: string;
  onEvent?: MarketplaceTxListener;
  /** Demo-only scenario key. Ignored in production adapter. */
  scenario?: DemoScenario;
  signal?: AbortSignal;
}
