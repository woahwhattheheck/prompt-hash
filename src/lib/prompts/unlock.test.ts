import { beforeEach, describe, expect, it, vi } from "vitest";
import { ERROR_MESSAGES } from "@/lib/api/errorCodes";

const hashPromptPlaintextMock = vi.fn();

vi.mock("@/lib/crypto/promptCrypto", () => ({
  hashPromptPlaintext: (...args: unknown[]) => hashPromptPlaintextMock(...args),
}));

import { unlockPromptContent } from "./unlock";

describe("unlockPromptContent client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    hashPromptPlaintextMock.mockResolvedValue("abc123");
  });

  it("requests a challenge, signs it, and returns verified plaintext", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: "token-1",
            challenge: "prompt-hash unlock:challenge",
            expiresAt: Date.now() + 60_000,
            nonce: "nonce-1",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            promptId: "7",
            title: "Test prompt",
            contentHash: "abc123",
            plaintext: "Decrypted prompt body",
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const signMessage = vi.fn().mockResolvedValue({ signedMessage: "signed-by-wallet" });
    const result = await unlockPromptContent(
      "GBUYERACCOUNT1234567890ABCDEFGH1234567890ABCDEFGH123456789",
      7n,
      signMessage,
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/auth/challenge",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/prompts/unlock",
      expect.objectContaining({ method: "POST" }),
    );
    expect(signMessage).toHaveBeenCalledWith("prompt-hash unlock:challenge");
    expect(result.plaintext).toBe("Decrypted prompt body");
    expect(result.decryptedContent).toBe("Decrypted prompt body");
  });

  it("maps integrity failures to safe user-facing errors", async () => {
    hashPromptPlaintextMock.mockResolvedValue("different-hash");

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              token: "token-1",
              challenge: "prompt-hash unlock:challenge",
              expiresAt: Date.now() + 60_000,
              nonce: "nonce-1",
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              promptId: "7",
              title: "Test prompt",
              contentHash: "abc123",
              plaintext: "Decrypted prompt body",
            }),
            { status: 200 },
          ),
        ),
    );

    await expect(
      unlockPromptContent(
        "GBUYERACCOUNT1234567890ABCDEFGH1234567890ABCDEFGH123456789",
        "7",
        vi.fn().mockResolvedValue({ signedMessage: "signed-by-wallet" }),
      ),
    ).rejects.toThrow(ERROR_MESSAGES.INTEGRITY_FAILURE);
  });

  it("maps API error codes without exposing sensitive backend details", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              token: "token-1",
              challenge: "prompt-hash unlock:challenge",
              expiresAt: Date.now() + 60_000,
              nonce: "nonce-1",
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: "Prompt integrity check failed.",
              code: "INTEGRITY_FAILURE",
            }),
            { status: 500 },
          ),
        ),
    );

    await expect(
      unlockPromptContent(
        "GBUYERACCOUNT1234567890ABCDEFGH1234567890ABCDEFGH123456789",
        "7",
        vi.fn().mockResolvedValue({ signedMessage: "signed-by-wallet" }),
      ),
    ).rejects.toThrow(ERROR_MESSAGES.INTEGRITY_FAILURE);
  });
});

describe("unlockPromptContent pre-sign listing gate (#239)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    hashPromptPlaintextMock.mockResolvedValue("abc123");
  });

  it("blocks wallet signing when the live quote price changed", async () => {
    const boundQuote = {
      promptId: "7",
      versionIndex: 1,
      priceStroops: "50000000",
      asset: "native-asset",
      seller: "GSELLER",
      active: true,
      termsHash: "boundhash",
    };
    const liveQuote = { ...boundQuote, priceStroops: "90000000", termsHash: "livehash" };

    const signMessage = vi.fn().mockResolvedValue({ signedMessage: "should-not-run" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: "token-1",
            challenge: "prompt-hash unlock:challenge",
            expiresAt: Date.now() + 60_000,
            nonce: "nonce-1",
            quote: boundQuote,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ quote: liveQuote }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      unlockPromptContent(
        "GBUYERACCOUNT1234567890ABCDEFGH1234567890ABCDEFGH123456789",
        "7",
        signMessage,
      ),
    ).rejects.toMatchObject({ code: "TERMS_CHANGED" });

    expect(signMessage).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("signs only after the live quote matches the bound challenge quote", async () => {
    const quote = {
      promptId: "7",
      versionIndex: 1,
      priceStroops: "50000000",
      asset: "native-asset",
      seller: "GSELLER",
      active: true,
      termsHash: "samehash",
    };

    const signMessage = vi.fn().mockResolvedValue({ signedMessage: "signed-by-wallet" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: "token-1",
            challenge: "prompt-hash unlock:challenge",
            expiresAt: Date.now() + 60_000,
            nonce: "nonce-1",
            quote,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ quote }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            promptId: "7",
            title: "Test prompt",
            contentHash: "abc123",
            plaintext: "Decrypted prompt body",
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await unlockPromptContent(
      "GBUYERACCOUNT1234567890ABCDEFGH1234567890ABCDEFGH123456789",
      "7",
      signMessage,
    );

    expect(signMessage).toHaveBeenCalledTimes(1);
    expect(result.plaintext).toBe("Decrypted prompt body");
  });
});
