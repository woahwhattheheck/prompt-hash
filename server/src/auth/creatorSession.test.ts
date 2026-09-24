/**
 * Creator session auth — security regression tests (#142).
 */

import { createHmac } from "crypto";
import { Keypair } from "@stellar/stellar-sdk";
import {
  CREATOR_DRAFTS_READ,
  CREATOR_OWNED_READ,
  CREATOR_SESSION_AUD,
  CREATOR_VERSION_WRITE,
  CreatorSessionError,
  SessionNonceLedger,
  authenticateCreatorSession,
  buildCreatorSessionMessage,
  createCreatorSessionToken,
  creatorSessionHttpStatus,
  digestVersionContent,
  verifyCreatorSessionToken,
} from "./creatorSession";

const SECRET = "test-challenge-token-secret-00000001"; // >= 32
const NETWORK = "Test SDF Network ; September 2015";
const OTHER_NETWORK = "Public Global Stellar Network ; September 2015";
const NOW = 1_700_000_000_000;
const PROMPT = "prompt-42";
const CONTENT = "secret draft plaintext for version v2";

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

describe("createCreatorSessionToken / verifyCreatorSessionToken", () => {
  it("issues and verifies an owned-read session", () => {
    const kp = Keypair.random();
    const issued = createCreatorSessionToken({
      address: kp.publicKey(),
      action: CREATOR_OWNED_READ,
      network: NETWORK,
      secret: SECRET,
      now: NOW,
    });

    expect(issued.action).toBe(CREATOR_OWNED_READ);
    expect(issued.promptId).toBe("*");
    expect(issued.challenge).toContain(CREATOR_OWNED_READ);

    const claims = verifyCreatorSessionToken(issued.sessionToken, {
      secret: SECRET,
      now: NOW + 1000,
      expectedAction: CREATOR_OWNED_READ,
      expectedNetwork: NETWORK,
    });
    expect(claims.address).toBe(kp.publicKey());
    expect(claims.aud).toBe(CREATOR_SESSION_AUD);
  });

  it("binds promptId + contentDigest for version writes", () => {
    const kp = Keypair.random();
    const digest = digestVersionContent(CONTENT);
    const issued = createCreatorSessionToken({
      address: kp.publicKey(),
      action: CREATOR_VERSION_WRITE,
      promptId: PROMPT,
      contentDigest: digest,
      network: NETWORK,
      secret: SECRET,
      now: NOW,
    });

    expect(issued.contentDigest).toBe(digest);
    const claims = verifyCreatorSessionToken(issued.sessionToken, {
      secret: SECRET,
      now: NOW + 10,
      expectedAction: CREATOR_VERSION_WRITE,
      expectedPromptId: PROMPT,
      expectedContentDigest: digest,
      expectedNetwork: NETWORK,
    });
    expect(claims.promptId).toBe(PROMPT);
    expect(claims.contentDigest).toBe(digest);
  });

  it("rejects forged / wrong-secret tokens", () => {
    const kp = Keypair.random();
    const forged = forge(
      {
        address: kp.publicKey(),
        action: CREATOR_DRAFTS_READ,
        network: NETWORK,
        nonce: "n1",
        iat: NOW,
        exp: NOW + 60_000,
        aud: CREATOR_SESSION_AUD,
        promptId: "*",
        contentDigest: "",
      },
      "wrong-secret-xxxxxxxxxxxxxxxxxxxxx",
    );

    expect(() =>
      verifyCreatorSessionToken(forged, {
        secret: SECRET,
        now: NOW,
        expectedNetwork: NETWORK,
      }),
    ).toThrow(CreatorSessionError);
  });

  it("rejects wrong-network sessions", () => {
    const kp = Keypair.random();
    const issued = createCreatorSessionToken({
      address: kp.publicKey(),
      action: CREATOR_OWNED_READ,
      network: OTHER_NETWORK,
      secret: SECRET,
      now: NOW,
    });

    try {
      verifyCreatorSessionToken(issued.sessionToken, {
        secret: SECRET,
        now: NOW + 100,
        expectedNetwork: NETWORK,
      });
      fail("expected wrong_network");
    } catch (err) {
      expect((err as CreatorSessionError).code).toBe("wrong_network");
      expect(creatorSessionHttpStatus(err as CreatorSessionError)).toBe(403);
    }
  });

  it("rejects digest mismatch for version writes", () => {
    const kp = Keypair.random();
    const issued = createCreatorSessionToken({
      address: kp.publicKey(),
      action: CREATOR_VERSION_WRITE,
      promptId: PROMPT,
      contentDigest: digestVersionContent(CONTENT),
      network: NETWORK,
      secret: SECRET,
      now: NOW,
    });

    try {
      verifyCreatorSessionToken(issued.sessionToken, {
        secret: SECRET,
        now: NOW + 10,
        expectedAction: CREATOR_VERSION_WRITE,
        expectedPromptId: PROMPT,
        expectedContentDigest: digestVersionContent("tampered content!!!"),
        expectedNetwork: NETWORK,
      });
      fail("expected digest_mismatch");
    } catch (err) {
      expect((err as CreatorSessionError).code).toBe("digest_mismatch");
      expect(creatorSessionHttpStatus(err as CreatorSessionError)).toBe(403);
    }
  });
});

