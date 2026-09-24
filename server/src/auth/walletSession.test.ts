/**
 * Wallet session auth — security regression tests (#147).
 */

import { createHmac } from "crypto";
import { Keypair } from "@stellar/stellar-sdk";
import {
  SessionNonceLedger,
  VOTE_CREATE_ACTION,
  VOTE_DELETE_ACTION,
  WALLET_SESSION_AUD,
  WalletSessionError,
  authenticateVoteSession,
  buildWalletSessionMessage,
  createWalletSessionToken,
  getExpectedNetworkPassphrase,
  verifyWalletSessionToken,
  walletSessionHttpStatus,
} from "./walletSession";

const SECRET = "test-challenge-token-secret-00000001"; // >= 32
const NETWORK = "Test SDF Network ; September 2015";
const OTHER_NETWORK = "Public Global Stellar Network ; September 2015";
const NOW = 1_700_000_000_000;
const PROMPT = "prompt-42";

function forge(payload: Record<string, unknown>, secret = SECRET): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

function signMessage(keypair: Keypair, message: string): string {
  return keypair.sign(Buffer.from(message, "utf8")).toString("base64");
}

beforeEach(() => {
  process.env.CHALLENGE_TOKEN_SECRET = SECRET;
  process.env.PUBLIC_STELLAR_NETWORK_PASSPHRASE = NETWORK;
});

afterAll(() => {
  delete process.env.CHALLENGE_TOKEN_SECRET;
});

describe("createWalletSessionToken / verifyWalletSessionToken", () => {
  it("issues and verifies a create-vote session bound to prompt + network", () => {
    const kp = Keypair.random();
    const issued = createWalletSessionToken({
      address: kp.publicKey(),
      promptId: PROMPT,
      action: VOTE_CREATE_ACTION,
      network: NETWORK,
      secret: SECRET,
      now: NOW,
    });

    expect(issued.network).toBe(NETWORK);
    expect(issued.action).toBe(VOTE_CREATE_ACTION);
    expect(issued.challenge).toContain(VOTE_CREATE_ACTION);

    const claims = verifyWalletSessionToken(issued.sessionToken, {
      secret: SECRET,
      now: NOW + 1000,
      expectedPromptId: PROMPT,
      expectedAction: VOTE_CREATE_ACTION,
      expectedNetwork: NETWORK,
    });
    expect(claims.address).toBe(kp.publicKey());
    expect(claims.aud).toBe(WALLET_SESSION_AUD);
  });

  it("rejects forged / wrong-secret tokens", () => {
    const kp = Keypair.random();
    const forged = forge({
      address: kp.publicKey(),
      promptId: PROMPT,
      network: NETWORK,
      action: VOTE_CREATE_ACTION,
      nonce: "n1",
      iat: NOW,
      exp: NOW + 60_000,
      aud: WALLET_SESSION_AUD,
    }, "wrong-secret-xxxxxxxxxxxxxxxxxxxxx");

    expect(() =>
      verifyWalletSessionToken(forged, {
        secret: SECRET,
        now: NOW,
        expectedNetwork: NETWORK,
      }),
    ).toThrow(WalletSessionError);
  });

  it("rejects wrong-network sessions", () => {
    const kp = Keypair.random();
    const issued = createWalletSessionToken({
      address: kp.publicKey(),
      promptId: PROMPT,
      action: VOTE_CREATE_ACTION,
      network: OTHER_NETWORK,
      secret: SECRET,
      now: NOW,
    });

    try {
      verifyWalletSessionToken(issued.sessionToken, {
        secret: SECRET,
        now: NOW + 100,
        expectedNetwork: NETWORK,
      });
      fail("expected wrong_network");
    } catch (err) {
      expect((err as WalletSessionError).code).toBe("wrong_network");
      expect(walletSessionHttpStatus(err as WalletSessionError)).toBe(403);
    }
  });

  it("rejects prompt / action mismatch", () => {
    const kp = Keypair.random();
    const issued = createWalletSessionToken({
      address: kp.publicKey(),
      promptId: PROMPT,
      action: VOTE_CREATE_ACTION,
      network: NETWORK,
      secret: SECRET,
      now: NOW,
    });

    expect(() =>
      verifyWalletSessionToken(issued.sessionToken, {
        secret: SECRET,
        now: NOW + 100,
        expectedPromptId: "other-prompt",
        expectedNetwork: NETWORK,
      }),
    ).toThrow(/prompt/i);

    expect(() =>
      verifyWalletSessionToken(issued.sessionToken, {
        secret: SECRET,
        now: NOW + 100,
        expectedAction: VOTE_DELETE_ACTION,
        expectedNetwork: NETWORK,
      }),
    ).toThrow(/action/i);
  });

  it("rejects expired tokens", () => {
    const kp = Keypair.random();
    const issued = createWalletSessionToken({
      address: kp.publicKey(),
      promptId: PROMPT,
      action: VOTE_CREATE_ACTION,
      network: NETWORK,
      secret: SECRET,
      now: NOW,
      ttlMs: 1000,
    });

    expect(() =>
      verifyWalletSessionToken(issued.sessionToken, {
        secret: SECRET,
        now: NOW + 5000,
        expectedNetwork: NETWORK,
      }),
    ).toThrow(/expired/i);
  });
});

