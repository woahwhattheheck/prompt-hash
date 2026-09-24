import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/stellar/promptHashClient", () => ({
  PromptHashClient: {
    purchasePrompt: vi.fn(),
  },
}));

import { PromptHashClient } from "@/lib/stellar/promptHashClient";
import { isDemoMarketplaceEnabled } from "./demoMode";
import { buyAsset, listAsset, runPurchaseFlow } from "./marketplaceTx";
import { demoTxHashFor } from "./demo/demoMarketplaceAdapter";

describe("marketplace tx release safety (#154)", () => {
  beforeEach(() => {
    vi.mocked(PromptHashClient.purchasePrompt).mockReset();
  });

  it("enables demo mode under vitest", () => {
    expect(isDemoMarketplaceEnabled()).toBe(true);
  });

  it("lists deterministically in demo mode (success)", async () => {
    const result = await listAsset(
      { name: "A", price: "1", description: "d" },
      { scenario: "success" },
    );
    expect(result.txHash).toBe(demoTxHashFor("success"));
  });

  it("lists deterministically in demo mode (auth failure)", async () => {
    await expect(
      listAsset(
        { name: "A", price: "1", description: "d" },
        { scenario: "op_not_authorized" },
      ),
    ).rejects.toThrow("op_not_authorized");
  });

  it("buys deterministically in demo mode (underfunded)", async () => {
    await expect(
      buyAsset("item-1", "GBUYER", { scenario: "op_underfunded" }),
    ).rejects.toThrow("op_underfunded");
  });

  it("runs purchase flow success and emits authoritative phases", async () => {
    const events: string[] = [];
    const result = await runPurchaseFlow({
      itemId: "item-1",
      userAddress: "GBUYER",
      scenario: "success",
      onEvent: (e) => events.push(e.phase),
    });
    expect(result.txHash).toBe(demoTxHashFor("success"));
    expect(events).toEqual(["signature", "network", "confirming", "success"]);
  });

  it("runs purchase flow failure and does not emit success", async () => {
    const events: string[] = [];
    await expect(
      runPurchaseFlow({
        itemId: "item-1",
        userAddress: "GBUYER",
        scenario: "user_rejected",
        onEvent: (e) => events.push(e.phase),
      }),
    ).rejects.toThrow("user_rejected");
    expect(events).toContain("error");
    expect(events).not.toContain("success");
  });

  it("reload-safe: repeated success flows return the same demo hash", async () => {
    const first = await runPurchaseFlow({
      itemId: "item-1",
      userAddress: "GBUYER",
      scenario: "success",
    });
    const second = await runPurchaseFlow({
      itemId: "item-1",
      userAddress: "GBUYER",
      scenario: "success",
    });
    expect(first.txHash).toBe(second.txHash);
    expect(first.txHash).toBe(demoTxHashFor("success"));
  });
});
