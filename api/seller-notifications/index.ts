/**
 * Seller notifications API (#181).
 *
 * GET  ?wallet=&advance=1  → feed from durable cursor
 * POST { wallet, action, ids? } → mark-read | mark-all-read | advance
 *
 * Read state and cursor are server-side; localStorage is not authoritative.
 */

import {
  advanceSellerCursor,
  getSellerFeed,
  markAllSellerNotificationsRead,
  markSellerNotificationsRead,
} from "../../src/lib/notifications/sellerNotificationStore";
import { normalizeWallet } from "../../src/lib/notifications/sellerNotificationTypes";

function badRequest(res: any, error: string) {
  res.status(400).json({ error });
}

export default async function handler(req: any, res: any) {
  try {
    if (req.method === "GET") {
      const wallet = String(req.query?.wallet ?? "").trim();
      if (!wallet) return badRequest(res, "wallet query parameter is required");
      const advance =
        req.query?.advance === "1" ||
        req.query?.advance === "true" ||
        req.query?.advance === true;
      const feed = await getSellerFeed(wallet, { advance });
      res.status(200).json({
        notifications: feed.notifications,
        cursorEventId: feed.cursor.cursorEventId,
        lastLedger: feed.cursor.lastLedger,
        unreadCount: feed.unreadCount,
        readIds: feed.cursor.readIds,
      });
      return;
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body ?? {};
      const wallet = String(body.wallet ?? "").trim();
      if (!wallet) return badRequest(res, "wallet is required");
      const action = String(body.action ?? "");
      let cursor;
      switch (action) {
        case "mark-read": {
          const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
          cursor = await markSellerNotificationsRead(wallet, ids);
          break;
        }
        case "mark-all-read":
          cursor = await markAllSellerNotificationsRead(wallet);
          break;
        case "advance":
          cursor = await advanceSellerCursor(wallet);
          break;
        case "clear-read": {
          const { getSellerNotificationRepository } = await import(
            "../../src/lib/notifications/sellerNotificationStore"
          );
          const repo = await getSellerNotificationRepository();
          const current = await repo.getCursor(normalizeWallet(wallet));
          cursor = await repo.saveCursor({
            ...current,
            readIds: [],
            updatedAt: Date.now(),
          });
          break;
        }
        default:
          return badRequest(res, "action must be mark-read | mark-all-read | advance | clear-read");
      }
      res.status(200).json({
        ok: true,
        cursorEventId: cursor.cursorEventId,
        readIds: cursor.readIds,
        lastLedger: cursor.lastLedger,
      });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Seller notification error";
    console.error("[seller-notifications]", message);
    res.status(500).json({ error: message });
  }
}
