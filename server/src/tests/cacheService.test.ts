const createClient = jest.fn();

jest.mock("redis", () => ({
  createClient: (...args: unknown[]) => createClient(...args),
}));

import {
  __resetCacheForTests,
  CACHE_KEYS,
  cacheDel,
  cacheDelPattern,
  cacheGetOrLoad,
  cacheRead,
  cacheSet,
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
    await expect(cacheRead("key")).resolves.toEqual({
      status: "bypass",
      value: null,
    });

    process.env.REDIS_URL = "redis://fixture";
    const client = redisClient({
      get: jest.fn().mockResolvedValueOnce(null).mockResolvedValue("v"),
    });
    createClient.mockReturnValue(client);

    await expect(cacheRead("key")).resolves.toEqual({
      status: "miss",
      value: null,
    });
    await expect(cacheRead("key")).resolves.toEqual({
      status: "hit",
      value: "v",
    });
  });

  it("reports a failed connection safely and recovers with a fresh client", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(10_000);
    const failure = Object.assign(new Error("sentinel-secret"), {
      code: "ECONNREFUSED",
    });
    const failedClient = redisClient({
      connect: jest.fn().mockRejectedValue(failure),
    });
    const recoveredClient = redisClient({
      get: jest.fn().mockResolvedValue("recovered"),
    });
    createClient
      .mockReturnValueOnce(failedClient)
      .mockReturnValueOnce(recoveredClient);

    await expect(cacheRead("key")).resolves.toEqual({
      status: "unavailable",
      value: null,
    });
    expect(console.warn).toHaveBeenCalledWith("[cache] unavailable", {
      operation: "connect",
      status: "unavailable",
      code: "ECONNREFUSED",
    });
    expect(
      JSON.stringify((console.warn as jest.Mock).mock.calls),
    ).not.toContain("sentinel-secret");
    expect(failedClient.destroy).toHaveBeenCalledTimes(1);

    now.mockReturnValue(11_001);
    await expect(cacheRead("key")).resolves.toEqual({
      status: "hit",
      value: "recovered",
    });
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it("bounds a stalled command and marks the cache unavailable", async () => {
    jest.useFakeTimers();
    const client = redisClient({
      get: jest.fn(() => new Promise<string>(() => undefined)),
    });
    createClient.mockReturnValue(client);

    const result = cacheRead("key");
    await jest.advanceTimersByTimeAsync(251);

    await expect(result).resolves.toEqual({
      status: "unavailable",
      value: null,
    });
    expect(console.warn).toHaveBeenCalledWith("[cache] unavailable", {
      operation: "get",
      status: "unavailable",
      code: "CACHE_TIMEOUT",
    });
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it("single-flights concurrent fallback loads during an outage", async () => {
    const client = redisClient({
      get: jest.fn().mockRejectedValue(new Error("offline")),
    });
    createClient.mockReturnValue(client);
    const loaded = deferred<{ id: number }[]>();
    const loader = jest.fn(() => loaded.promise);

    const first = cacheGetOrLoad("list", loader);
    const second = cacheGetOrLoad("list", loader);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(loader).toHaveBeenCalledTimes(1);
    loaded.resolve([{ id: 1 }]);
    await expect(Promise.all([first, second])).resolves.toEqual([
      [{ id: 1 }],
      [{ id: 1 }],
    ]);
  });

  it.each([
    { pattern: "*", suffix: "a", other: "a", otherNamespace: "search" },
    { pattern: "a*b?c", suffix: "axxbyc", other: "axxbzzc" },
    { pattern: "?", suffix: "a", other: "ab" },
    { pattern: "[ab]", suffix: "a", other: "c" },
    { pattern: "[c-a]", suffix: "b", other: "d" },
    { pattern: "[a-é]", suffix: "0", other: "b" },
    { pattern: "[^a-c]", suffix: "d", other: "b" },
    { pattern: "\\*", suffix: "*", other: "a" },
    { pattern: "[\\]]", suffix: "]", other: "a" },
    { pattern: "\\", suffix: "\\", other: "a" },
    { pattern: "??", suffix: "é", other: "a" },
  ])(
    "fences Redis glob $pattern matches without invalidating unrelated loads",
    async ({ pattern, suffix, other, otherNamespace = "detail" }) => {
      const client = redisClient();
      createClient.mockReturnValue(client);
      const key = `prompts:detail:${suffix}`;
      const unrelatedKey = `prompts:${otherNamespace}:${other}`;
      const stale = deferred<number>();
      const fresh = deferred<number>();
      const unrelated = deferred<number>();
      const freshLoader = jest.fn(() => fresh.promise);
      const unrelatedLoader = jest.fn(() => unrelated.promise);

      const first = cacheGetOrLoad(key, () => stale.promise);
      const otherFirst = cacheGetOrLoad(unrelatedKey, unrelatedLoader);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await cacheDelPattern(`prompts:detail:${pattern}`);
      const second = cacheGetOrLoad(key, freshLoader);
      const otherAgain = cacheGetOrLoad(unrelatedKey, unrelatedLoader);
      await new Promise<void>((resolve) => setImmediate(resolve));

      stale.resolve(1);
      fresh.resolve(2);
      unrelated.resolve(3);
      await expect(
        Promise.all([first, second, otherFirst, otherAgain]),
      ).resolves.toEqual([1, 2, 3, 3]);
      expect(freshLoader).toHaveBeenCalledTimes(1);
      expect(unrelatedLoader).toHaveBeenCalledTimes(1);
      expect(client.set).toHaveBeenCalledTimes(2);
      expect(client.set).toHaveBeenCalledWith(key, "2", { EX: 60 });
      expect(client.set).toHaveBeenCalledWith(unrelatedKey, "3", { EX: 60 });
    },
  );

  it.each([
    { label: "LF", separator: "\n" },
    { label: "CR", separator: "\r" },
    { label: "U+2028", separator: "\u2028" },
    { label: "U+2029", separator: "\u2029" },
  ])(
    "fences decoded $label in list query keys without invalidating search loads",
    async ({ separator }) => {
      const client = redisClient();
      createClient.mockReturnValue(client);
      const url = new URL(
        `https://local.invalid/api/prompts?walletAddress=${encodeURIComponent(`local${separator}wallet`)}`,
      );
      const query = `cat=&wallet=${url.searchParams.get("walletAddress")}`;
      const key = CACHE_KEYS.promptList(query);
      const unrelatedKey = CACHE_KEYS.promptSearch(query);
      const stale = deferred<number>();
      const fresh = deferred<number>();
      const unrelated = deferred<number>();
      const freshLoader = jest.fn(() => fresh.promise);
      const unrelatedLoader = jest.fn(() => unrelated.promise);

      const first = cacheGetOrLoad(key, () => stale.promise);
      const other = cacheGetOrLoad(unrelatedKey, unrelatedLoader);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await cacheDelPattern("prompts:list:*");
      const second = cacheGetOrLoad(key, freshLoader);
      const otherAgain = cacheGetOrLoad(unrelatedKey, unrelatedLoader);
      await new Promise<void>((resolve) => setImmediate(resolve));

      stale.resolve(1);
      fresh.resolve(2);
      unrelated.resolve(3);
      const values = await Promise.all([first, second, other, otherAgain]);
      expect(freshLoader).toHaveBeenCalledTimes(1);
      expect(unrelatedLoader).toHaveBeenCalledTimes(1);
      expect(values).toEqual([1, 2, 3, 3]);
      expect(client.set).toHaveBeenCalledTimes(2);
      expect(client.set).toHaveBeenCalledWith(key, "2", { EX: 60 });
      expect(client.set).toHaveBeenCalledWith(unrelatedKey, "3", { EX: 60 });
    },
  );

  it("returns parsed cached values without invoking the loader", async () => {
    const client = redisClient({
      get: jest.fn().mockResolvedValue('[{"id":2}]'),
    });
    createClient.mockReturnValue(client);
    const loader = jest.fn().mockResolvedValue([{ id: 3 }]);

    await expect(cacheGetOrLoad("list", loader)).resolves.toEqual([{ id: 2 }]);
    expect(loader).not.toHaveBeenCalled();
  });

  it("keeps a replacement load shared after an invalidated exact-key load settles", async () => {
    const client = redisClient();
    createClient.mockReturnValue(client);
    const key = "prompts:detail:17";
    const stale = deferred<number>();
    const fresh = deferred<number>();
    const freshLoader = jest.fn(() => fresh.promise);

    const first = cacheGetOrLoad(key, () => stale.promise);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await cacheDel(key);
    const second = cacheGetOrLoad(key, freshLoader);
    await new Promise<void>((resolve) => setImmediate(resolve));

    stale.resolve(1);
    await expect(first).resolves.toBe(1);
    const third = cacheGetOrLoad(key, freshLoader);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(freshLoader).toHaveBeenCalledTimes(1);

    fresh.resolve(2);
    await expect(Promise.all([second, third])).resolves.toEqual([2, 2]);
    expect(client.set).toHaveBeenCalledTimes(1);
    expect(client.set).toHaveBeenCalledWith(key, "2", { EX: 60 });
  });

  it("keeps older pattern-invalidated loads fenced after the newest load completes", async () => {
    const client = redisClient();
    createClient.mockReturnValue(client);
    const firstValue = deferred<number>();
    const secondValue = deferred<number>();
    const thirdValue = deferred<number>();
    const unrelatedValue = deferred<number>();
    const unrelatedLoader = jest.fn(() => unrelatedValue.promise);
    const key = "prompts:list:all";

    const first = cacheGetOrLoad(key, () => firstValue.promise);
    const unrelated = cacheGetOrLoad("prompts:detail:17", unrelatedLoader);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await cacheDelPattern("prompts:list:*");
    const second = cacheGetOrLoad(key, () => secondValue.promise);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await cacheDelPattern("prompts:list:*");
    const third = cacheGetOrLoad(key, () => thirdValue.promise);
    const unrelatedAgain = cacheGetOrLoad("prompts:detail:17", unrelatedLoader);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unrelatedLoader).toHaveBeenCalledTimes(1);

    thirdValue.resolve(3);
    await expect(third).resolves.toBe(3);
    secondValue.resolve(2);
    firstValue.resolve(1);
    unrelatedValue.resolve(4);
    await expect(
      Promise.all([first, second, unrelated, unrelatedAgain]),
    ).resolves.toEqual([1, 2, 4, 4]);
    expect(client.set).toHaveBeenCalledTimes(2);
    expect(client.set).toHaveBeenCalledWith(key, "3", { EX: 60 });
    expect(client.set).toHaveBeenCalledWith("prompts:detail:17", "4", {
      EX: 60,
    });
  });

  it.each(["key", "pattern"])(
    "fences synchronous %s invalidation inside the loader",
    async (kind) => {
      const client = redisClient();
      createClient.mockReturnValue(client);
      const key = "prompts:list:all";
      let invalidation: Promise<void> | undefined;
      const result = cacheGetOrLoad(key, () => {
        invalidation =
          kind === "key" ? cacheDel(key) : cacheDelPattern("prompts:list:*");
        return Promise.resolve(1);
      });

      await expect(result).resolves.toBe(1);
      await invalidation;
      expect(client.set).not.toHaveBeenCalled();
    },
  );

  it.each(["key", "pattern"])(
    "fences %s invalidation while a completed load reconnects before writing",
    async (kind) => {
      const now = jest.spyOn(Date, "now").mockReturnValue(10_000);
      const connection = deferred<void>();
      const firstClient = redisClient();
      const recoveredClient = redisClient({
        connect: jest.fn(() => connection.promise),
      });
      createClient
        .mockReturnValueOnce(firstClient)
        .mockReturnValue(recoveredClient);
      const key = "prompts:list:all";
      const loaded = deferred<number>();
      const first = cacheGetOrLoad(key, () => loaded.promise);
      await new Promise<void>((resolve) => setImmediate(resolve));

      const onError = firstClient.on.mock.calls.find(
        ([event]) => event === "error",
      )![1];
      onError(new Error("connection closed"));
      now.mockReturnValue(11_001);
      loaded.resolve(1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(recoveredClient.connect).toHaveBeenCalledTimes(1);

      // The loader has passed its first flag check and is awaiting reconnect.
      const invalidation =
        kind === "key" ? cacheDel(key) : cacheDelPattern("prompts:list:*");
      connection.resolve();
      await expect(first).resolves.toBe(1);
      await invalidation;
      expect(recoveredClient.set).not.toHaveBeenCalled();

      await expect(
        cacheGetOrLoad(key, () => Promise.resolve(2), 23),
      ).resolves.toBe(2);
      expect(recoveredClient.set).toHaveBeenCalledTimes(1);
      expect(recoveredClient.set).toHaveBeenCalledWith(key, "2", { EX: 23 });
      await cacheSet("direct", "3", 17);
      expect(recoveredClient.set).toHaveBeenCalledTimes(2);
      expect(recoveredClient.set).toHaveBeenCalledWith("direct", "3", {
        EX: 17,
      });
    },
  );

  it("releases rejected shared loads so the next caller can retry", async () => {
    const client = redisClient();
    createClient.mockReturnValue(client);
    const failedValue = deferred<number>();
    const loader = jest.fn(() => failedValue.promise);
    const first = cacheGetOrLoad("prompts:detail:17", loader);
    const second = cacheGetOrLoad("prompts:detail:17", loader);
    const settled = Promise.allSettled([first, second]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(loader).toHaveBeenCalledTimes(1);
    failedValue.reject(new Error("source unavailable"));
    expect((await settled).map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);

    await expect(
      cacheGetOrLoad("prompts:detail:17", () => Promise.resolve(2)),
    ).resolves.toBe(2);
    expect(client.set).toHaveBeenCalledTimes(1);
    expect(client.set).toHaveBeenCalledWith("prompts:detail:17", "2", {
      EX: 60,
    });
  });
});
