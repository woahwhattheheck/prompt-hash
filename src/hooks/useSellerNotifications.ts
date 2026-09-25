import { useCallback, useEffect, useMemo, useState } from "react";
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
  const [notifications, setNotifications] = useState<SellerNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

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
        return { notifications: [], unreadCount: 0, cursorEventId: null, lastLedger: 0 };
      }
      // Drop legacy snapshot keys once we are on the cursor path.
      clearLegacyLocalNotificationState(address);
      return fetchSellerNotificationFeed(address, { advance: true });
    },
    enabled: Boolean(address),
    refetchInterval: 60_000,
    retry: 1,
  });

  useEffect(() => {
    if (!address) {
      setNotifications([]);
      setUnreadCount(0);
      return;
    }
    if (!feed) return;
    setNotifications(feed.notifications ?? []);
    setUnreadCount(feed.unreadCount ?? 0);
  }, [address, feed]);

  const summary = useMemo(() => summariseActivity(prompts), [prompts]);

  const markAllRead = useCallback(() => {
    if (!address) return;
    setNotifications((current) => current.map((n) => ({ ...n, read: true })));
    setUnreadCount(0);
    void postSellerNotificationAction(address, "mark-all-read").catch(() => {
      /* best-effort; next poll reconciles */
    });
  }, [address]);

  const clearAll = useCallback(() => {
    if (!address) return;
    // Clear is a local UI dismiss; read-set stays server-side so other devices
    // still see history. Mark all read so unread badge stays consistent.
    setNotifications([]);
    setUnreadCount(0);
    void postSellerNotificationAction(address, "mark-all-read").catch(() => {
      /* best-effort */
    });
  }, [address]);

  return {
    notifications,
    unreadCount,
    summary,
    hasListings: prompts.length > 0,
    markAllRead,
    clearAll,
  };
}
