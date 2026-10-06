/**
 * WARNING: MOCK CONTRACT IMPLEMENTATION
 * This file currently stubs all on-chain reads/writes with mock data.
 * This should NOT reach production.
 * TODO: Restore real Soroban contract integration before release.
 */
import { Address, xdr } from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";
import { isDemoMarketplaceEnabled } from "@/lib/marketplace/demoMode";
import { approveNativeAssetSpend } from "./nativeAssetClient";
import {
  getRpcServer,
  prepareContractCall,
  readSimulationResult,
  scValArg,
  simulateContractCall,
  submitPreparedTransaction,
  type WalletTransactionSigner,
} from "./tx";

let hasWarnedMock = false;
const warnMockUse = () => {
  if (hasWarnedMock) return;
  console.warn(
    "⚠️ USING MOCK PromptHashClient: Contract calls are currently stubbed and will not hit the Stellar network.",
  );
  hasWarnedMock = true;
};

export interface PromptHashConfig {
  rpcUrl: string;
  networkPassphrase: string;
  allowHttp?: boolean;
  promptHashContractId: string;
  nativeAssetContractId: string;
  simulationAccount?: string;
}

// Added the missing interface required by the UI
export interface PromptRecord {
  id: bigint;
  creator: string;
  priceStroops: bigint;
  title: string;
  category: string;
  previewText: string;
  description?: string;
  tags?: string[];
  imageUrl: string;
  salesCount: number;
  active: boolean;
  contentHash: string;
  encryptedPrompt?: string;
  encryptionIv?: string;
  wrappedKey?: string;
}

export interface RevenueSplitInput {
  recipient: string;
  bps: number;
}

export interface CreatePromptInput {
  imageUrl: string;
  title: string;
  category: string;
  previewText: string;
  encryptedPrompt: string;
  encryptionIv: string;
  wrappedKey: string;
  contentHash: string;
  priceStroops: bigint;
  splits?: RevenueSplitInput[];
}

export class PromptHashClient {
  /**
   * Checks if the user already has access to the prompt.
   */
  static async checkAccess(
    _config: PromptHashConfig | string,
    _address: string,
    _itemId?: string | bigint,
  ): Promise<boolean> {
    warnMockUse();
    return new Promise((resolve) => {
      setTimeout(() => resolve(false), 1000);
    });
  }

  static async getPrompt(
    _config: PromptHashConfig,
    promptId: bigint,
  ): Promise<PromptRecord> {
    warnMockUse();
    const prompts = await PromptHashClient.getAllPrompts(_config);
    const match = prompts.find((p) => p.id === promptId);
    if (!match) {
      throw new Error(`Prompt #${promptId.toString()} not found.`);
    }
    return match;
  }

