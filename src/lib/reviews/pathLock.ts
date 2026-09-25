/**
 * Serialize async work per absolute path so multiple repository instances
 * sharing one durable file behave like coordinated replicas.
 */

const chains = new Map<string, Promise<unknown>>();

export function withPathLock<T>(absPath: string, fn: () => Promise<T>): Promise<T> {
  const key = absPath;
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // Keep the chain alive regardless of success/failure so the next waiter runs.
  chains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
