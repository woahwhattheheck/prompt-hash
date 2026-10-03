// Run from server/: node --expose-gc -r ts-node/register scripts/benchmarkCacheInvalidation.cjs
// Measures the actual service's in-process work with Redis disabled. No provider calls.
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { performance } = require("node:perf_hooks");
const cache = require("../src/services/cacheService");

const historyCount = Number(process.argv[2] ?? 100_000);
const loadCount = Number(process.argv[3] ?? 20_000);
if (![historyCount, loadCount].every((n) => Number.isSafeInteger(n) && n > 0)) {
  throw new Error("history and load counts must be positive safe integers");
}
if (!global.gc) throw new Error("Run Node with --expose-gc to measure retained heap");

async function main() {
  // This process deliberately measures bookkeeping separately from Redis latency.
  delete process.env.REDIS_URL;
  const originalInfo = console.info;
  console.info = () => undefined;
  try {
    await cache.cacheDelPattern("prompts:list:*");
    await cache.cacheDelPattern("prompts:search:*");
    for (let i = 0; i < 5_000; i += 1) {
      await cache.cacheDel(cache.CACHE_KEYS.promptDetail(String(i)));
      await cache.cacheGetOrLoad("prompts:list:warmup", () => Promise.resolve(i));
    }
    cache.__resetCacheForTests();
    global.gc();
    const heapBefore = process.memoryUsage().heapUsed;

    const historyStart = performance.now();
    for (let i = 0; i < historyCount; i += 1) {
      await cache.cacheDel(cache.CACHE_KEYS.promptDetail(String(i)));
    }
    // These are the two pattern invalidations used by the current call sites.
    await cache.cacheDelPattern("prompts:list:*");
    await cache.cacheDelPattern("prompts:search:*");
    const historyMs = performance.now() - historyStart;
    global.gc();
    const retainedHistoryBytes = process.memoryUsage().heapUsed - heapBefore;

    let checksum = 0;
    const loadStart = performance.now();
    for (let i = 0; i < loadCount; i += 1) {
      checksum += await cache.cacheGetOrLoad(
        cache.CACHE_KEYS.promptDetail(String(i % historyCount)),
        () => Promise.resolve(i),
      );
    }
    const loadMs = performance.now() - loadStart;
    if (checksum !== (loadCount * (loadCount - 1)) / 2) {
      throw new Error("cache load results changed");
    }

    const patternMsByPending = [];
    for (const pendingCount of [0, 100, 1_000]) {
      cache.__resetCacheForTests();
      let release;
      const pendingValue = new Promise((resolve) => { release = resolve; });
      const pending = Array.from({ length: pendingCount }, (_, i) =>
        cache.cacheGetOrLoad(
          i % 2 ? cache.CACHE_KEYS.promptDetail(String(i)) : `prompts:list:${i}`,
          () => pendingValue,
        ),
      );
      await new Promise((resolve) => setImmediate(resolve));
      const patternStart = performance.now();
      await cache.cacheDelPattern("prompts:list:*");
      patternMsByPending.push({
        pendingCount,
        patternMs: performance.now() - patternStart,
      });
      release(1);
      await Promise.all(pending);
    }

    const source = readFileSync(join(__dirname, "../src/services/cacheService.ts"));
    process.stdout.write(`${JSON.stringify({
      node: process.version,
      mode: "redis-disabled-bookkeeping",
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      historyCount,
      loadCount,
      historyMs,
      retainedHistoryBytes,
      loadMs,
      checksum,
      patternMsByPending,
    })}\n`);
  } finally {
    console.info = originalInfo;
    cache.__resetCacheForTests();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