  /**
   * Invokes the Soroban contract to purchase a prompt.
   */
  static async purchasePrompt(
    itemId: string,
    userAddress: string,
    options?: {
      forceFailure?: string;
      delay?: number;
      live?: {
        config: PromptHashConfig;
        signer: WalletTransactionSigner;
      };
      signal?: AbortSignal;
      onPhase?: (phase: "signature" | "network" | "confirming") => void;
    },
  ): Promise<{ txHash: string; success: boolean }> {
    if (!options?.live) {
      warnMockUse();

      if (import.meta.env.PROD) {
        throw new Error(
          "[release-safety] Live marketplace purchase requires a connected wallet signer (#154).",
        );
      }

      if (!isDemoMarketplaceEnabled()) {
        throw new Error(
          "[release-safety] Mock purchase requires opt-in demo marketplace mode (?demo=1, ?e2e=1, or VITE_ENABLE_DEMO_MARKETPLACE=1). Stochastic / synthetic hashes are disabled (#154).",
        );
      }

      const { demoTxHashFor } = await import(
        "@/lib/marketplace/demo/demoMarketplaceAdapter"
      );

      return new Promise((resolve, reject) => {
        const delay = options?.delay ?? 2000;
        setTimeout(() => {
          if (options?.forceFailure) {
            return reject(new Error(options.forceFailure));
          }

          void itemId;
          void userAddress;
          resolve({ txHash: demoTxHashFor("success"), success: true });
        }, delay);
      });
    }

    const { config, signer } = options.live;
    const signal = options.signal;
    const assertNotAborted = () => {
      if (signal?.aborted) {
        const error = new Error("Purchase aborted.");
        error.name = "AbortError";
        throw error;
      }
    };

    const promptId = BigInt(itemId);
    assertNotAborted();

    const promptRead = await simulateContractCall(
      config,
      userAddress,
      config.promptHashContractId,
      "get_prompt",
      [scValArg(promptId, "u64")],
    );
    const prompt = readSimulationResult(promptRead.simulation) as {
      price_stroops?: bigint;
      asset?: unknown;
    };
    const paymentAmountStroops = prompt?.price_stroops;
    if (typeof paymentAmountStroops !== "bigint" || paymentAmountStroops <= 0n) {
      throw new Error("[release-safety] Live prompt price is unavailable.");
    }

    const paymentAsset =
      typeof prompt.asset === "string"
        ? prompt.asset
        : prompt.asset instanceof Address
          ? prompt.asset.toString()
          : String(prompt.asset ?? "");
    if (paymentAsset !== config.nativeAssetContractId) {
      throw new Error(
        "[release-safety] Marketplace purchase asset does not match the configured native asset contract.",
      );
    }

    const latestLedger = await getRpcServer(config).getLatestLedger();
    assertNotAborted();
    options.onPhase?.("signature");

    await approveNativeAssetSpend(
      config,
      signer,
      userAddress,
      config.promptHashContractId,
      paymentAmountStroops,
      latestLedger.sequence + 120,
    );

    assertNotAborted();
    options.onPhase?.("network");

    const prepared = await prepareContractCall(
      config,
      userAddress,
      config.promptHashContractId,
      "buy_prompt",
      [
        scValArg(userAddress, "address"),
        scValArg(promptId, "u64"),
        xdr.ScVal.scvVoid(),
        scValArg(paymentAmountStroops, "i128"),
        xdr.ScVal.scvVoid(),
      ],
    );
    const submitted = await submitPreparedTransaction(
      config,
      prepared,
      signer,
      userAddress,
    );

    assertNotAborted();
    options.onPhase?.("confirming");

    const accessRead = await simulateContractCall(
      config,
      userAddress,
      config.promptHashContractId,
      "has_access",
      [scValArg(userAddress, "address"), scValArg(promptId, "u64")],
    );
    if (readSimulationResult(accessRead.simulation) !== true) {
      throw new Error(
        "[release-safety] Purchase reached the ledger but access is not yet authoritative.",
      );
    }

    const txHash =
      (submitted as { txHash?: string }).txHash ??
      prepared.preparedTransaction.hash().toString("hex");

    return { txHash, success: true };
  }

  static async getAllPrompts(
    _config: PromptHashConfig,
  ): Promise<PromptRecord[]> {
    warnMockUse();
    // Returning mock data so the Browse page isn't empty
    return [
      {
        id: 1n,
        creator: "GD...1234",
        priceStroops: 50000000n, // 5 XLM
        title: "GPT-4 Technical Architect",
        category: "Development",
        previewText:
          "A high-performance prompt for generating system design documents...",
        description:
          "A full prompt designed to help architects craft scalable system blueprints and integration plans.",
        tags: ["AI", "Architecture"],
        imageUrl: "",
        salesCount: 12,
        active: true,
        contentHash: "mock_hash_000000000001",
      },
      {
        id: 2n,
        creator: "GB...5678",
        priceStroops: 120000000n, // 12 XLM
        title: "Creative Storyteller Pro",
        category: "Creative",
        previewText:
          "Unlock deep narrative structures and character development...",
        description:
          "A storytelling prompt built to help craft plot outlines, characters, and emotional arcs for long-form fiction.",
        tags: ["Storytelling", "Creative"],
        imageUrl: "",
        salesCount: 45,
        active: true,
        contentHash: "mock_hash_000000000002",
      },
    ];
  }

  static async getPromptsByBuyer(
    _config: PromptHashConfig,
    _address: string,
  ): Promise<PromptRecord[]> {
    warnMockUse();
    return [];
  }

  static async getPromptsByCreator(
    _config: PromptHashConfig,
    _address: string,
  ): Promise<PromptRecord[]> {
    warnMockUse();
    return [];
  }

  static async createPrompt(
    config: PromptHashConfig,
    walletSignerLike: WalletTransactionSigner,
    address: string,
    data: CreatePromptInput,
  ): Promise<{ success: true; txHash: string; promptId: bigint }> {
    if (!/^[0-9a-fA-F]{64}$/.test(data.contentHash)) {
      throw new Error("Prompt content hash must be a 32-byte SHA-256 hex value.");
    }

    const contentHash = Uint8Array.from(
      data.contentHash.match(/../g)!.map((byte) => Number.parseInt(byte, 16)),
    );
    const listing = {
      price: data.priceStroops,
      asset: new Address(config.nativeAssetContractId),
      max_supply: 0n,
      expires_at: 0n,
      splits: (data.splits ?? []).map((split) => ({
        recipient: new Address(split.recipient),
        bps: split.bps,
      })),
      tags: [] as string[],
    };

    const prepared = await prepareContractCall(
      config,
      address,
      config.promptHashContractId,
      "create_prompt",
      [
        scValArg(address, "address"),
        scValArg(data.imageUrl, "string"),
        scValArg(data.title, "string"),
        scValArg(data.category, "string"),
        scValArg(data.previewText, "string"),
        scValArg(data.encryptedPrompt, "string"),
        scValArg(data.encryptionIv, "string"),
        scValArg(data.wrappedKey, "string"),
        scValArg(contentHash),
        scValArg(listing),
      ],
    );

    const promptIdValue = readSimulationResult(prepared.simulation);
    if (promptIdValue === undefined || promptIdValue === null) {
      throw new Error("create_prompt simulation did not return a prompt id.");
    }

    const submitted = await submitPreparedTransaction(
      config,
      prepared,
      walletSignerLike,
      address,
    );
    const promptId =
      typeof promptIdValue === "bigint"
        ? promptIdValue
        : BigInt(String(promptIdValue));
    const txHash =
      (submitted as { txHash?: string }).txHash ??
      prepared.preparedTransaction.hash().toString("hex");

    return { success: true, txHash, promptId };
  }

