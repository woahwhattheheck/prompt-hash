/**
 * Ingest seller-relevant indexer events into the durable notification log (#181).
 *
 * Email delivery is intentionally untouched.
 */

import {
  appendSellerEvent,
  buildEventId,
  logicalKeyForEvent,
  normalizeWallet,
  type IndexedSellerEvent,
  type SellerEventTopic,
} from "../../../src/lib/notifications/sellerNotificationStore";

const SELLER_TOPICS = new Set<string>([
  "PromptPurchased",
  "PromptSaleStatusUpdated",
  "PromptPriceUpdated",
]);

export type IndexerSellerEventInput = {
  network?: string;
  contract?: string;
  ledger: number;
  transaction: string;
  eventIndex?: number;
  schemaIdentity?: string;
  topic: string;
  /** Creator / seller wallet. */
  wallet: string;
  promptId: string;
  title?: string;
  buyer?: string;
  active?: boolean;
  priceStroops?: string | number | bigint;
  createdAt?: number;
  correctionOf?: string;
};

/**
 * Persist a seller-facing notification event. Idempotent on eventId.
 * Returns null when the topic is not seller-notification-relevant.
 */
export async function ingestSellerNotificationEvent(
  input: IndexerSellerEventInput,
): Promise<{ created: boolean; event: IndexedSellerEvent } | null> {
  if (!SELLER_TOPICS.has(input.topic)) return null;
  if (!input.wallet?.trim()) return null;

  const network = input.network || process.env.PUBLIC_STELLAR_NETWORK || "TESTNET";
  const contract =
    input.contract ||
    process.env.PUBLIC_PROMPT_HASH_CONTRACT_ID ||
    "PROMPT_HASH_CONTRACT";
  const schemaIdentity = input.schemaIdentity || "prompt-hash:v1";
  const eventIndex = input.eventIndex ?? 0;
  const priceStroops =
    input.priceStroops === undefined || input.priceStroops === null
      ? undefined
      : String(input.priceStroops);

  const topic = input.topic as SellerEventTopic;
  const eventId = buildEventId({
    network,
    contract,
    ledger: Number(input.ledger),
    transaction: input.transaction,
    eventIndex,
    schemaIdentity,
  });

  const event: IndexedSellerEvent = {
    eventId,
    network,
    contract,
    ledger: Number(input.ledger),
    transaction: input.transaction,
    eventIndex,
    schemaIdentity,
    topic,
    wallet: normalizeWallet(input.wallet),
    promptId: String(input.promptId),
    title: input.title || `Prompt ${input.promptId}`,
    createdAt: input.createdAt ?? Date.now(),
    buyer: input.buyer ? normalizeWallet(input.buyer) : undefined,
    active: input.active,
    priceStroops,
    logicalKey: logicalKeyForEvent(topic, String(input.promptId), {
      transaction: input.transaction,
      priceStroops,
      active: input.active,
    }),
    correctionOf: input.correctionOf,
  };

  return appendSellerEvent(event);
}
