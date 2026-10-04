import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  appendSellerEvent,
  configureSellerNotificationRepository,
  createMemorySellerNotificationRepository,
  getSellerFeed,
  getSellerNotificationRepository,
} from "./sellerNotificationStore";
import { makeSellerEvent } from "./sellerNotifications";

const mongo = vi.hoisted(() => ({
  connectDb: vi.fn(),
  createRepository: vi.fn(),
}));

// Exercise the real store entry points and file repository while controlling
// the external Mongo initialization boundary. No Mongo service is simulated.
vi.mock("../../../server/src/db/connectDb", () => ({
  default: mongo.connectDb,
}));
vi.mock("../../../server/src/models/SellerNotificationState", () => ({
  SellerNotificationEvent: {},
  SellerNotificationCursor: {},
}));
vi.mock("./mongoSellerNotificationRepository", () => ({
  createMongoSellerNotificationRepository: mongo.createRepository,
}));

function deferredConnection() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const event = makeSellerEvent({
  network: "testnet",
  contract: "CPROMPT",
  ledger: 42,
  transaction: "tx-configured-store",
  eventIndex: 0,
  topic: "PromptPurchased",
  wallet: "GSELLER",
  promptId: "1",
  title: "Prompt",
  createdAt: 1_700_000_000_000,
});

describe("configured seller notification backend", () => {
  let dir: string;
  let filePath: string;
  let mongoRepository: ReturnType<typeof createMemorySellerNotificationRepository>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seller-notif-backend-"));
    filePath = path.join(dir, "store.json");
    vi.stubEnv("SELLER_NOTIFICATION_STORE_PATH", filePath);
    vi.stubEnv("MONGODB_URI", "mongodb://configured.example/notifications");
    configureSellerNotificationRepository(null);
    mongo.connectDb.mockReset().mockResolvedValue(undefined);
    mongoRepository = createMemorySellerNotificationRepository();
    mongo.createRepository.mockReset().mockReturnValue(mongoRepository);
  });

  afterEach(() => {
    configureSellerNotificationRepository(null);
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects concurrent writes during Mongo failure, then retries and caches recovery", async () => {
    const connection = deferredConnection();
    const failure = new Error("configured Mongo unavailable");
    mongo.connectDb.mockReturnValueOnce(connection.promise);

    const attempts = Promise.allSettled([
      appendSellerEvent(event),
      appendSellerEvent(event),
    ]);
    await vi.waitFor(() => expect(mongo.connectDb).toHaveBeenCalledTimes(1));
    connection.reject(failure);
    const outcomes = await attempts;

    expect(outcomes).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(mongo.createRepository).not.toHaveBeenCalled();

    expect(await appendSellerEvent(event)).toEqual({ created: true, event });
    expect(await getSellerNotificationRepository()).toBe(mongoRepository);
    expect(await mongoRepository.getEvent(event.eventId)).toEqual(event);
    expect(mongo.connectDb).toHaveBeenCalledTimes(2);
    expect(mongo.createRepository).toHaveBeenCalledTimes(1);
  });

  it("does not let an older rejected initialization evict a newer pending one", async () => {
    const firstConnection = deferredConnection();
    const secondConnection = deferredConnection();
    const failure = new Error("old connection failed");
    mongo.connectDb
      .mockReturnValueOnce(firstConnection.promise)
      .mockReturnValueOnce(secondConnection.promise);

    const oldOutcome = Promise.allSettled([getSellerNotificationRepository()]);
    await vi.waitFor(() => expect(mongo.connectDb).toHaveBeenCalledTimes(1));
    configureSellerNotificationRepository(null);
    const current = getSellerNotificationRepository();
    await vi.waitFor(() => expect(mongo.connectDb).toHaveBeenCalledTimes(2));

    firstConnection.reject(failure);
    const settledOld = await oldOutcome;
    const another = getSellerNotificationRepository();
    secondConnection.resolve(undefined);
    const repositories = await Promise.all([current, another]);

    expect(settledOld).toEqual([{ status: "rejected", reason: failure }]);
    expect(repositories).toEqual([mongoRepository, mongoRepository]);
    expect(mongo.connectDb).toHaveBeenCalledTimes(2);
    expect(mongo.createRepository).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("keeps explicit repository injection ahead of configured Mongo", async () => {
    const injected = createMemorySellerNotificationRepository();
    configureSellerNotificationRepository(injected);

    expect(await appendSellerEvent(event)).toEqual({ created: true, event });
    expect(await injected.getEvent(event.eventId)).toEqual(event);
    expect(mongo.connectDb).not.toHaveBeenCalled();
    expect(mongo.createRepository).not.toHaveBeenCalled();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("retains persistent file mode when Mongo is not configured", async () => {
    vi.stubEnv("MONGODB_URI", "");
    expect(await appendSellerEvent(event)).toEqual({ created: true, event });
    expect(fs.existsSync(filePath)).toBe(true);

    configureSellerNotificationRepository(null);
    const feed = await getSellerFeed(event.wallet);
    expect(feed.notifications.map((notification) => notification.eventId)).toEqual([
      event.eventId,
    ]);
    expect(mongo.connectDb).not.toHaveBeenCalled();
    expect(mongo.createRepository).not.toHaveBeenCalled();
  });
});