describe("authenticateVoteSession", () => {
  it("accepts a valid buyer signature (happy path)", () => {
    const kp = Keypair.random();
    const ledger = new SessionNonceLedger();
    const issued = createWalletSessionToken({
      address: kp.publicKey(),
      promptId: PROMPT,
      action: VOTE_CREATE_ACTION,
      network: NETWORK,
      secret: SECRET,
      now: NOW,
    });
    const signature = signMessage(kp, issued.challenge);

    const verified = authenticateVoteSession({
      sessionToken: issued.sessionToken,
      signature,
      expectedPromptId: PROMPT,
      expectedAction: VOTE_CREATE_ACTION,
      secret: SECRET,
      now: NOW + 100,
      expectedNetwork: NETWORK,
      ledger,
    });

    expect(verified.address).toBe(kp.publicKey().toLowerCase());
  });

  it("rejects impersonation (signature from a different wallet)", () => {
    const victim = Keypair.random();
    const attacker = Keypair.random();
    const ledger = new SessionNonceLedger();
    const issued = createWalletSessionToken({
      address: victim.publicKey(),
      promptId: PROMPT,
      action: VOTE_CREATE_ACTION,
      network: NETWORK,
      secret: SECRET,
      now: NOW,
    });
    // Attacker signs the victim's challenge — signature will not verify
    // against the session address (victim).
    const signature = signMessage(attacker, issued.challenge);

    try {
      authenticateVoteSession({
        sessionToken: issued.sessionToken,
        signature,
        expectedPromptId: PROMPT,
        expectedAction: VOTE_CREATE_ACTION,
        secret: SECRET,
        now: NOW + 100,
        expectedNetwork: NETWORK,
        ledger,
      });
      fail("expected invalid_signature");
    } catch (err) {
      expect((err as WalletSessionError).code).toBe("invalid_signature");
    }
  });

  it("rejects replay of a spent nonce", () => {
    const kp = Keypair.random();
    const ledger = new SessionNonceLedger();
    const issued = createWalletSessionToken({
      address: kp.publicKey(),
      promptId: PROMPT,
      action: VOTE_DELETE_ACTION,
      network: NETWORK,
      secret: SECRET,
      now: NOW,
    });
    const signature = signMessage(kp, issued.challenge);

    authenticateVoteSession({
      sessionToken: issued.sessionToken,
      signature,
      expectedPromptId: PROMPT,
      expectedAction: VOTE_DELETE_ACTION,
      secret: SECRET,
      now: NOW + 100,
      expectedNetwork: NETWORK,
      ledger,
    });

    try {
      authenticateVoteSession({
        sessionToken: issued.sessionToken,
        signature,
        expectedPromptId: PROMPT,
        expectedAction: VOTE_DELETE_ACTION,
        secret: SECRET,
        now: NOW + 200,
        expectedNetwork: NETWORK,
        ledger,
      });
      fail("expected replay");
    } catch (err) {
      expect((err as WalletSessionError).code).toBe("replay");
      expect(walletSessionHttpStatus(err as WalletSessionError)).toBe(409);
    }
  });

  it("rejects wrong-network at authenticate boundary", () => {
    const kp = Keypair.random();
    const ledger = new SessionNonceLedger();
    const issued = createWalletSessionToken({
      address: kp.publicKey(),
      promptId: PROMPT,
      action: VOTE_CREATE_ACTION,
      network: OTHER_NETWORK,
      secret: SECRET,
      now: NOW,
    });
    const signature = signMessage(kp, buildWalletSessionMessage({
      address: kp.publicKey(),
      promptId: PROMPT,
      network: OTHER_NETWORK,
      action: VOTE_CREATE_ACTION,
      nonce: issued.nonce,
      iat: issued.issuedAt,
      exp: issued.expiresAt,
      aud: WALLET_SESSION_AUD,
    }));

    try {
      authenticateVoteSession({
        sessionToken: issued.sessionToken,
        signature,
        expectedPromptId: PROMPT,
        expectedAction: VOTE_CREATE_ACTION,
        secret: SECRET,
        now: NOW + 100,
        expectedNetwork: NETWORK,
        ledger,
      });
      fail("expected wrong_network");
    } catch (err) {
      expect((err as WalletSessionError).code).toBe("wrong_network");
    }
  });
});

describe("getExpectedNetworkPassphrase", () => {
  it("reads the configured passphrase", () => {
    expect(getExpectedNetworkPassphrase({ PUBLIC_STELLAR_NETWORK_PASSPHRASE: NETWORK })).toBe(
      NETWORK,
    );
  });
});
