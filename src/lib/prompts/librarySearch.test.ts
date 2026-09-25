import { beforeEach, describe, expect, it } from "vitest";
import {
  addUnlockHistoryEntry,
  clearUnlockHistory,
  filterLibraryPrompts,
  getUnlockHistory,
} from "./librarySearch";
import type { PromptRecord } from "../stellar/promptHashClient";

const mockPrompts: PromptRecord[] = [
  {
    id: 1n,
    creator: "GCREATOR1",
    title: "React TypeScript System Prompt",
    description: "Full stack prompt",
    previewText: "Create full stack react app with clean architecture",
    category: "Development",
    priceStroops: 10000000n,
    imageUrl: "",
    salesCount: 0,
    active: true,
    contentHash: "hash1",
    encryptedPrompt: "enc1",
    encryptionIv: "iv1",
    wrappedKey: "key1",
  },
  {
    id: 2n,
    creator: "GCREATOR2",
    title: "Soroban Smart Contract Generator",
    description: "Rust smart contracts",
    previewText: "Write secure Soroban smart contracts in Rust",
    category: "Blockchain",
    priceStroops: 50000000n,
    imageUrl: "",
    salesCount: 0,
    active: true,
    contentHash: "hash2",
    encryptedPrompt: "enc2",
    encryptionIv: "iv2",
    wrappedKey: "key2",
  },
  {
    id: 3n,
    creator: "GCREATOR1",
    title: "AI Storytelling Prompt",
    description: "Creative writing",
    previewText: "Generate engaging fictional narratives and worldbuilding",
    category: "Creative",
    priceStroops: 20000000n,
    imageUrl: "",
    salesCount: 0,
    active: true,
    contentHash: "hash3",
    encryptedPrompt: "enc3",
    encryptionIv: "iv3",
    wrappedKey: "key3",
  },
];

describe("librarySearch utilities (#35)", () => {
  it("filters prompts by search query across title, category, and preview text", () => {
    const results = filterLibraryPrompts(mockPrompts, "Soroban");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Soroban Smart Contract Generator");
  });

  it("filters prompts by category", () => {
    const results = filterLibraryPrompts(mockPrompts, "", "Creative");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("AI Storytelling Prompt");
  });

  it("filters prompts by status (unlocked vs locked)", () => {
    const unlockedRecord = { "1": "Plaintext instructions" };
    const unlocked = filterLibraryPrompts(mockPrompts, "", "all", "unlocked", "newest", unlockedRecord);
    expect(unlocked).toHaveLength(1);
    expect(unlocked[0].id).toBe(1n);

    const locked = filterLibraryPrompts(mockPrompts, "", "all", "locked", "newest", unlockedRecord);
    expect(locked).toHaveLength(2);
  });

  it("sorts prompts by price high to low", () => {
    const results = filterLibraryPrompts(mockPrompts, "", "all", "all", "price-high");
    expect(results[0].id).toBe(2n); // 50000000n
    expect(results[1].id).toBe(3n); // 20000000n
    expect(results[2].id).toBe(1n); // 10000000n
  });


  it("sorts extreme bigint IDs newest/oldest without Number coercion (#178)", () => {
    const above = BigInt(Number.MAX_SAFE_INTEGER) + 100n;
    const extreme: PromptRecord[] = [
      { ...mockPrompts[0], id: above, title: "mid" },
      { ...mockPrompts[1], id: above + 3n, title: "newest" },
      { ...mockPrompts[2], id: above - 3n, title: "oldest" },
    ];
    expect(filterLibraryPrompts(extreme, "", "all", "all", "newest").map((p) => p.title)).toEqual([
      "newest",
      "mid",
      "oldest",
    ]);
    expect(filterLibraryPrompts(extreme, "", "all", "all", "oldest").map((p) => p.title)).toEqual([
      "oldest",
      "mid",
      "newest",
    ]);
  });

  it("keeps equal-price tie-break stable by id (#178)", () => {
    const above = BigInt(Number.MAX_SAFE_INTEGER) + 7n;
    const tied: PromptRecord[] = [
      { ...mockPrompts[0], id: above + 2n, priceStroops: above, title: "c" },
      { ...mockPrompts[1], id: above, priceStroops: above, title: "a" },
      { ...mockPrompts[2], id: above + 1n, priceStroops: above, title: "b" },
    ];
    const first = filterLibraryPrompts(tied, "", "all", "all", "price-low").map((p) => p.title);
    const second = filterLibraryPrompts(tied, "", "all", "all", "price-low").map((p) => p.title);
    expect(first).toEqual(["a", "b", "c"]);
    expect(first).toEqual(second);
  });

  describe("local unlock history tracking", () => {
    const wallet = "GBUYER1234567890ABCDEFGH1234567890ABCDEFGH1234567890";

    beforeEach(() => {
      clearUnlockHistory(wallet);
    });

    it("records and retrieves unlock history entries", () => {
      addUnlockHistoryEntry(wallet, {
        promptId: "1",
        title: "React TypeScript System Prompt",
        status: "success",
      });

      const history = getUnlockHistory(wallet);
      expect(history).toHaveLength(1);
      expect(history[0].title).toBe("React TypeScript System Prompt");
      expect(history[0].status).toBe("success");
    });

    it("clears unlock history for wallet", () => {
      addUnlockHistoryEntry(wallet, {
        promptId: "1",
        title: "Test",
        status: "success",
      });
      clearUnlockHistory(wallet);
      expect(getUnlockHistory(wallet)).toHaveLength(0);
    });
  });
});
