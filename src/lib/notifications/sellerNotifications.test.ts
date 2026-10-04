// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react/pure";
import { useSellerNotifications } from "../../hooks/useSellerNotifications";
import {
  deriveNotifications,
  mergeNotifications,
  snapshotOf,
  summariseActivity,
  type SellerNotification,
} from "./sellerNotifications";
import type { PromptRecord } from "@/lib/stellar/promptHashClient";

const walletHook = vi.hoisted(() => ({
  address: "GA" as string | null,
  feed: undefined as unknown,
  queryFn: undefined as undefined | (() => Promise<unknown>),
  fetchFeed: vi.fn(),
  postAction: vi.fn(),
}));

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({ address: walletHook.address }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: {
    queryKey: unknown[];
    queryFn: () => Promise<unknown>;
  }) => {
    if (options.queryKey[0] === "seller-notifications") {
      walletHook.queryFn = options.queryFn;
      return { data: walletHook.feed };
    }
    return { data: [] };
  },
}));
vi.mock("@/lib/stellar/browserConfig", () => ({ browserStellarConfig: {} }));
vi.mock("@/lib/stellar/promptHashClient", () => ({
  getPromptsByCreator: vi.fn(),
}));
vi.mock("./sellerNotificationClient", () => ({
  fetchSellerNotificationFeed: walletHook.fetchFeed,
  postSellerNotificationAction: walletHook.postAction,
}));

function makePrompt(
  overrides: Partial<PromptRecord> & { id: bigint },
): PromptRecord {
  return {
    creator: "GSELLER",
    priceStroops: 1000n,
    title: `Prompt ${overrides.id.toString()}`,
    category: "Development",
    previewText: "preview",
    imageUrl: "",
    salesCount: 0,
    active: true,
    contentHash: "hash",
    ...overrides,
  };
}

const NOW = 1_700_000_000_000;

describe("summariseActivity", () => {
  it("totals listings, active listings and sales", () => {
    const prompts = [
      makePrompt({ id: 1n, salesCount: 3, active: true }),
      makePrompt({ id: 2n, salesCount: 1, active: false }),
    ];
    expect(summariseActivity(prompts)).toEqual({
      totalListings: 2,
      activeListings: 1,
      totalSales: 4,
    });
  });
});

