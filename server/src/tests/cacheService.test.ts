const createClient = jest.fn();

jest.mock("redis", () => ({
  createClient: (...args: unknown[]) => createClient(...args),
}));

import {
  __resetCacheForTests,
  cacheDelPattern,
  cacheGetOrLoad,
  cacheRead,
} from "../services/cacheService";

function deferred<T>() {
  // The repository's base ESLint rule misclassifies names in function types.
  // eslint-disable-next-line no-unused-vars
  let resolve!: (value: T) => void;
  // eslint-disable-next-line no-unused-vars
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

beforeEach(() => {
  jest.clearAllMocks();
  __resetCacheForTests();
  process.env.REDIS_URL = "redis://fixture";
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.REDIS_URL;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe("cache reliability", () => {
  it("serializes concurrent cold initialization", async () => {
    const connection = deferred<void>();
    const client = redisClient({
      connect: jest.fn(() => connection.promise),
      get: jest.fn().mockResolvedValue("cached"),
    });
    createClient.mockReturnValue(client);

    const first = cacheRead("prompt-list");
    const second = cacheRead("prompt-list");
    await Promise.resolve();

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledTimes(1);

    connection.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "hit", value: "cached" },
      { status: "hit", value: "cached" },
    ]);
  });

  it("distinguishes bypass, miss, and hit outcomes", async () => {
    delete process.env.REDIS_URL;
    await expect(cacheRead("key")).resolves.toEqual({ status: "bypass", value: null });

    process.env.REDIS_URL = "redis://fixture";
    const client = redisClient({ get: jest.fn().mockResolvedValueOnce(null).mockResolvedValue("v") });
    createClient.mockReturnValue(client);

    await expect(cacheRead("key")).resolves.toEqual({ status: "miss", value: null });
    await expect(cacheRead("key")).resolves.toEqual({ status: "hit", value: "v" });
  });

  it("reports a failed connection safely and recovers with a fresh client", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(10_000);
    const failure = Object.assign(new Error("sentinel-secret"), { code: "ECONNREFUSED" });
    const failedClient = redisClient({ connect: jest.fn().mockRejectedValue(failure) });
    const recoveredClient = redisClient({ get: jest.fn().mockResolvedValue("recovered") });
    createClient.mockReturnValueOnce(failedClient).mockReturnValueOnce(recoveredClient);

    await expect(cacheRead("key")).resolves.toEqual({ status: "unavailable", value: null });
    expect(console.warn).toHaveBeenCalledWith("[cache] unavailable", {
      operation: "connect",
      status: "unavailable",
      code: "ECONNREFUSED",
    });
    expect(JSON.stringify((console.warn as jest.Mock).mock.calls)).not.toContain("sentinel-secret");
    expect(failedClient.destroy).toHaveBeenCalledTimes(1);

    now.mockReturnValue(11_001);
    await expect(cacheRead("key")).resolves.toEqual({ status: "hit", value: "recovered" });
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it("bounds a stalled command and marks the cache unavailable", async () => {
    jest.useFakeTimers();
    const client = redisClient({ get: jest.fn(() => new Promise<string>(() => undefined)) });
    createClient.mockReturnValue(client);

    const result = cacheRead("key");
    await jest.advanceTimersByTimeAsync(251);

    await expect(result).resolves.toEqual({ status: "unavailable", value: null });
    expect(console.warn).toHaveBeenCalledWith("[cache] unavailable", {
      operation: "get",
      status: "unavailable",
      code: "CACHE_TIMEOUT",
    });
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it("single-flights concurrent fallback loads during an outage", async () => {
    const client = redisClient({ get: jest.fn().mockRejectedValue(new Error("offline")) });
    createClient.mockReturnValue(client);
    const loaded = deferred<{ id: number }[]>();
    const loader = jest.fn(() => loaded.promise);

    const first = cacheGetOrLoad("list", loader);
    const second = cacheGetOrLoad("list", loader);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(loader).toHaveBeenCalledTimes(1);
    loaded.resolve([{ id: 1 }]);
    await expect(Promise.all([first, second])).resolves.toEqual([[{ id: 1 }], [{ id: 1 }]]);
  });

  it("fences an in-flight load when its key pattern is invalidated", async () => {
    const client = redisClient();
    createClient.mockReturnValue(client);
    const stale = deferred<{ id: number }[]>();
    const fresh = deferred<{ id: number }[]>();
    const staleLoader = jest.fn(() => stale.promise);
    const freshLoader = jest.fn(() => fresh.promise);

    const first = cacheGetOrLoad("prompts:list:all", staleLoader);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await cacheDelPattern("prompts:list:*");
    const second = cacheGetOrLoad("prompts:list:all", freshLoader);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(staleLoader).toHaveBeenCalledTimes(1);
    expect(freshLoader).toHaveBeenCalledTimes(1);

    stale.resolve([{ id: 1 }]);
    fresh.resolve([{ id: 2 }]);
    await expect(first).resolves.toEqual([{ id: 1 }]);
    await expect(second).resolves.toEqual([{ id: 2 }]);
    expect(client.set).toHaveBeenCalledTimes(1);
    expect(client.set).toHaveBeenCalledWith(
      "prompts:list:all",
      '[{"id":2}]',
      { EX: 60 },
    );
  });

  it("returns parsed cached values without invoking the loader", async () => {
    const client = redisClient({ get: jest.fn().mockResolvedValue('[{"id":2}]') });
    createClient.mockReturnValue(client);
    const loader = jest.fn().mockResolvedValue([{ id: 3 }]);

    await expect(cacheGetOrLoad("list", loader)).resolves.toEqual([{ id: 2 }]);
    expect(loader).not.toHaveBeenCalled();
  });
});