  static async setPromptSaleStatus(
    _config: PromptHashConfig,
    _walletSignerLike: any,
    _address: string,
    _promptId: string,
    _isForSale: boolean,
  ) {
    warnMockUse();
    return { success: true };
  }

  static async updatePromptPrice(
    _config: PromptHashConfig,
    _walletSignerLike: any,
    _address: string,
    _promptId: string,
    _newPrice: string,
  ) {
    warnMockUse();
    return { success: true };
  }

  static async getRecentPurchases(
    config: PromptHashConfig,
    limit: number = 10
  ) {
    try {
      const server = new Server(config.rpcUrl, {
        allowHttp: config.allowHttp,
      });

      // Get current ledger to limit our search
      const latestLedgerResponse = await server.getLatestLedger();
      const latestLedger = latestLedgerResponse.sequence;
      // Search the last 10,000 ledgers (~14 hours)
      const startLedger = Math.max(1, latestLedger - 10000);

      const events = await server.getEvents({
        startLedger,
        filters: [
          {
            type: "contract",
            contractIds: [config.promptHashContractId],
            // Topics could be strictly typed to the PromptPurchased event topic if known
          }
        ],
        limit,
      });

      // Here we would normally parse `events.events` and decode the XDR.
      // Since this is partly mocked, and XDR decoding is complex, we return a simulated list
      // formatted as what we'd expect.
      return events.events.map((e, i) => ({
        id: e.id || `rpc-event-${i}`,
        type: "sale",
        title: `Prompt #${e.topic?.[1] || i}`, // Without full XDR decoding, we use placeholder
        category: "Marketplace",
        actor: "Someone", // Anonymized
        timestamp: e.ledgerClosedAt,
        priceXlm: undefined, 
      }));
    } catch (e) {
      console.error("Failed to fetch events from Soroban RPC:", e);
      // Fallback for mocked environment
      return [];
    }
  }
}

// --- Standalone exports to satisfy existing UI component imports ---
export const hasAccess = async (
  config: PromptHashConfig,
  address: string,
  itemId: string | bigint,
) =>
  PromptHashClient.checkAccess(
    config,
    address,
    typeof itemId === "bigint" ? itemId.toString() : itemId,
  );
export const getPrompt = async (config: PromptHashConfig, promptId: bigint) =>
  PromptHashClient.getPrompt(config, promptId);
export const getAllPrompts = async (config: PromptHashConfig) =>
  PromptHashClient.getAllPrompts(config);
export const getPromptsByBuyer = async (
  config: PromptHashConfig,
  address: string,
) => PromptHashClient.getPromptsByBuyer(config, address);
export const getPromptsByCreator = async (
  config: PromptHashConfig,
  address: string,
) => PromptHashClient.getPromptsByCreator(config, address);
export const createPrompt = async (
  config: PromptHashConfig,
  walletSignerLike: any,
  address: string,
  data: CreatePromptInput,
) => PromptHashClient.createPrompt(config, walletSignerLike, address, data);
export const setPromptSaleStatus = async (
  config: PromptHashConfig,
  walletSignerLike: any,
  address: string,
  promptId: string,
  isForSale: boolean,
) =>
  PromptHashClient.setPromptSaleStatus(
    config,
    walletSignerLike,
    address,
    promptId,
    isForSale,
  );
export const updatePromptPrice = async (
  config: PromptHashConfig,
  walletSignerLike: any,
  address: string,
  promptId: string,
  newPrice: string,
) =>
  PromptHashClient.updatePromptPrice(
    config,
    walletSignerLike,
    address,
    promptId,
    newPrice,
  );

export const getRecentPurchases = async (
  config: PromptHashConfig,
  limit?: number
) => PromptHashClient.getRecentPurchases(config, limit);

