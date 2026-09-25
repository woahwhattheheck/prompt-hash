import { afterEach, describe, expect, it } from "vitest";
import {
  advanceCursorToTip,
  backfillFromCursor,
  buildFeedFromCursor,
  emptyCursor,
  eventsAfterCursor,
  markAllReadInFeed,
  markNotificationsRead,
  reconcileEvents,
} from "./sellerNotificationCursor";
import {
  appendSellerEvent,
  configureSellerNotificationRepository,
  createMemorySellerNotificationRepository,
  getSellerFeed,
  markAllSellerNotificationsRead,
  markSellerNotificationsRead,
  resetSellerNotificationStore,
} from "./sellerNotificationStore";
import { makeSellerEvent } from "./sellerNotifications";
import { createFileSellerNotificationRepository } from "./fileSellerNotificationRepository";
import fs from "fs";
import os from "os";
import path from "path";

const WALLET = "GSELLERWALLETEXAMPLE";
const OTHER = "GBUYERWALLETEXAMPLE";

function sale(ledger: number, tx = `tx-sale-${ledger}`, eventIndex = 0) {
  return makeSellerEvent({
    network: "testnet",
    contract: "CPROMPT",
    ledger,
    transaction: tx,
    eventIndex,
    topic: "PromptPurchased",
    wallet: WALLET,
    promptId: "1",
    title: "Prompt 1",
    createdAt: 1_700_000_000_000 + ledger,
    buyer: OTHER,
  });
}

function status(ledger: number, active: boolean, tx = `tx-status-${ledger}`) {
  return makeSellerEvent({
    network: "testnet",
    contract: "CPROMPT",
    ledger,
    transaction: tx,
    eventIndex: 0,
    topic: "PromptSaleStatusUpdated",
    wallet: WALLET,
    promptId: "1",
    title: "Prompt 1",
    createdAt: 1_700_000_000_000 + ledger,
    active,
  });
}

function price(ledger: number, priceStroops: string, tx = `tx-price-${ledger}`) {
  return makeSellerEvent({
    network: "testnet",
    contract: "CPROMPT",
    ledger,
    transaction: tx,
    eventIndex: 0,
    topic: "PromptPriceUpdated",
    wallet: WALLET,
    promptId: "1",
    title: "Prompt 1",
    createdAt: 1_700_000_000_000 + ledger,
    priceStroops,
  });
}

afterEach(async () => {
  configureSellerNotificationRepository(null);
});

describe("reconcileEvents / deterministic feed", () => {
  it("backfill from a cursor produces the same feed deterministically", () => {
    const events = [sale(10), sale(11, "tx-b"), status(12, false), price(13, "2000")];
    const cursor = emptyCursor(WALLET);
    const a = buildFeedFromCursor(events, cursor);
    const b = backfillFromCursor(events, cursor);
    expect(a.notifications.map((n) => n.id)).toEqual(b.notifications.map((n) => n.id));
    expect(a.notifications.map((n) => n.id)).toEqual(
      buildFeedFromCursor(events, cursor).notifications.map((n) => n.id),
    );
  });

  it("notification ids come from indexed event ids", () => {
    const event = sale(5);
    const feed = buildFeedFromCursor([event], emptyCursor(WALLET));
    expect(feed.notifications[0].id).toBe(`notif:${event.eventId}`);
    expect(feed.notifications[0].eventId).toBe(event.eventId);
  });
});

describe("missed polls", () => {
  it("surfaces all events that arrived while polls were missed", () => {
    const first = [sale(1)];
    let cursor = advanceCursorToTip(first, emptyCursor(WALLET));
    // Missed polls: ledgers 2..4 arrive without intermediate advances.
    const all = [...first, sale(2), sale(3, "tx-3"), status(4, false)];
    const afterGap = eventsAfterCursor(all, cursor.cursorEventId);
    expect(afterGap).toHaveLength(3);
    const feed = buildFeedFromCursor(all, cursor);
    expect(feed.notifications).toHaveLength(4);
    expect(feed.unreadCount).toBe(4);
  });
});

describe("storage clearing / cursor recovery", () => {
  it("rebuilds the full feed when cursor is wiped (localStorage clear)", () => {
    const events = [sale(1), sale(2, "tx-2"), price(3, "1500")];
    const advanced = advanceCursorToTip(events, emptyCursor(WALLET));
    expect(advanced.cursorEventId).toBeTruthy();

    // Simulate cleared browser state → null cursor on a new device/session.
    const recovered = emptyCursor(WALLET);
    const feed = backfillFromCursor(events, recovered);
    expect(feed.notifications).toHaveLength(3);
    expect(feed.notifications.map((n) => n.eventId).sort()).toEqual(
      events.map((e) => e.eventId).sort(),
    );
  });

  it("recovers when cursor points at an unknown / reorged-away event id", () => {
    const events = [sale(1), sale(2, "tx-2")];
    const ghost = emptyCursor(WALLET);
    ghost.cursorEventId = "testnet:CPROMPT:999:ghost:0:prompt-hash:v1";
    const after = eventsAfterCursor(events, ghost.cursorEventId);
    expect(after).toHaveLength(2);
  });
});

