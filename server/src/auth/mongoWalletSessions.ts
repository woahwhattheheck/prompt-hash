import connectDb from "../db/connectDb";
import CreatorSessionNonce from "../models/CreatorSessionNonce";
import WalletSession from "../models/WalletSession";
import { verifyChallengeSignature } from "../utils/challengeSignature";
import { WalletSessions, type WalletPrincipal, type WalletSessionStore } from "./walletPrincipal";

function identity(principal: WalletPrincipal) {
  return {
    _id: principal.sessionId, address: principal.address, network: principal.network,
    origin: principal.origin, issuedAt: new Date(principal.issuedAt),
    expiresAt: new Date(principal.expiresAt),
  };
}

export const mongoWalletSessionStore: WalletSessionStore = {
  async consumeChallenge(nonce, expiresAt) {
    await connectDb();
    try {
      // Reuse #142's durable atomic nonce collection with a distinct namespace.
      // Mongo's built-in _id uniqueness works before any optional index build.
      await CreatorSessionNonce.create({ _id: `wallet:${nonce}`, expiresAt: new Date(expiresAt) });
      return true;
    } catch (error) {
      if ((error as { code?: number })?.code === 11000) return false;
      throw error;
    }
  },
  async createSession(principal) {
    await connectDb();
    await WalletSession.create(identity(principal));
  },
  async useSession(principal, now) {
    await connectDb();
    if (principal.expiresAt <= now) return false;
    const row = await WalletSession.findOneAndUpdate(
      { ...identity(principal), revokedAt: null },
      { $set: { lastUsedAt: new Date(now) }, $inc: { accessCount: 1 } },
      { new: true },
    ).lean();
    return Boolean(row);
  },
  async revokeSession(principal, now) {
    await connectDb();
    const result = await WalletSession.updateOne(
      { ...identity(principal), revokedAt: null },
      { $set: { revokedAt: new Date(now) } },
    );
    return result.modifiedCount === 1;
  },
};

export function productionWalletSessions() {
  return new WalletSessions({
    secret: process.env.CHALLENGE_TOKEN_SECRET || "",
    network: process.env.PUBLIC_STELLAR_NETWORK_PASSPHRASE || "",
    store: mongoWalletSessionStore,
    verifyWallet: verifyChallengeSignature,
  });
}
