/**
 * HTTP server lifecycle: timer registry + bounded graceful shutdown (issue #171).
 *
 * First SIGTERM/SIGINT (or explicit shutdown()) stops accepting, drains
 * in-flight requests, clears tracked timers, disconnects MongoDB, then
 * resolves. A hanging drain is force-exited after shutdownTimeoutMs.
 * Repeated signals are idempotent.
 */
import type { Server as HttpServer } from "http";
import type { Socket } from "net";

export type TimerHandle = ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>;

export interface ServerLifecycleLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string, err?: unknown) => void;
}

export interface ServerLifecycleOptions {
  server: HttpServer;
  shutdownTimeoutMs: number;
  /** Close the DB connection pool. Defaults to a no-op when unset. */
  disconnectDb?: () => Promise<void>;
  /** Invoked when the drain bound is exceeded. Defaults to process.exit(1). */
  onForceExit?: (code: number) => void;
  signals?: NodeJS.Signals[];
  logger?: ServerLifecycleLogger;
}

const defaultLogger: ServerLifecycleLogger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg, err) => console.error(msg, err ?? ""),
};

export class ServerLifecycle {
  private readonly server: HttpServer;
  private readonly shutdownTimeoutMs: number;
  private readonly disconnectDb: () => Promise<void>;
  private readonly onForceExit: (code: number) => void;
  private readonly logger: ServerLifecycleLogger;
  private readonly signals: NodeJS.Signals[];
  private readonly timers = new Set<TimerHandle>();
  private readonly sockets = new Set<Socket>();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private signalHandlersInstalled = false;
  private readonly boundHandlers = new Map<NodeJS.Signals, () => void>();

  constructor(options: ServerLifecycleOptions) {
    this.server = options.server;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs;
    this.disconnectDb = options.disconnectDb ?? (async () => undefined);
    this.onForceExit =
      options.onForceExit ??
      ((code: number) => {
        // eslint-disable-next-line n/no-process-exit
        process.exit(code);
      });
    this.logger = options.logger ?? defaultLogger;
    this.signals = options.signals ?? ["SIGTERM", "SIGINT"];

    // Track connections so a hanging keep-alive client cannot block drain forever
    // beyond the forced-timeout path (server.close waits for them).
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  get trackedTimerCount(): number {
    return this.timers.size;
  }

  /** Register an interval/timeout so shutdown clears it. Returns the same handle. */
  trackTimer(handle: TimerHandle): TimerHandle {
    this.timers.add(handle);
    return handle;
  }

  clearTrackedTimers(): void {
    for (const handle of this.timers) {
      clearInterval(handle as NodeJS.Timeout);
      clearTimeout(handle as NodeJS.Timeout);
    }
    this.timers.clear();
  }

  installSignalHandlers(): void {
    if (this.signalHandlersInstalled) return;
    for (const signal of this.signals) {
      const handler = () => {
        void this.shutdown(signal);
      };
      this.boundHandlers.set(signal, handler);
      process.on(signal, handler);
    }
    this.signalHandlersInstalled = true;
  }

  removeSignalHandlers(): void {
    for (const [signal, handler] of this.boundHandlers) {
      process.off(signal, handler);
    }
    this.boundHandlers.clear();
    this.signalHandlersInstalled = false;
  }

  /**
   * Idempotent graceful shutdown. Concurrent/repeated calls share one promise.
   */
  shutdown(reason = "manual"): Promise<void> {
    if (this.shutdownPromise) {
      this.logger.info(`[lifecycle] shutdown already in progress (ignored: ${reason})`);
      return this.shutdownPromise;
    }

    this.shuttingDown = true;
    this.logger.info(`[lifecycle] shutting down (reason: ${reason})`);

    this.shutdownPromise = this.runShutdown();
    return this.shutdownPromise;
  }

  private async runShutdown(): Promise<void> {
    let forceTimer: TimerHandle | null = null;
    let forced = false;

    const forcePromise = new Promise<"forced">((resolve) => {
      forceTimer = setTimeout(() => {
        forced = true;
        this.logger.error(
          `[lifecycle] shutdown exceeded ${this.shutdownTimeoutMs}ms — forcing exit`,
        );
        // Destroy remaining sockets so server.close can finish if we somehow continue.
        for (const socket of this.sockets) {
          try {
            socket.destroy();
          } catch {
            // ignore
          }
        }
        resolve("forced");
      }, this.shutdownTimeoutMs);
      // Do not keep the event loop alive solely for the force timer in tests.
      if (typeof (forceTimer as NodeJS.Timeout).unref === "function") {
        (forceTimer as NodeJS.Timeout).unref();
      }
    });

    try {
      const drain = this.drainAndClose();
      const winner = await Promise.race([
        drain.then(() => "drained" as const),
        forcePromise,
      ]);

      if (winner === "forced") {
        this.onForceExit(1);
        return;
      }
    } finally {
      if (forceTimer && !forced) {
        clearTimeout(forceTimer as NodeJS.Timeout);
      }
      this.clearTrackedTimers();
      this.removeSignalHandlers();
    }
  }

  private async drainAndClose(): Promise<void> {
    // Stop accepting new connections first.
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => {
        if (err) {
          // ERR_SERVER_NOT_RUNNING is fine (already closed / never listened).
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ERR_SERVER_NOT_RUNNING") {
            resolve();
            return;
          }
          reject(err);
          return;
        }
        resolve();
      });
    });

    this.clearTrackedTimers();

    try {
      await this.disconnectDb();
      this.logger.info("[lifecycle] database disconnected");
    } catch (err) {
      this.logger.error("[lifecycle] database disconnect failed", err);
      throw err;
    }

    this.logger.info("[lifecycle] shutdown complete");
  }
}

/**
 * Listen with the validated host/port and wrap the server in a lifecycle controller.
 */
export function listenWithLifecycle(
  app: { listen: (port: number, host: string, cb?: () => void) => HttpServer },
  options: {
    port: number;
    host: string;
    shutdownTimeoutMs: number;
    disconnectDb?: () => Promise<void>;
    onListening?: (port: number, host: string) => void;
    onForceExit?: (code: number) => void;
    logger?: ServerLifecycleLogger;
    installSignals?: boolean;
  },
): { server: HttpServer; lifecycle: ServerLifecycle } {
  const server = app.listen(options.port, options.host, () => {
    options.onListening?.(options.port, options.host);
  });

  const lifecycle = new ServerLifecycle({
    server,
    shutdownTimeoutMs: options.shutdownTimeoutMs,
    disconnectDb: options.disconnectDb,
    onForceExit: options.onForceExit,
    logger: options.logger,
  });

  if (options.installSignals !== false) {
    lifecycle.installSignalHandlers();
  }

  return { server, lifecycle };
}
