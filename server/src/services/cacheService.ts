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

type InFlightLoad = { generation: number; promise: Promise<unknown> };

const inFlightLoads = new Map<string, InFlightLoad>();
const keyInvalidationVersions = new Map<string, number>();
const patternInvalidationVersions = new Map<string, number>();
let invalidationVersion = 0;
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

function matchesPattern(key: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const expression = escaped.replace(/\*/g, ".*");
  return new RegExp(`^${expression}$`).test(key);
}

function generationFor(key: string): number {
  let generation = keyInvalidationVersions.get(key) ?? 0;
  for (const [pattern, version] of patternInvalidationVersions) {
    if (version > generation && matchesPattern(key, pattern)) generation = version;
  }
  return generation;
}

function invalidateKeys(keys: string[]): void {
  const version = ++invalidationVersion;
  for (const key of keys) keyInvalidationVersions.set(key, version);
}

function invalidatePattern(pattern: string): void {
  patternInvalidationVersions.set(pattern, ++invalidationVersion);
}

function cursorIsDone(cursor: string | number): boolean {
  return cursor === 0 || cursor === "0";
}

function normalizeCursor(cursor: string | number | { toString(): string }): string {
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
        timeout = setTimeout(() => reject(new CacheTimeoutError()), COMMAND_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function invalidate(activeClient: RedisClientType, operation: CacheOperation, error: unknown): void {
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

  const candidate = createClient({ url: process.env.REDIS_URL }) as RedisClientType;
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
    return value === null ? { status: "miss", value: null } : { status: "hit", value };
  } catch (error) {
    if (activeClient) invalidate(activeClient, "get", error);
    return { status: "unavailable", value: null };
  }
}

export async function cacheGet(key: string): Promise<string | null> {
  const result = await cacheRead(key);
  return result.status === "hit" ? result.value : null;
}

export async function cacheSet(
  key: string,
  value: string,
  ttlSeconds = DEFAULT_TTL,
): Promise<void> {
  let activeClient: RedisClientType | null = null;
  try {
    activeClient = await getClient();
    if (!activeClient) return;
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
  try {
    activeClient = await getClient();
    if (!activeClient) {
      metrics.durationMs = Date.now() - started;
      reportInvalidation(metrics);
      return;
    }

    let cursor: string = "0";
    do {
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
          const removed = await withTimeout(activeClient.del(chunk));
          metrics.deletedKeys += typeof removed === "number" ? removed : chunk.length;
        } catch (error) {
          metrics.failures += 1;
          // Soft-fail a single delete batch so remaining SCAN hops can proceed;
          // hard client death is handled by the outer catch after destroy.
          if (error instanceof CacheTimeoutError) throw error;
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
    if (activeClient) invalidate(activeClient, "scan", error);
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

  const generation = generationFor(key);
  const existing = inFlightLoads.get(key);
  if (existing?.generation === generation) return existing.promise as Promise<T>;

  const load = loader()
    .then(async (value) => {
      if (generationFor(key) === generation) {
        await cacheSet(key, JSON.stringify(value), ttlSeconds);
      }
      return value;
    })
    .finally(() => {
      if (inFlightLoads.get(key)?.promise === load) inFlightLoads.delete(key);
    });

  inFlightLoads.set(key, { generation, promise: load });
  return load;
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
  inFlightLoads.clear();
  keyInvalidationVersions.clear();
  patternInvalidationVersions.clear();
  invalidationVersion = 0;
  lastInvalidationMetrics = null;
}
