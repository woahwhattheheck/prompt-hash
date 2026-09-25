const createClient = jest.fn();

jest.mock("redis", () => ({
  createClient: (...args: unknown[]) => createClient(...args),
}));

import {
  __lastInvalidationMetricsForTests,
  __resetCacheForTests,
  cacheDelPattern,
  cacheGetOrLoad,
  cacheRead,
  DELETE_BATCH_SIZE,
  SCAN_BATCH_SIZE,
} from "../services/cacheService";

type ScanCall = { cursor: string; options: { MATCH?: string; COUNT?: number } };

function redisClient(overrides: Record<string, unknown> = {}) {
  return {
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue("OK"),
    del: jest.fn().mockResolvedValue(0),
    keys: jest.fn(() => {
      throw new Error("KEYS must not be used in production cache paths");
    }),
    scan: jest.fn().mockResolvedValue({ cursor: "0", keys: [] }),
    destroy: jest.fn(),
    ...overrides,
  };
}

/** Build a multi-cursor SCAN mock over a mixed keyspace. */
function scanSequence(pages: Array<{ cursor: string; keys: string[] }>) {
  let index = 0;
  const calls: ScanCall[] = [];
  const scan = jest.fn(async (cursor: string | number, options: { MATCH?: string; COUNT?: number }) => {
    calls.push({ cursor: String(cursor), options });
    const page = pages[Math.min(index, pages.length - 1)];
    index += 1;
    return { cursor: page.cursor, keys: page.keys };
  });
  return { scan, calls };
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetCacheForTests();
  process.env.REDIS_URL = "redis://fixture";
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.REDIS_URL;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe("cacheDelPattern SCAN invalidation", () => {
  it("never issues Redis KEYS and scans with a bounded COUNT", async () => {
    const matching = Array.from({ length: 250 }, (_, i) => `prompts:list:page-${i}`);
    const distractors = Array.from({ length: 400 }, (_, i) => `other:ns:${i}`);
    // Mixed keyspace: SCAN MATCH already filters; we still page results.
    const pages = [
      { cursor: "17", keys: [...matching.slice(0, 100), ...distractors.slice(0, 0)] },
      { cursor: "42", keys: matching.slice(100, 200) },
      { cursor: "0", keys: matching.slice(200) },
    ];
    const { scan, calls } = scanSequence(pages);
    const client = redisClient({
      scan,
      del: jest.fn().mockImplementation(async (keys: string[]) => keys.length),
    });
    createClient.mockReturnValue(client);

    await cacheDelPattern("prompts:list:*");

    expect(client.keys).not.toHaveBeenCalled();
    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(call.options.MATCH).toBe("prompts:list:*");
      expect(call.options.COUNT).toBe(SCAN_BATCH_SIZE);
      expect(call.options.COUNT).toBeLessThanOrEqual(100);
    }
    expect(calls[0].cursor).toBe("0");

    const deleted = (client.del as jest.Mock).mock.calls.flatMap((args) => args[0] as string[]);
    expect(deleted).toHaveLength(250);
    expect(deleted.every((key) => key.startsWith("prompts:list:"))).toBe(true);
    expect(deleted.some((key) => key.startsWith("other:ns:"))).toBe(false);

    for (const args of (client.del as jest.Mock).mock.calls) {
      expect((args[0] as string[]).length).toBeLessThanOrEqual(DELETE_BATCH_SIZE);
    }

    const metrics = __lastInvalidationMetricsForTests();
    expect(metrics).toMatchObject({
      pattern: "prompts:list:*",
      scannedKeys: 250,
      deletedKeys: 250,
      scanBatches: 3,
      failures: 0,
    });
    expect(metrics!.durationMs).toBeGreaterThanOrEqual(0);
    expect(console.info).toHaveBeenCalledWith(
      "[cache] invalidate",
      expect.objectContaining({
        pattern: "prompts:list:*",
        scannedKeys: 250,
        deletedKeys: 250,
        scanBatches: 3,
        failures: 0,
      }),
    );
  });

  it("records partial delete failures and continues remaining SCAN hops", async () => {
    const pages = [
      { cursor: "9", keys: ["prompts:list:a", "prompts:list:b"] },
      { cursor: "0", keys: ["prompts:list:c"] },
    ];
    const { scan } = scanSequence(pages);
    const del = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("READONLY"), { code: "READONLY" }))
      .mockResolvedValueOnce(1);
    const client = redisClient({ scan, del });
    createClient.mockReturnValue(client);

    await cacheDelPattern("prompts:list:*");

    expect(del).toHaveBeenCalledTimes(2);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(client.destroy).not.toHaveBeenCalled();

    const metrics = __lastInvalidationMetricsForTests();
    expect(metrics).toMatchObject({
      pattern: "prompts:list:*",
      scannedKeys: 3,
      deletedKeys: 1,
      scanBatches: 2,
      failures: 1,
    });
    expect(console.warn).toHaveBeenCalledWith(
      "[cache] invalidate batch failed",
      expect.objectContaining({ pattern: "prompts:list:*", code: "READONLY" }),
    );
  });

  it("bounds a stalled SCAN hop and marks the cache unavailable", async () => {
    jest.useFakeTimers();
    const client = redisClient({
      scan: jest.fn(() => new Promise<{ cursor: string; keys: string[] }>(() => undefined)),
    });
    createClient.mockReturnValue(client);

    const done = cacheDelPattern("prompts:list:*");
    await jest.advanceTimersByTimeAsync(251);
    await done;

    expect(console.warn).toHaveBeenCalledWith("[cache] unavailable", {
      operation: "scan",
      status: "unavailable",
      code: "CACHE_TIMEOUT",
    });
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(__lastInvalidationMetricsForTests()?.failures).toBeGreaterThanOrEqual(1);

    // Unrelated reads after the cooldown recover with a fresh client.
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 2_000);
    const recovered = redisClient({ get: jest.fn().mockResolvedValue("ok") });
    createClient.mockReturnValue(recovered);
    await expect(cacheRead("unrelated")).resolves.toEqual({ status: "hit", value: "ok" });
  });

  it("keeps concurrent writes readable via generation fencing during invalidation", async () => {
    const scanStarted = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    })();

    const client = redisClient({
      scan: jest.fn(async () => {
        scanStarted.resolve();
        await new Promise<void>((r) => setImmediate(r));
        return { cursor: "0", keys: ["prompts:list:all"] };
      }),
      del: jest.fn().mockResolvedValue(1),
      get: jest.fn().mockResolvedValue(null),
    });
    createClient.mockReturnValue(client);

    const stale = (() => {
      let resolve!: (value: { id: number }[]) => void;
      const promise = new Promise<{ id: number }[]>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    })();
    const fresh = (() => {
      let resolve!: (value: { id: number }[]) => void;
      const promise = new Promise<{ id: number }[]>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    })();

    const first = cacheGetOrLoad("prompts:list:all", () => stale.promise);
    await new Promise<void>((r) => setImmediate(r));

    const invalidation = cacheDelPattern("prompts:list:*");
    await scanStarted.promise;

    const second = cacheGetOrLoad("prompts:list:all", () => fresh.promise);
    await new Promise<void>((r) => setImmediate(r));

    stale.resolve([{ id: 1 }]);
    fresh.resolve([{ id: 2 }]);
    await expect(first).resolves.toEqual([{ id: 1 }]);
    await expect(second).resolves.toEqual([{ id: 2 }]);
    await invalidation;

    // Only the post-invalidation generation may write.
    expect(client.set).toHaveBeenCalledTimes(1);
    expect(client.set).toHaveBeenCalledWith(
      "prompts:list:all",
      '[{"id":2}]',
      { EX: 60 },
    );
  });

  it("does not call Redis when REDIS_URL is unset but still bumps generation", async () => {
    delete process.env.REDIS_URL;
    const client = redisClient();
    createClient.mockReturnValue(client);

    await cacheDelPattern("prompts:list:*");
    expect(createClient).not.toHaveBeenCalled();

    process.env.REDIS_URL = "redis://fixture";
    createClient.mockReturnValue(client);
    const loader = jest.fn().mockResolvedValue([{ id: 9 }]);
    await expect(cacheGetOrLoad("prompts:list:all", loader)).resolves.toEqual([{ id: 9 }]);
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