describe("two devices", () => {
  it("shares durable cursor and read state across devices", async () => {
    const repo = createMemorySellerNotificationRepository();
    configureSellerNotificationRepository(repo);

    await appendSellerEvent(sale(1));
    await appendSellerEvent(sale(2, "tx-2"));

    // Device A loads feed and marks all read.
    const deviceA = await getSellerFeed(WALLET);
    expect(deviceA.unreadCount).toBe(2);
    await markAllSellerNotificationsRead(WALLET);

    // Device B sees the same read state (no localStorage).
    const deviceB = await getSellerFeed(WALLET);
    expect(deviceB.unreadCount).toBe(0);
    expect(deviceB.notifications.every((n) => n.read)).toBe(true);

    // Device B advances cursor; Device A agrees on tip.
    const advanced = await getSellerFeed(WALLET, { advance: true });
    const again = await getSellerFeed(WALLET);
    expect(again.cursor.cursorEventId).toBe(advanced.cursor.cursorEventId);
  });
});

describe("duplicate events", () => {
  it("ignores duplicate event delivery by eventId", async () => {
    const repo = createMemorySellerNotificationRepository();
    configureSellerNotificationRepository(repo);
    const event = sale(7);
    const first = await appendSellerEvent(event);
    const second = await appendSellerEvent(event);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await repo.countEvents()).toBe(1);

    const feed = await getSellerFeed(WALLET);
    expect(feed.notifications).toHaveLength(1);
  });

  it("reconcile drops duplicate logical rows keeping the newest", () => {
    const older = status(10, true, "tx-old");
    const newer = status(11, false, "tx-new"); // same logicalKey listing-active:1
    const reconciled = reconcileEvents([older, newer]);
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].eventId).toBe(newer.eventId);
    expect(reconciled[0].active).toBe(false);
  });
});

describe("reorg / correction", () => {
  it("explicit correctionOf tombstones the prior event", () => {
    const original = sale(20, "tx-reorged");
    const correction = {
      ...sale(21, "tx-correction"),
      correctionOf: original.eventId,
      logicalKey: original.logicalKey,
    };
    const reconciled = reconcileEvents([original, correction]);
    expect(reconciled.map((e) => e.eventId)).toEqual([correction.eventId]);
    const feed = buildFeedFromCursor([original, correction], emptyCursor(WALLET));
    expect(feed.notifications).toHaveLength(1);
    expect(feed.notifications[0].eventId).toBe(correction.eventId);
  });

  it("sales-count style correction does not duplicate when same purchase tx re-delivered", () => {
    const purchase = sale(30, "tx-same");
    const again = sale(30, "tx-same"); // identical eventId
    expect(purchase.eventId).toBe(again.eventId);
    const reconciled = reconcileEvents([purchase, again]);
    expect(reconciled).toHaveLength(1);
  });
});

describe("cursor recovery after interrupted advance", () => {
  it("re-running advance after a crash is idempotent", async () => {
    const repo = createMemorySellerNotificationRepository();
    configureSellerNotificationRepository(repo);
    await appendSellerEvent(sale(1));
    await appendSellerEvent(sale(2, "tx-2"));

    const first = await getSellerFeed(WALLET, { advance: true });
    const second = await getSellerFeed(WALLET, { advance: true });
    expect(first.cursor.cursorEventId).toBe(second.cursor.cursorEventId);
    expect(second.cursor.lastLedger).toBe(2);
  });

  it("mark-read is additive and durable", async () => {
    const repo = createMemorySellerNotificationRepository();
    configureSellerNotificationRepository(repo);
    const a = sale(1);
    const b = sale(2, "tx-2");
    await appendSellerEvent(a);
    await appendSellerEvent(b);
    const feed = await getSellerFeed(WALLET);
    await markSellerNotificationsRead(WALLET, [feed.notifications[0].id]);
    const next = await getSellerFeed(WALLET);
    expect(next.unreadCount).toBe(1);
    expect(next.notifications.filter((n) => n.read)).toHaveLength(1);
  });
});

describe("file-backed durability (restart)", () => {
  it("survives process restart via file store", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seller-notif-"));
    const filePath = path.join(dir, "store.json");
    const repo1 = createFileSellerNotificationRepository(filePath);
    configureSellerNotificationRepository(repo1);
    await appendSellerEvent(sale(40));
    await markAllSellerNotificationsRead(WALLET);
    const tip = await getSellerFeed(WALLET, { advance: true });

    // "Restart": new repository instance on the same path.
    const repo2 = createFileSellerNotificationRepository(filePath);
    configureSellerNotificationRepository(repo2);
    const reloaded = await getSellerFeed(WALLET);
    expect(reloaded.cursor.cursorEventId).toBe(tip.cursor.cursorEventId);
    expect(reloaded.unreadCount).toBe(0);
    expect(reloaded.notifications).toHaveLength(1);

    await resetSellerNotificationStore();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("mark helpers", () => {
  it("markNotificationsRead / markAllReadInFeed update the read set", () => {
    const events = [sale(1), sale(2, "tx-2")];
    let cursor = emptyCursor(WALLET);
    const feed = buildFeedFromCursor(events, cursor);
    cursor = markNotificationsRead(cursor, [feed.notifications[0].id]);
    const partial = buildFeedFromCursor(events, cursor);
    expect(partial.unreadCount).toBe(1);
    cursor = markAllReadInFeed(cursor, partial);
    expect(buildFeedFromCursor(events, cursor).unreadCount).toBe(0);
  });
});