describe("authenticateCreatorSession", () => {
  it("valid creator: signature + nonce accepted once", () => {
    const kp = Keypair.random();
    const ledger = new SessionNonceLedger();
    const issued = createCreatorSessionToken({
      address: kp.publicKey(),
      action: CREATOR_OWNED_READ,
      network: NETWORK,
      secret: SECRET,
      now: NOW,
    });
    const signature = signMessage(kp, issued.challenge);

    const session = authenticateCreatorSession({
      sessionToken: issued.sessionToken,
      signature,
      expectedAction: CREATOR_OWNED_READ,
      expectedWallet: kp.publicKey(),
      secret: SECRET,
      now: NOW + 50,
      ledger,
    });
    expect(session.address).toBe(kp.publicKey().toLowerCase());

    try {
      authenticateCreatorSession({
        sessionToken: issued.sessionToken,
        signature,
        expectedAction: CREATOR_OWNED_READ,
        expectedWallet: kp.publicKey(),
        secret: SECRET,
        now: NOW + 60,
        ledger,
      });
      fail("expected replay");
    } catch (err) {
      expect((err as CreatorSessionError).code).toBe("replay");
      expect(creatorSessionHttpStatus(err as CreatorSessionError)).toBe(409);
    }
  });

  it("cross-wallet: session for A cannot read B", () => {
    const a = Keypair.random();
    const b = Keypair.random();
    const issued = createCreatorSessionToken({
      address: a.publicKey(),
      action: CREATOR_DRAFTS_READ,
      network: NETWORK,
      secret: SECRET,
      now: NOW,
    });
    const signature = signMessage(a, issued.challenge);

    try {
      authenticateCreatorSession({
        sessionToken: issued.sessionToken,
        signature,
        expectedAction: CREATOR_DRAFTS_READ,
        expectedWallet: b.publicKey(),
        secret: SECRET,
        now: NOW + 10,
        ledger: new SessionNonceLedger(),
      });
      fail("expected wallet_mismatch");
    } catch (err) {
      expect((err as CreatorSessionError).code).toBe("wallet_mismatch");
      expect(creatorSessionHttpStatus(err as CreatorSessionError)).toBe(403);
    }
  });

  it("rejects invalid wallet signature", () => {
    const kp = Keypair.random();
    const other = Keypair.random();
    const issued = createCreatorSessionToken({
      address: kp.publicKey(),
      action: CREATOR_OWNED_READ,
      network: NETWORK,
      secret: SECRET,
      now: NOW,
    });
    const badSig = signMessage(other, issued.challenge);

    try {
      authenticateCreatorSession({
        sessionToken: issued.sessionToken,
        signature: badSig,
        expectedAction: CREATOR_OWNED_READ,
        expectedWallet: kp.publicKey(),
        secret: SECRET,
        now: NOW + 10,
        ledger: new SessionNonceLedger(),
      });
      fail("expected invalid_signature");
    } catch (err) {
      expect((err as CreatorSessionError).code).toBe("invalid_signature");
      expect(creatorSessionHttpStatus(err as CreatorSessionError)).toBe(401);
    }
  });

  it("message covers action, address, prompt, digest, network, nonce", () => {
    const kp = Keypair.random();
    const digest = digestVersionContent(CONTENT);
    const issued = createCreatorSessionToken({
      address: kp.publicKey(),
      action: CREATOR_VERSION_WRITE,
      promptId: PROMPT,
      contentDigest: digest,
      network: NETWORK,
      secret: SECRET,
      now: NOW,
    });
    const claims = verifyCreatorSessionToken(issued.sessionToken, {
      secret: SECRET,
      now: NOW,
      expectedNetwork: NETWORK,
    });
    const msg = buildCreatorSessionMessage(claims);
    expect(msg).toContain(CREATOR_VERSION_WRITE);
    expect(msg).toContain(kp.publicKey());
    expect(msg).toContain(PROMPT);
    expect(msg).toContain(digest);
    expect(msg).toContain(NETWORK);
    expect(msg).toBe(issued.challenge);
  });
});
