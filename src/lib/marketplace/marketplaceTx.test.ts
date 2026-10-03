import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

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

  it("keeps legacy client purchases deterministic in demo mode", async () => {
    const { PromptHashClient: legacyClient } = await vi.importActual<
      typeof import("@/lib/stellar/promptHashClient")
    >("@/lib/stellar/promptHashClient");

    await expect(legacyClient.purchasePrompt("item-1", "GBUYER", { delay: 0 }))
      .resolves.toEqual({ success: true, txHash: demoTxHashFor("success") });
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

describe("production marketplace bundle", () => {
  it("excludes the demo adapter and passes the bundle guard", () => {
    // A fresh build process uses actual source imports, independently of the
    // mocked client above. Only the external Stellar SDK boundary is omitted.
    const script = `
      import { build } from "vite";
      const root = process.cwd();
      const result = await build({
        root, configFile: false, logLevel: "silent", mode: "production",
        envPrefix: "PUBLIC_",
        resolve: { alias: { "@": root + "/src" } },
        build: {
          target: "esnext", write: false, minify: true,
          lib: {
            entry: root + "/src/lib/marketplace/marketplaceTx.ts",
            formats: ["es"], fileName: "marketplace"
          },
          rollupOptions: { external: [/^@stellar\\/stellar-sdk/] }
        }
      });
      const chunks = (Array.isArray(result) ? result : [result])
        .flatMap(result => result.output)
        .filter(output => output.type === "chunk")
        .map(chunk => ({
          fileName: chunk.fileName, code: chunk.code,
          modules: Object.keys(chunk.modules)
        }));
      console.log(JSON.stringify(chunks));
    `;
    const chunks = JSON.parse(execFileSync(process.execPath, [
      "--input-type=module", "-e", script,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: "production" },
      encoding: "utf8",
    })) as Array<{ fileName: string; code: string; modules: string[] }>;
    const bundleDir = mkdtempSync(join(tmpdir(), "marketplace-production-"));

    try {
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect(chunk.code).not.toContain("tx_demo_");
        expect(chunk.modules.some(path =>
          path.endsWith("/marketplace/demo/demoMarketplaceAdapter.ts"),
        )).toBe(false);
        writeFileSync(join(bundleDir, chunk.fileName), chunk.code);
      }
      const guarded = spawnSync(process.execPath, [
        "scripts/guard-no-stochastic-marketplace.mjs", "--bundle",
        relative(process.cwd(), bundleDir),
      ], { encoding: "utf8" });
      expect(guarded.status).toBe(0);
    } finally {
      rmSync(bundleDir, { recursive: true, force: true });
    }
  });

  it("rejects a bundled deterministic demo transaction fixture", () => {
    const bundleDir = mkdtempSync(join(tmpdir(), "marketplace-demo-fixture-"));
    try {
      writeFileSync(join(bundleDir, "entry.js"),
        `export const transaction = ${JSON.stringify(demoTxHashFor("success"))};`,
      );
      const guarded = spawnSync(process.execPath, [
        "scripts/guard-no-stochastic-marketplace.mjs", "--bundle",
        relative(process.cwd(), bundleDir),
      ], { encoding: "utf8" });
      expect(guarded.status).toBe(1);
      expect(guarded.stdout).toContain("demo marketplace fixture");
    } finally {
      rmSync(bundleDir, { recursive: true, force: true });
    }
  });
});
