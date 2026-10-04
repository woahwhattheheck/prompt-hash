/** Poll the retained audit outbox independently of incoming unlock requests. */
export function startDurableAuditWorker(
  drain: () => Promise<unknown>,
): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loggedFailure = false;
  let inFlight: Promise<void>;

  async function run(): Promise<void> {
    try {
      await drain();
      loggedFailure = false;
    } catch {
      // The next poll retries connection/claim failures as well as pending rows.
      // Log each outage once, without including stored events or credentials.
      if (!loggedFailure) {
        console.error("[audit-outbox] drain failed; polling will retry");
        loggedFailure = true;
      }
    } finally {
      // Schedule after settlement so slow drains never overlap in this process.
      if (!stopped) {
        timer = setTimeout(() => {
          inFlight = run();
        }, 1000);
        timer.unref();
      }
    }
  }

  inFlight = run();

  return async function stop(): Promise<void> {
    stopped = true;
    if (timer) clearTimeout(timer);
    await inFlight;
  };
}
