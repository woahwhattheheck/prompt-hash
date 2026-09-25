/**
 * Express routes for seller notification cursors (#181).
 */

import express from "express";
import {
  advanceSellerCursor,
  getSellerFeed,
  markAllSellerNotificationsRead,
  markSellerNotificationsRead,
} from "../../../src/lib/notifications/sellerNotificationStore";

export const sellerNotificationRouter = express.Router();

sellerNotificationRouter.get("/", async (req, res) => {
  const wallet = String(req.query.wallet ?? "").trim();
  if (!wallet) {
    res.status(400).json({ error: "wallet query parameter is required" });
    return;
  }
  const advance = req.query.advance === "1" || req.query.advance === "true";
  const feed = await getSellerFeed(wallet, { advance });
  res.status(200).json({
    notifications: feed.notifications,
    cursorEventId: feed.cursor.cursorEventId,
    lastLedger: feed.cursor.lastLedger,
    unreadCount: feed.unreadCount,
    readIds: feed.cursor.readIds,
  });
});

sellerNotificationRouter.post("/", async (req, res) => {
  const wallet = String(req.body?.wallet ?? "").trim();
  if (!wallet) {
    res.status(400).json({ error: "wallet is required" });
    return;
  }
  const action = String(req.body?.action ?? "");
  let cursor;
  switch (action) {
    case "mark-read":
      cursor = await markSellerNotificationsRead(
        wallet,
        Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [],
      );
      break;
    case "mark-all-read":
      cursor = await markAllSellerNotificationsRead(wallet);
      break;
    case "advance":
      cursor = await advanceSellerCursor(wallet);
      break;
    default:
      res.status(400).json({
        error: "action must be mark-read | mark-all-read | advance",
      });
      return;
  }
  res.status(200).json({
    ok: true,
    cursorEventId: cursor.cursorEventId,
    readIds: cursor.readIds,
    lastLedger: cursor.lastLedger,
  });
});
