import { createClient, type RedisClientType } from "redis";

export type CacheReadResult =
  | { status: "hit"; value: string }
  | { status: "miss" | "bypass" | "unavailable"; value: null };

export type CacheInvalidationMetrics = {
  pattern: string;
  durationMs: number;
  scannedKeys: number;
  deletedKeys: number;
  scanBatches: number;
  failures: number;
};

let client: RedisClientType | null = null;
let initialization: Promise<RedisClientType> | null = null;
let initializingClient: RedisClientType | null = null;
let unavailableUntil = 0;
let lifecycleVersion = 0;

type InFlightLoad = { invalidated: boolean; promise: Promise<unknown> };

const inFlightLoads = new Map<string, InFlightLoad>();
let lastInvalidationMetrics: CacheInvalidationMetrics | null = null;

const DEFAULT_TTL = 60;
const COMMAND_TIMEOUT_MS = 250;
const RETRY_DELAY_MS = 1_000;
/** Hint for Redis SCAN COUNT — bounds work per hop so unrelated traffic can interleave. */
export const SCAN_BATCH_SIZE = 100;
/** Max keys deleted per DEL call (matches SCAN batch). */
export const DELETE_BATCH_SIZE = 100;

type CacheOperation = "connect" | "get" | "set" | "delete" | "scan" | "parse";

class CacheTimeoutError extends Error {}
class CacheResetError extends Error {}

function errorCode(error: unknown): string {
  if (error instanceof CacheTimeoutError) return "CACHE_TIMEOUT";
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length <= 64) return code;
  }
  return "CACHE_UNAVAILABLE";
}

function reportUnavailable(operation: CacheOperation, error: unknown): void {
  console.warn("[cache] unavailable", {
    operation,
    status: "unavailable",
    code: errorCode(error),
  });
}

function reportInvalidation(metrics: CacheInvalidationMetrics): void {
  lastInvalidationMetrics = metrics;
  console.info("[cache] invalidate", {
    pattern: metrics.pattern,
    durationMs: metrics.durationMs,
    scannedKeys: metrics.scannedKeys,
    deletedKeys: metrics.deletedKeys,
    scanBatches: metrics.scanBatches,
    failures: metrics.failures,
  });
}

function invalidateKeys(keys: string[]): void {
  for (const key of keys) {
    const load = inFlightLoads.get(key);
    if (load) load.invalidated = true;
  }
}

type RedisGlobToken = number | "any" | "star" | Uint8Array;

/** Compile the byte-oriented glob syntax used by Redis SCAN MATCH. */
function compileRedisGlob(pattern: string): RedisGlobToken[] {
  const bytes = Buffer.from(pattern);
  const tokens: RedisGlobToken[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (byte === 42) {
      if (tokens[tokens.length - 1] !== "star") tokens.push("star");
    } else if (byte === 63) {
      tokens.push("any");
    } else if (byte === 91) {
      const members = new Uint8Array(256);
      const negated = bytes[i + 1] === 94;
      if (negated) i += 1;
      for (i += 1; i < bytes.length && bytes[i] !== 93; i += 1) {
        if (bytes[i] === 92 && i + 1 < bytes.length) {
          members[bytes[++i]] = 1;
        } else if (i + 2 < bytes.length && bytes[i + 1] === 45) {
          // Match the signed-byte range ordering in Redis's Linux matcher.
          const start = (bytes[i] << 24) >> 24;
          const end = (bytes[i + 2] << 24) >> 24;
          for (let value = Math.min(start, end); value <= Math.max(start, end); value += 1) {
            members[value & 255] = 1;
          }
          i += 2;
        } else {
          members[bytes[i]] = 1;
        }
      }
      if (negated) {
        for (let value = 0; value < members.length; value += 1) members[value] ^= 1;
      }
      tokens.push(members);
    } else {
      if (byte === 92 && i + 1 < bytes.length) i += 1;
      tokens.push(bytes[i]);
    }
  }
  return tokens;
}

