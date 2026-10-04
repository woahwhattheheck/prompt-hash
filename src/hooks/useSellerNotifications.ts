import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWallet } from "@/hooks/useWallet";
import { browserStellarConfig } from "@/lib/stellar/browserConfig";
import { getPromptsByCreator } from "@/lib/stellar/promptHashClient";
import {
  clearLegacyLocalNotificationState,
  summariseActivity,
  type SellerActivitySummary,
  type SellerNotification,
} from "@/lib/notifications/sellerNotifications";
import {
  fetchSellerNotificationFeed,
  postSellerNotificationAction,
} from "@/lib/notifications/sellerNotificationClient";

export interface UseSellerNotifications {
  notifications: SellerNotification[];
  unreadCount: number;
  summary: SellerActivitySummary;
  hasListings: boolean;
  markAllRead: () => void;
  clearAll: () => void;
}

export function useSellerNotifications(): UseSellerNotifications {
  const { address } = useWallet();
  const [localFeed, setLocalFeed] = useState<{
    wallet: typeof address;
    notifications: SellerNotification[];
    unreadCount: number;
  }>({ wallet: address, notifications: [], unreadCount: 0 });
  const readMutation = useRef(0);

  // Hide the previous wallet's feed on the first render after a switch.
  const notifications =
    localFeed.wallet === address ? localFeed.notifications : [];
  const unreadCount = localFeed.wallet === address ? localFeed.unreadCount : 0;

  const { data: prompts = [] } = useQuery({
    queryKey: ["created-prompts", address],
    queryFn: () =>
      address ? getPromptsByCreator(browserStellarConfig, address) : [],
    enabled: Boolean(address),
    refetchInterval: 60_000,
  });

  const { data: feed } = useQuery({
    queryKey: ["seller-notifications", address],
    queryFn: async () => {
      if (!address) {
        return {
          wallet: address,
          notifications: [],
          unreadCount: 0,
          cursorEventId: null,
          lastLedger: 0,
        };
      }
      // Drop legacy snapshot keys once we are on the cursor path.
      clearLegacyLocalNotificationState(address);
      const result = await fetchSellerNotificationFeed(address, { advance: true });
      return { ...result, wallet: address };
    },
    enabled: Boolean(address),
    refetchInterval: 60_000,
    retry: 1,
  });

  useEffect(() => {
    // A fresh server feed or wallet owns the display over pending mutations.
    readMutation.current += 1;
    if (!address || !feed || feed.wallet !== address) {
      setLocalFeed({ wallet: address, notifications: [], unreadCount: 0 });
    } else {
      setLocalFeed({
        wallet: address,
        notifications: feed.notifications ?? [],
        unreadCount: feed.unreadCount ?? 0,
      });
    }
    return () => {
      readMutation.current += 1;
    };
  }, [address, feed]);

  const summary = useMemo(() => summariseActivity(prompts), [prompts]);

  const acknowledgeRead = useCallback(
    (dismiss: boolean) => {
      if (!address) return;
      const mutation = ++readMutation.current;
      const previous =
        localFeed.wallet === address
          ? localFeed
          : { wallet: address, notifications: [], unreadCount: 0 };
      const confirmed = {
        wallet: address,
        notifications: feed?.wallet === address ? feed.notifications ?? [] : [],
        unreadCount: feed?.wallet === address ? feed.unreadCount ?? 0 : 0,
      };
      setLocalFeed({
        wallet: address,
        notifications: dismiss
          ? []
          : previous.notifications.map((n) => ({ ...n, read: true })),
        unreadCount: 0,
      });
      void postSellerNotificationAction(address, "mark-all-read").catch(() => {
        // An unchanged cached poll may not rerun the feed effect. Restore the
        // confirmed display only if no newer wallet, feed or action replaced it.
        if (readMutation.current === mutation) setLocalFeed(confirmed);
      });
    },
    [address, feed, localFeed],
  );

  const markAllRead = useCallback(() => acknowledgeRead(false), [acknowledgeRead]);

  const clearAll = useCallback(() => {
    // Clear is a local UI dismiss; read-set stays server-side so other devices
    // still see history. Mark all read so unread badge stays consistent.
    acknowledgeRead(true);
  }, [acknowledgeRead]);

  return {
    notifications,
    unreadCount,
    summary,
    hasListings: prompts.length > 0,
    markAllRead,
    clearAll,
  };
}