describe("legacy deriveNotifications (deprecated snapshot path)", () => {
  it("emits nothing on the first load (no previous snapshot)", () => {
    const prompts = [makePrompt({ id: 1n, salesCount: 5 })];
    expect(deriveNotifications(null, prompts, NOW)).toEqual([]);
  });

  it("detects new sales", () => {
    const previous = snapshotOf([makePrompt({ id: 1n, salesCount: 2 })]);
    const current = [makePrompt({ id: 1n, salesCount: 5 })];
    const result = deriveNotifications(previous, current, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("sale");
    expect(result[0].id).toBe("sale:1:5");
    expect(result[0].message).toContain("3 new sales");
  });

  it("detects delisting and price changes", () => {
    const previous = snapshotOf([
      makePrompt({ id: 1n, active: true, priceStroops: 1000n }),
    ]);
    const current = [makePrompt({ id: 1n, active: false, priceStroops: 2000n })];
    const result = deriveNotifications(previous, current, NOW);
    const ids = result.map((n) => n.id);
    expect(ids).toContain("listing-active:1:false");
    expect(ids).toContain("listing-price:1:2000");
  });

  it("ignores brand-new listings not present in the previous snapshot", () => {
    const previous = snapshotOf([makePrompt({ id: 1n, salesCount: 0 })]);
    const current = [
      makePrompt({ id: 1n, salesCount: 0 }),
      makePrompt({ id: 2n, salesCount: 9 }),
    ];
    expect(deriveNotifications(previous, current, NOW)).toEqual([]);
  });
});

describe("mergeNotifications", () => {
  const base: SellerNotification = {
    id: "sale:1:1",
    type: "sale",
    promptId: "1",
    title: "Prompt 1",
    message: "New sale",
    createdAt: NOW,
    read: false,
    eventId: "legacy:sale:1:1",
    logicalKey: "sale:1:legacy",
    ledger: 0,
  };

  it("prepends fresh notifications and drops duplicates by id", () => {
    const existing = [base];
    const incoming = [
      base, // duplicate id — ignored
      { ...base, id: "sale:1:2", message: "Another sale" },
    ];
    const merged = mergeNotifications(existing, incoming);
    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe("sale:1:2");
    expect(merged[1].id).toBe("sale:1:1");
  });
});

it("isolates seller alerts on wallet changes, late feeds and disconnect", async () => {
  const feed = (wallet: string, id: string) => ({
    wallet,
    notifications: [
      {
        id,
        type: "sale" as const,
        promptId: "1",
        title: "Prompt 1",
        message: "New sale",
        createdAt: NOW,
        read: false,
        eventId: id,
        logicalKey: id,
        ledger: 1,
      },
    ],
    unreadCount: 1,
    cursorEventId: id,
    lastLedger: 1,
  });
  const aFeed = feed("GA", "A");
  const bFeed = feed("GB", "B");
  walletHook.address = "GA";
  walletHook.feed = aFeed;
  walletHook.fetchFeed.mockReset();
  walletHook.postAction.mockReset().mockResolvedValue({});
  const renders: { wallet: string | null; ids: string[]; unread: number }[] = [];
  const { result, rerender } = renderHook(() => {
    const value = useSellerNotifications();
    renders.push({
      wallet: walletHook.address,
      ids: value.notifications.map((n) => n.id),
      unread: value.unreadCount,
    });
    return value;
  });

  try {
    expect(result.current.notifications.map((n) => n.id)).toEqual(["A"]);
    let resolveOldFeed!: (value: typeof aFeed) => void;
    walletHook.fetchFeed.mockImplementationOnce(
      () =>
        new Promise<typeof aFeed>((resolve) => {
          resolveOldFeed = resolve;
        }),
    );
    const query = walletHook.queryFn;
    if (!query) throw new Error("Seller query was not registered");
    const oldRequest = query();

    renders.length = 0;
    walletHook.address = "GB";
    walletHook.feed = undefined;
    rerender();
    expect(renders.length).toBeGreaterThan(0);
    expect(
      renders.every(
        (r) => r.wallet === "GB" && r.ids.length === 0 && r.unread === 0,
      ),
    ).toBe(true);

    walletHook.feed = bFeed;
    rerender();
    expect(result.current.notifications.map((n) => n.id)).toEqual(["B"]);
    expect(result.current.unreadCount).toBe(1);

    resolveOldFeed(aFeed);
    walletHook.feed = await oldRequest;
    renders.length = 0;
    rerender();
    expect(renders.every((r) => !r.ids.includes("A"))).toBe(true);

    walletHook.feed = bFeed;
    rerender();
    act(() => result.current.markAllRead());
    expect(result.current.notifications.every((n) => n.read)).toBe(true);
    expect(result.current.unreadCount).toBe(0);
    expect(walletHook.postAction).toHaveBeenLastCalledWith("GB", "mark-all-read");

    act(() => result.current.clearAll());
    expect(result.current.notifications).toEqual([]);
    expect(walletHook.postAction).toHaveBeenLastCalledWith("GB", "mark-all-read");

    walletHook.feed = feed("GB", "B");
    rerender();
    expect(result.current.notifications.map((n) => n.id)).toEqual(["B"]);
    renders.length = 0;
    walletHook.address = null;
    walletHook.feed = undefined;
    rerender();
    expect(
      renders.every(
        (r) => r.wallet === null && r.ids.length === 0 && r.unread === 0,
      ),
    ).toBe(true);
    act(() => {
      result.current.markAllRead();
      result.current.clearAll();
    });
    expect(walletHook.postAction).toHaveBeenCalledTimes(2);
  } finally {
    cleanup();
  }
});

describe("failed seller read acknowledgements", () => {
  function unreadFeed(wallet = "GA", id = "A") {
    return {
      wallet,
      notifications: [{
        id, type: "sale" as const, promptId: "1", title: "Prompt 1",
        message: "New sale", createdAt: NOW, read: false,
        eventId: id, logicalKey: id, ledger: 1,
      }],
      unreadCount: 1, cursorEventId: id, lastLedger: 1,
    };
  }

  function setup() {
    walletHook.address = "GA";
    walletHook.feed = unreadFeed();
    walletHook.postAction.mockReset().mockResolvedValue({});
    let reject!: (error: Error) => void;
    walletHook.postAction.mockImplementationOnce(() => new Promise((_, fail) => {
      reject = fail;
    }));
    return { ...renderHook(() => useSellerNotifications()), reject: () => reject(new Error("offline")) };
  }

  it.each(["markAllRead", "clearAll"] as const)(
    "restores the confirmed feed after rejected %s with unchanged query data",
    async (action) => {
      const { result, rerender, reject } = setup();
      try {
        act(() => result.current[action]());
        expect(result.current.unreadCount).toBe(0);
        await act(async () => reject());
        // Keep the exact query object, as with an unchanged cached poll.
        rerender();
        expect(result.current.notifications.map((n) => n.id)).toEqual(["A"]);
        expect(result.current.notifications[0].read).toBe(false);
        expect(result.current.unreadCount).toBe(1);
      } finally { cleanup(); }
    },
  );

  it.each(["wallet", "feed", "markAllRead", "clearAll", "disconnect"] as const)(
    "does not roll back newer %s state after an older rejection",
    async (transition) => {
      const { result, rerender, reject } = setup();
      try {
        act(() => result.current.markAllRead());
        if (transition === "wallet") {
          walletHook.address = "GB";
          walletHook.feed = unreadFeed("GB", "B");
          rerender();
        } else if (transition === "feed") {
          walletHook.feed = unreadFeed("GA", "new");
          rerender();
        } else if (transition === "disconnect") {
          walletHook.address = null;
          walletHook.feed = undefined;
          rerender();
        } else {
          await act(async () => result.current[transition]());
        }
        const notifications = result.current.notifications;
        const unreadCount = result.current.unreadCount;
        await act(async () => reject());
        expect(result.current.notifications).toEqual(notifications);
        expect(result.current.unreadCount).toBe(unreadCount);
      } finally { cleanup(); }
    },
  );

  it("restores confirmed data when both overlapping acknowledgements reject", async () => {
    const { result, reject } = setup();
    let rejectLatest!: (error: Error) => void;
    walletHook.postAction.mockImplementationOnce(() => new Promise((_, fail) => {
      rejectLatest = fail;
    }));
    try {
      act(() => result.current.markAllRead());
      act(() => result.current.clearAll());
      await act(async () => {
        reject();
        rejectLatest(new Error("offline"));
      });
      expect(result.current.notifications.map((n) => n.id)).toEqual(["A"]);
      expect(result.current.notifications[0].read).toBe(false);
      expect(result.current.unreadCount).toBe(1);
    } finally { cleanup(); }
  });
});