function matchesRedisGlob(tokens: RedisGlobToken[], key: string): boolean {
  const bytes = Buffer.from(key);
  let tokenIndex = 0;
  let keyIndex = 0;
  let starIndex = -1;
  let starKeyIndex = 0;
  // Retry only the latest star; each retry consumes a byte, without recursion
  // or the exponential backtracking of a translated regular expression.
  while (keyIndex < bytes.length) {
    const token = tokens[tokenIndex];
    if (token === "star") {
      starIndex = tokenIndex++;
      starKeyIndex = keyIndex;
    } else if (
      token === "any" ||
      token === bytes[keyIndex] ||
      (token instanceof Uint8Array && token[bytes[keyIndex]] === 1)
    ) {
      tokenIndex += 1;
      keyIndex += 1;
    } else if (starIndex >= 0) {
      tokenIndex = starIndex + 1;
      keyIndex = ++starKeyIndex;
    } else {
      return false;
    }
  }
  while (tokens[tokenIndex] === "star") tokenIndex += 1;
  return tokenIndex === tokens.length;
}

function invalidatePattern(pattern: string): void {
  if (!inFlightLoads.size) return;
  const tokens = compileRedisGlob(pattern);
  for (const [key, load] of inFlightLoads) {
    if (matchesRedisGlob(tokens, key)) load.invalidated = true;
  }
}

function cursorIsDone(cursor: string | number): boolean {
  return cursor === 0 || cursor === "0";
}

function normalizeCursor(
  cursor: string | number | { toString(): string },
): string {
  if (typeof cursor === "number") return String(cursor);
  if (typeof cursor === "string") return cursor;
  return String(cursor);
}

async function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new CacheTimeoutError()),
          COMMAND_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function invalidate(
  activeClient: RedisClientType,
  operation: CacheOperation,
  error: unknown,
): void {
  if (client === activeClient) client = null;
  try {
    activeClient.destroy();
  } catch {
    // A failed client may already be closed.
  }
  unavailableUntil = Date.now() + RETRY_DELAY_MS;
  reportUnavailable(operation, error);
}

async function getClient(): Promise<RedisClientType | null> {
  if (!process.env.REDIS_URL) return null;
  if (client) return client;
  if (Date.now() < unavailableUntil) return null;
  if (initialization) return initialization;

  const candidate = createClient({
    url: process.env.REDIS_URL,
  }) as RedisClientType;
  const version = lifecycleVersion;
  initializingClient = candidate;
  candidate.on("error", (error) => invalidate(candidate, "connect", error));

  initialization = withTimeout(candidate.connect())
    .then(() => {
      if (version !== lifecycleVersion) {
        candidate.destroy();
        throw new CacheResetError();
      }
      client = candidate;
      unavailableUntil = 0;
      return candidate;
    })
    .catch((error: unknown) => {
      if (error instanceof CacheResetError) throw error;
      invalidate(candidate, "connect", error);
      throw error;
    })
    .finally(() => {
      initialization = null;
      if (initializingClient === candidate) initializingClient = null;
    });

  return initialization;
}

export async function cacheRead(key: string): Promise<CacheReadResult> {
  if (!process.env.REDIS_URL) return { status: "bypass", value: null };

  let activeClient: RedisClientType | null = null;
  try {
    activeClient = await getClient();
    if (!activeClient) return { status: "unavailable", value: null };
    const value = await withTimeout(activeClient.get(key));
    return value === null
      ? { status: "miss", value: null }
      : { status: "hit", value };
  } catch (error) {
    if (activeClient) invalidate(activeClient, "get", error);
    return { status: "unavailable", value: null };
  }
}

export async function cacheGet(key: string): Promise<string | null> {
  const result = await cacheRead(key);
  return result.status === "hit" ? result.value : null;
}

export function cacheSet(
  key: string,
  value: string,
  ttlSeconds = DEFAULT_TTL,
): Promise<void> {
  return writeCache(key, value, ttlSeconds);
}

async function writeCache(
  key: string,
  value: string,
  ttlSeconds: number,
  load?: InFlightLoad,
): Promise<void> {
  let activeClient: RedisClientType | null = null;
  try {
    activeClient = await getClient();
    // The load may have been invalidated during serialization or reconnect.
    // Recheck immediately before enqueueing SET, with no intervening await.
    if (!activeClient || load?.invalidated) return;
    await withTimeout(activeClient.set(key, value, { EX: ttlSeconds }));
  } catch (error) {
    if (activeClient) invalidate(activeClient, "set", error);
  }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  invalidateKeys(keys);
  let activeClient: RedisClientType | null = null;
  try {
    activeClient = await getClient();
    if (!activeClient) return;
    await withTimeout(activeClient.del(keys));
  } catch (error) {
    if (activeClient) invalidate(activeClient, "delete", error);
  }
}

