import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { WalletSessions, walletRequestOrigin } from "./walletPrincipal.ts";

const origin = "https://prompt-hash.example";
const network = "Test SDF Network ; September 2015";
const secret = "wallet-principal-unit-key-32-characters";
const now = 1_800_000_000_000;
const { publicKey, privateKey } = generateKeyPairSync("ed25519");

// Encode the real public key as a Stellar StrKey (version byte + CRC16-XModem).
const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
const payload = Buffer.concat([Buffer.from([6 << 3]), raw]);
let crc = 0;
for (const byte of payload) {
  crc ^= byte << 8;
  for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
}
const encoded = Buffer.concat([payload, Buffer.from([crc & 0xff, crc >> 8])]);
let address = "", bits = 0, value = 0;
for (const byte of encoded) {
  value = (value << 8) | byte; bits += 8;
  while (bits >= 5) { bits -= 5; address += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[(value >>> bits) & 31]; }
}
if (bits) address += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[(value << (5 - bits)) & 31];

function fixture() {
  const consumed = new Set(), rows = new Map();
  const store = {
    async consumeChallenge(nonce) {
      if (consumed.has(nonce)) return false;
      consumed.add(nonce); return true;
    },
    async createSession(principal) { rows.set(principal.sessionId, { ...principal, revoked: false }); },
    async useSession(principal) {
      const row = rows.get(principal.sessionId);
      return Boolean(row && !row.revoked && Object.keys(principal).every(key => row[key] === principal[key]));
    },
    async revokeSession(principal) {
      const row = rows.get(principal.sessionId);
      if (!row || row.revoked) return false;
      row.revoked = true; return true;
    },
  };
  const make = (expectedNetwork = network) => new WalletSessions({
    secret, network: expectedNetwork, store,
    verifyWallet: (wallet, message, signature) => wallet === address &&
      verify(null, Buffer.from(message), publicKey, Buffer.from(signature, "base64")),
  });
  return { first: make(), second: make(), make, consumed, rows };
}

function signature(challenge) {
  return sign(null, Buffer.from(challenge.challenge), privateKey).toString("base64");
}

test("valid Ed25519 exchange yields a principal usable by another instance", async () => {
  const { first, second } = fixture();
  const challenge = first.issueChallenge(address, origin, now);
  const issued = await second.exchange(challenge.challengeToken, signature(challenge), origin, now + 1);
  assert.equal(issued.principal.address, address);
  assert.equal(issued.principal.network, network);
  assert.deepEqual(await first.authenticate(issued.sessionToken, origin, now + 2), issued.principal);
});

test("invalid signature does not consume a challenge; concurrent valid exchange wins once", async () => {
  const { first, second, consumed } = fixture();
  const challenge = first.issueChallenge(address, origin, now);
  await assert.rejects(first.exchange(challenge.challengeToken, "invalid", origin, now), { code: "invalid_signature" });
  assert.equal(consumed.size, 0);
  const attempts = await Promise.allSettled([
    first.exchange(challenge.challengeToken, signature(challenge), origin, now),
    second.exchange(challenge.challengeToken, signature(challenge), origin, now),
  ]);
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(attempts.find(result => result.status === "rejected").reason.code, "replay");
});

test("wrong network, origin and proof kind fail before nonce consumption", async () => {
  const { first, make, consumed } = fixture();
  const challenge = first.issueChallenge(address, origin, now);
  const proof = signature(challenge);
  await assert.rejects(make("Public Global Stellar Network ; September 2015").exchange(challenge.challengeToken, proof, origin, now), { code: "wrong_network" });
  await assert.rejects(first.exchange(challenge.challengeToken, proof, "https://other.example", now), { code: "wrong_origin" });
  await assert.rejects(first.authenticate(challenge.challengeToken, origin, now), { code: "invalid_token" });
  assert.equal(consumed.size, 0);
  assert.equal(walletRequestOrigin(origin, [origin]), origin);
  assert.throws(() => walletRequestOrigin(`${origin}/`, [origin]), { code: "wrong_origin" });
  assert.throws(() => walletRequestOrigin(undefined, [origin]), { code: "wrong_origin" });
});

test("altered tokens and proofs signed for different challenges are rejected", async () => {
  const { first } = fixture();
  const a = first.issueChallenge(address, origin, now), b = first.issueChallenge(address, origin, now);
  const token = `${a.challengeToken.slice(0, -1)}${a.challengeToken.endsWith("A") ? "B" : "A"}`;
  await assert.rejects(first.exchange(token, signature(a), origin, now), { code: "invalid_token" });
  await assert.rejects(first.exchange(a.challengeToken, signature(b), origin, now), { code: "invalid_signature" });
});

test("challenge and session expiration are enforced at the exact boundary", async () => {
  const { first, second } = fixture();
  const challenge = first.issueChallenge(address, origin, now);
  await assert.rejects(first.exchange(challenge.challengeToken, signature(challenge), origin, challenge.expiresAt), { code: "expired_token" });
  const fresh = first.issueChallenge(address, origin, now);
  const issued = await first.exchange(fresh.challengeToken, signature(fresh), origin, now);
  await second.authenticate(issued.sessionToken, origin, issued.principal.expiresAt - 1);
  await assert.rejects(second.authenticate(issued.sessionToken, origin, issued.principal.expiresAt), { code: "expired_token" });
});

test("cross-instance revocation persists and does not revoke another session", async () => {
  const { first, second } = fixture();
  async function issue() {
    const challenge = first.issueChallenge(address, origin, now);
    return first.exchange(challenge.challengeToken, signature(challenge), origin, now);
  }
  const a = await issue(), b = await issue();
  await second.revoke(a.sessionToken, origin, now + 1);
  await first.revoke(a.sessionToken, origin, now + 2);
  await assert.rejects(first.authenticate(a.sessionToken, origin, now + 3), { code: "revoked_or_missing_session" });
  await first.authenticate(b.sessionToken, origin, now + 3);
});
