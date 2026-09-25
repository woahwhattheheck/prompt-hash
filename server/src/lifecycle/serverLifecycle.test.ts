import http from "http";
import express from "express";
import { ServerLifecycle, listenWithLifecycle } from "./serverLifecycle";

function listenEphemeral(
  app: express.Express,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("expected TCP address"));
        return;
      }
      resolve({ server, port: addr.port });
    });
    server.on("error", reject);
  });
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      })
      .on("error", reject);
  });
}

describe("ServerLifecycle", () => {
  afterEach(() => {
    // Ensure no leftover signal handlers from prior tests.
    for (const signal of ["SIGTERM", "SIGINT"] as NodeJS.Signals[]) {
      process.removeAllListeners(signal);
    }
  });

  it("clears tracked timers on shutdown", async () => {
    const app = express();
    app.get("/ok", (_req, res) => res.json({ ok: true }));
    const { server } = await listenEphemeral(app);

    let ticks = 0;
    const lifecycle = new ServerLifecycle({
      server,
      shutdownTimeoutMs: 2000,
      disconnectDb: async () => undefined,
      onForceExit: () => {
        throw new Error("should not force-exit");
      },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    lifecycle.trackTimer(
      setInterval(() => {
        ticks += 1;
      }, 20),
    );
    expect(lifecycle.trackedTimerCount).toBe(1);

    await new Promise((r) => setTimeout(r, 50));
    const ticksBefore = ticks;
    expect(ticksBefore).toBeGreaterThan(0);

    await lifecycle.shutdown("test-timer-cleanup");
    expect(lifecycle.trackedTimerCount).toBe(0);

    const ticksAtClear = ticks;
    await new Promise((r) => setTimeout(r, 60));
    expect(ticks).toBe(ticksAtClear);
  });

  it("drains an in-flight request before closing (SIGTERM during request)", async () => {
    const app = express();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    app.get("/slow", async (_req, res) => {
      await gate;
      res.json({ done: true });
    });

    const { server, port } = await listenEphemeral(app);
    let disconnected = false;
    const lifecycle = new ServerLifecycle({
      server,
      shutdownTimeoutMs: 5000,
      disconnectDb: async () => {
        disconnected = true;
      },
      onForceExit: () => {
        throw new Error("should not force-exit");
      },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    const requestPromise = get(port, "/slow");
    // Give the request a moment to be accepted.
    await new Promise((r) => setTimeout(r, 30));

    const shutdownPromise = lifecycle.shutdown("SIGTERM");
    // Shutdown should be waiting on the in-flight request.
    await new Promise((r) => setTimeout(r, 30));
    expect(disconnected).toBe(false);

    release();
    const result = await requestPromise;
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ done: true });

    await shutdownPromise;
    expect(disconnected).toBe(true);
    expect(lifecycle.isShuttingDown).toBe(true);

    // New connections must be rejected after close.
    await expect(get(port, "/slow")).rejects.toThrow();
  });

  it("force-exits when drain exceeds the shutdown timeout", async () => {
    const app = express();
    app.get("/hang", (_req, res) => {
      // Never respond — keeps the connection open so server.close cannot finish.
      void res;
    });

    const { server, port } = await listenEphemeral(app);

    let forceCode: number | null = null;
    const lifecycle = new ServerLifecycle({
      server,
      shutdownTimeoutMs: 150,
      disconnectDb: async () => undefined,
      onForceExit: (code) => {
        forceCode = code;
      },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    // Open a hanging request so drain blocks. Swallow the expected hang-up
    // when the force path destroys sockets.
    const req = http.get({ host: "127.0.0.1", port, path: "/hang" });
    const reqFinished = new Promise<void>((resolve) => {
      req.on("error", () => resolve());
      req.on("close", () => resolve());
    });
    await new Promise((r) => setTimeout(r, 30));

    await lifecycle.shutdown("force-timeout");
    expect(forceCode).toBe(1);

    req.destroy();
    await reqFinished;
  });

  it("treats repeated shutdown signals as idempotent", async () => {
    const app = express();
    app.get("/ok", (_req, res) => res.json({ ok: true }));
    const { server } = await listenEphemeral(app);

    let disconnectCalls = 0;
    const lifecycle = new ServerLifecycle({
      server,
      shutdownTimeoutMs: 2000,
      disconnectDb: async () => {
        disconnectCalls += 1;
        await new Promise((r) => setTimeout(r, 40));
      },
      onForceExit: () => {
        throw new Error("should not force-exit");
      },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    const first = lifecycle.shutdown("SIGTERM");
    const second = lifecycle.shutdown("SIGINT");
    const third = lifecycle.shutdown("SIGTERM");

    await Promise.all([first, second, third]);
    expect(disconnectCalls).toBe(1);
  });

  it("listenWithLifecycle honors host/port and installs signal handlers", async () => {
    const app = express();
    app.get("/health/live", (_req, res) => res.json({ status: "ok" }));

    let listenedPort = 0;
    const { server, lifecycle } = listenWithLifecycle(app, {
      port: 0, // ephemeral — OS assigns
      host: "127.0.0.1",
      shutdownTimeoutMs: 2000,
      installSignals: true,
      onListening: (p) => {
        listenedPort = p;
      },
      disconnectDb: async () => undefined,
      onForceExit: () => undefined,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    await new Promise<void>((resolve, reject) => {
      server.on("listening", () => resolve());
      server.on("error", reject);
      if (server.listening) resolve();
    });

    const addr = server.address();
    expect(addr && typeof addr !== "string" ? addr.port : 0).toBeGreaterThan(0);
    // onListening may see port 0 when the OS assigns later; prefer address().
    const port = typeof addr === "object" && addr ? addr.port : listenedPort;
    const res = await get(port, "/health/live");
    expect(res.status).toBe(200);

    await lifecycle.shutdown("test-end");
  });
});
