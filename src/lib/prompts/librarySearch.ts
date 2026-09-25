/**
 * Buyer Library Search & Unlock History Helpers
 * 
 * Provides pure search filtering over purchased prompts and local, privacy-aware
 * telemetry tracking for unlock attempts.
 */

import type { PromptRecord } from "../stellar/promptHashClient";
import { sortPromptsBy } from "./promptOrdering";

export type StatusFilter = "all" | "unlocked" | "locked";
export type SortOption = "newest" | "oldest" | "price-high" | "price-low";

export interface UnlockHistoryEntry {
  id: string;
  promptId: string;
  title: string;
  timestamp: number;
  status: "success" | "failed" | "rejected" | "expired";
}

const STORAGE_KEY_PREFIX = "prompthash_unlock_history_";
const MAX_HISTORY_ENTRIES = 50;

/**
 * Filters and sorts buyer library prompts according to search query, category, status, and sort criteria.
 */
export function filterLibraryPrompts(
  prompts: PromptRecord[],
  query: string,
  categoryFilter: string = "all",
  statusFilter: StatusFilter = "all",
  sortOption: SortOption = "newest",
  unlockedRecord: Record<string, string> = {},
): PromptRecord[] {
  const normalizedQuery = query.trim().toLowerCase();

  const filtered = prompts.filter((prompt) => {
    // Category filter
    if (categoryFilter !== "all" && prompt.category.toLowerCase() !== categoryFilter.toLowerCase()) {
      return false;
    }

    // Status filter
    if (statusFilter !== "all") {
      const isUnlocked = Boolean(unlockedRecord[prompt.id.toString()]);
      if (statusFilter === "unlocked" && !isUnlocked) return false;
      if (statusFilter === "locked" && isUnlocked) return false;
    }

    // Search query filter (matches title, category, creator, or preview text)
    if (normalizedQuery) {
      const titleMatch = prompt.title.toLowerCase().includes(normalizedQuery);
      const categoryMatch = prompt.category.toLowerCase().includes(normalizedQuery);
      const creatorMatch = (prompt.creator ?? "").toLowerCase().includes(normalizedQuery);
      const previewMatch = prompt.previewText.toLowerCase().includes(normalizedQuery);

      if (!titleMatch && !categoryMatch && !creatorMatch && !previewMatch) {
        return false;
      }
    }

    return true;
  });

  return sortPromptsBy(filtered, sortOption);
}

/**
 * Retrieves local unlock history for a specific wallet address from localStorage.
 */
export function getUnlockHistory(walletAddress?: string): UnlockHistoryEntry[] {
  if (!walletAddress || typeof localStorage === "undefined") return [];

  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${walletAddress}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as UnlockHistoryEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Records a new unlock history entry for the given wallet address in localStorage.
 */
export function addUnlockHistoryEntry(
  walletAddress: string,
  entry: Omit<UnlockHistoryEntry, "id" | "timestamp">,
): UnlockHistoryEntry[] {
  if (!walletAddress || typeof localStorage === "undefined") return [];

  const existing = getUnlockHistory(walletAddress);
  const newEntry: UnlockHistoryEntry = {
    id: `unlock_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    ...entry,
  };

  const updated = [newEntry, ...existing].slice(0, MAX_HISTORY_ENTRIES);

  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${walletAddress}`, JSON.stringify(updated));
  } catch {
    // Ignore storage quota errors
  }

  return updated;
}

/**
 * Clears local unlock history for a specific wallet.
 */
export function clearUnlockHistory(walletAddress: string): void {
  if (!walletAddress || typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(`${STORAGE_KEY_PREFIX}${walletAddress}`);
  } catch {
    // Ignore storage errors
  }
}