/**
 * Invalidate keys matching a Redis glob pattern without issuing KEYS.
 * Uses cursor SCAN with a bounded COUNT, deleting each hop's matches in a
 * separate DEL so unrelated cache traffic can interleave between batches.
 */
export async function cacheDelPattern(pattern: string): Promise<void> {
  invalidatePattern(pattern);
  const started = Date.now();
  const metrics: CacheInvalidationMetrics = {
    pattern,
    durationMs: 0,
    scannedKeys: 0,
    deletedKeys: 0,
    scanBatches: 0,
    failures: 0,
  };

  let activeClient: RedisClientType | null = null;
  let operation: CacheOperation = "scan";
  try {
    activeClient = await getClient();
    if (!activeClient) return;

    let cursor: string = "0";
    do {
      operation = "scan";
      const reply = await withTimeout(
        activeClient.scan(cursor, { MATCH: pattern, COUNT: SCAN_BATCH_SIZE }),
      );
      metrics.scanBatches += 1;
      cursor = normalizeCursor(reply.cursor);

      const keys = (reply.keys ?? []).map((key) =>
        typeof key === "string" ? key : String(key),
      );
      metrics.scannedKeys += keys.length;
      if (!keys.length) continue;

      for (let offset = 0; offset < keys.length; offset += DELETE_BATCH_SIZE) {
        const chunk = keys.slice(offset, offset + DELETE_BATCH_SIZE);
        try {
          operation = "delete";
          const removed = await withTimeout(activeClient.del(chunk));
          metrics.deletedKeys +=
            typeof removed === "number" ? removed : chunk.length;
        } catch (error) {
          if (error instanceof CacheTimeoutError) throw error;
          metrics.failures += 1;
          // Soft-fail a single delete batch so remaining SCAN hops can proceed;
          // hard client death is handled by the outer catch after destroy.
          console.warn("[cache] invalidate batch failed", {
            pattern,
            batchSize: chunk.length,
            code: errorCode(error),
          });
        }
      }
    } while (!cursorIsDone(cursor));
  } catch (error) {
    metrics.failures += 1;
    if (activeClient) invalidate(activeClient, operation, error);
  } finally {
    metrics.durationMs = Date.now() - started;
    reportInvalidation(metrics);
  }
}

export async function cacheGetOrLoad<T>(
  key: string,
  loader: () => Promise<T>,
  ttlSeconds = DEFAULT_TTL,
): Promise<T> {
  const result = await cacheRead(key);
  if (result.status === "hit") {
    try {
      return JSON.parse(result.value) as T;
    } catch (error) {
      reportUnavailable("parse", error);
    }
  }

  const existing = inFlightLoads.get(key);
  if (existing && !existing.invalidated) return existing.promise as Promise<T>;

  // Each pending load keeps its own fence after a newer load replaces it.
  // Register before calling the loader, which may invalidate synchronously.
  const load: InFlightLoad = {
    invalidated: false,
    promise: Promise.resolve()
      .then(loader)
      .then(async (value) => {
        if (!load.invalidated) {
          await writeCache(key, JSON.stringify(value), ttlSeconds, load);
        }
        return value;
      })
      .finally(() => {
        if (inFlightLoads.get(key) === load) inFlightLoads.delete(key);
      }),
  };

  inFlightLoads.set(key, load);
  return load.promise as Promise<T>;
}

export const CACHE_KEYS = {
  promptList: (query: string) => `prompts:list:${query}`,
  promptDetail: (id: string) => `prompts:detail:${id}`,
  promptSearch: (query: string) => `prompts:search:${query}`,
};

export function __lastInvalidationMetricsForTests(): CacheInvalidationMetrics | null {
  return lastInvalidationMetrics;
}

export function __resetCacheForTests(): void {
  lifecycleVersion += 1;
  const clients = new Set([client, initializingClient]);
  for (const activeClient of clients) {
    try {
      activeClient?.destroy();
    } catch {
      // Test cleanup may encounter an already closed fixture client.
    }
  }
  client = null;
  initializingClient = null;
  initialization = null;
  unavailableUntil = 0;
  for (const load of inFlightLoads.values()) load.invalidated = true;
  inFlightLoads.clear();
  lastInvalidationMetrics = null;
}
