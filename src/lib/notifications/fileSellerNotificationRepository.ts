import fs from "fs";
import path from "path";
import { emptyCursor } from "./sellerNotificationCursor";
import type { SellerNotificationRepository } from "./sellerNotificationRepository";
import {
  compareIndexedEvents,
  normalizeWallet,
  type IndexedSellerEvent,
  type SellerNotificationCursorState,
} from "./sellerNotificationTypes";

type FileShape = {
  events: Record<string, IndexedSellerEvent>;
  cursors: Record<string, SellerNotificationCursorState>;
};

function emptyShape(): FileShape {
  return { events: {}, cursors: {} };
}

function isDictionary(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  // The lock is created before the store, so initialize its directory first.
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.closeSync(fd);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      if (Date.now() - start > 5_000) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* ignore */
        }
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }
}

function readShape(filePath: string): FileShape {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as FileShape;
    if (
      !isDictionary(parsed) ||
      (parsed.events != null && !isDictionary(parsed.events)) ||
      (parsed.cursors != null && !isDictionary(parsed.cursors))
    ) {
      throw new Error("Invalid seller notification store");
    }
    return {
      events: parsed.events ?? {},
      cursors: parsed.cursors ?? {},
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return emptyShape();
    throw err;
  }
}

function writeShape(filePath: string, shape: FileShape): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(shape, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

export function createFileSellerNotificationRepository(
  filePath: string,
): SellerNotificationRepository {
  const lockPath = `${filePath}.lock`;

  return {
    async appendEvent(event) {
      return withLock(lockPath, async () => {
        const shape = readShape(filePath);
        const existing = shape.events[event.eventId];
        if (existing) return { created: false, event: existing };
        const stored = { ...event, wallet: normalizeWallet(event.wallet) };
        shape.events[stored.eventId] = stored;
        writeShape(filePath, shape);
        return { created: true, event: stored };
      });
    },

    async listEventsForWallet(wallet) {
      const shape = readShape(filePath);
      const key = normalizeWallet(wallet);
      return Object.values(shape.events)
        .filter((e) => e.wallet === key)
        .sort(compareIndexedEvents);
    },

    async getEvent(eventId) {
      const shape = readShape(filePath);
      return shape.events[eventId] ?? null;
    },

    async getCursor(wallet) {
      const shape = readShape(filePath);
      const key = normalizeWallet(wallet);
      return shape.cursors[key] ?? emptyCursor(key);
    },

    async saveCursor(state) {
      return withLock(lockPath, async () => {
        const shape = readShape(filePath);
        const key = normalizeWallet(state.wallet);
        const previousReadIds = shape.cursors[key]?.readIds ?? [];
        const next = {
          ...state,
          wallet: key,
          readIds: [...new Set([...previousReadIds, ...state.readIds])],
        };
        shape.cursors[key] = next;
        writeShape(filePath, shape);
        return next;
      });
    },

    async clear() {
      return withLock(lockPath, async () => {
        writeShape(filePath, emptyShape());
      });
    },

    async countEvents() {
      return Object.keys(readShape(filePath).events).length;
    },
  };
}
