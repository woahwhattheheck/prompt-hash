/**
 * Serialize file-store operations across local processes sharing one path.
 * Never expire or reclaim another owner's lock: a paused process can resume.
 */

import { promises as fs } from "fs";
import type { FileHandle } from "fs/promises";
import path from "path";
import { performance } from "perf_hooks";
import { setTimeout as delay } from "timers/promises";

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 25;

export class ReviewStoreLockTimeoutError extends Error {
  constructor() {
    super("Review store is busy: timed out waiting for its file lock");
    this.name = "ReviewStoreLockTimeoutError";
  }
}

async function acquireLock(lockPath: string): Promise<FileHandle> {
  const deadline = performance.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      return await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new ReviewStoreLockTimeoutError();
      await delay(Math.min(LOCK_RETRY_MS, remaining));
    }
  }
}

async function releaseLock(
  lockPath: string,
  handle: FileHandle,
): Promise<void> {
  try {
    // Keep the descriptor open while checking identity, so a replacement lock
    // cannot reuse this inode. Do not remove a different owner's sidecar.
    const [owned, current] = await Promise.all([
      handle.stat(),
      fs.lstat(lockPath),
    ]);
    if (
      !current.isFile() ||
      current.dev !== owned.dev ||
      current.ino !== owned.ino
    ) {
      throw new Error(
        "Review store lock ownership changed; lock left in place",
      );
    }
    await fs.unlink(lockPath);
  } finally {
    await handle.close();
  }
}

export async function withPathLock<T>(
  absPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = `${path.resolve(absPath)}.lock`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const handle = await acquireLock(lockPath);
  let operation: { ok: true; value: T } | { ok: false; error: unknown };

  try {
    // Diagnostic metadata only; age and PID never authorize automatic takeover.
    await handle.writeFile(
      JSON.stringify({ version: 1, pid: process.pid, createdAt: Date.now() }) +
        "\n",
      "utf8",
    );
    operation = { ok: true, value: await fn() };
  } catch (error) {
    operation = { ok: false, error };
  }

  try {
    await releaseLock(lockPath, handle);
  } catch (cleanupError) {
    if (!operation.ok) {
      throw new AggregateError(
        [operation.error, cleanupError],
        "Review store operation failed and its file lock could not be released",
        { cause: cleanupError },
      );
    }
    throw cleanupError;
  }
  if (!operation.ok) throw operation.error;
  return operation.value;
}
