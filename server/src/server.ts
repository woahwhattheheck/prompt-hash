import "dotenv/config";
import * as Sentry from "@sentry/node";
import express, { type Express } from "express";
import { TestPromptProxy } from "./controllers/controllers";
import { proxyrouter } from "./routes/proxyRoutes";
import { promptRouter } from "./routes/promptRoutes";
import { userRouter } from "./routes/userRoutes";
import { chatRouter } from "./routes/chatRoutes";
import { webhookRouter } from "./routes/webhookRoutes";
import { versioningRouter } from "./routes/versioningRoutes";
import { governanceRouter } from "./routes/governanceRoutes"; // Issue #113
import searchRouter from "./routes/searchRoutes";
import { fulfillmentRouter } from "./routes/fulfillmentRoutes";
import { reconciliationRouter } from "./routes/reconciliationRoutes";
import { reviewRouter } from "./routes/reviewRoutes";
import { computeReadiness } from "./services/healthService";
import {
  globalLimiter,
  authLimiter,
  strictLimiter,
  chatLimiter,
} from "./middleware/rateLimiter";
import { corsMiddleware, securityHeaders, configureTrustedProxy } from "./middleware/security";
import { loadRuntimeConfig } from "./config/runtime";
import { disconnectDb } from "./db/connectDb";
import { listenWithLifecycle, type ServerLifecycle } from "./lifecycle/serverLifecycle";
// import { startIndexer } from "./services/indexerService"; // TODO: Update path when ready

// ── Sentry backend monitoring (#332) ─────────────────────────────────────────
// Set SENTRY_DSN in the server .env to enable exception capture.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? "development",
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
  });
}

/**
 * Build the Express application (middleware + routes). Exported for tests that
 * need the app without binding a port.
 */
export function createApp(): Express {
  const app = express();

  // ── Trusted proxy configuration ──────────────────────────────────────────────
  // Must be set before anything reads req.ip (rate limiters, CORS, logging) so
  // client IPs are derived from only the configured number of trusted
  // X-Forwarded-For hops instead of a spoofable header. See
  // middleware/security.ts and docs/security-model.md.
  configureTrustedProxy(app);

  // ── Defensive headers & CORS ─────────────────────────────────────────────────
  // Registered before body parsing / routes so every response - including
  // rejected/oversized requests - carries the hardened headers, and so
  // disallowed origins never reach the API handlers.
  app.use(securityHeaders());
  app.use(corsMiddleware());

  // Sentry error handler should be registered after routes (#332).
  // Bounded JSON body limits per route class: a conservative default for
  // most JSON APIs, with a larger budget for the routes that carry prompt
  // content (create/update/version), which can legitimately be large. Each
  // route class gets its own express.json() instance (rather than one
  // global parser plus per-route overrides) because body-parser can only
  // consume the request stream once - a second express.json() on the same
  // request is a no-op, so the limit that matters is whichever one runs
  // first per route.
  const promptContentJsonLimit = express.json({ limit: "2mb" });
  const defaultJsonLimit = express.json({ limit: "100kb" });

  // ── Rate limiting ────────────────────────────────────────────────────────────
  // Global rate limit: 100 requests per 15 minutes per IP.
  app.use(globalLimiter);

  app.use("/api/improve-proxy", defaultJsonLimit, strictLimiter, proxyrouter);

  app.use("/api/prompts", promptContentJsonLimit, promptRouter);

  app.use("/api/user", defaultJsonLimit, authLimiter, userRouter);

  app.use("/api/chat", defaultJsonLimit, chatLimiter, chatRouter);
  app.use("/api/webhooks", defaultJsonLimit, strictLimiter, webhookRouter);
  app.use("/api/versions", promptContentJsonLimit, versioningRouter);
  app.use("/api/governance", defaultJsonLimit, authLimiter, governanceRouter); // Issue #113
  app.use("/api/search", defaultJsonLimit, searchRouter);
  app.use("/api/fulfillment", defaultJsonLimit, strictLimiter, fulfillmentRouter);
  app.use("/api/reviews", defaultJsonLimit, reviewRouter);

  app.post("/api/test-prompt", defaultJsonLimit, strictLimiter, TestPromptProxy);

  // Liveness: process is up and able to respond. No dependency checks, so it
  // never reports failure because of a slow/unhealthy database or backup -
  // that is the readiness check's job below.
  app.get("/health/live", (_req, res) => {
    res.json({ status: "ok", checkedAt: new Date().toISOString() });
  });

  // Readiness: the API is only ready when its required dependencies are.
  // Reports a bounded, redacted set of reason codes and a measurement
  // timestamp, and responds 503 (not 200) when the indexer checkpoint is
  // stale, the quarantine backlog is over threshold, the indexer lease is
  // expired, or backups are unhealthy - see services/healthService.ts.
  app.get("/health", async (req, res) => {
    const readiness = await computeReadiness();
    res.status(readiness.status === "ready" ? 200 : 503).json(readiness);
  });

  // Sentry error handler must be registered after all routes (#332).
  // expressErrorHandler is available in @sentry/node v7; v8+ uses setupExpressErrorHandler.
  if (process.env.SENTRY_DSN) {
    if (typeof (Sentry as Record<string, unknown>).setupExpressErrorHandler === "function") {
      (Sentry as unknown as { setupExpressErrorHandler: (app: Express) => void }).setupExpressErrorHandler(app);
    } else if (typeof (Sentry as Record<string, unknown>).expressErrorHandler === "function") {
      app.use((Sentry as unknown as { expressErrorHandler: () => import("express").ErrorRequestHandler }).expressErrorHandler());
    }
  }

  // Final JSON error handler: catches CORS rejections (disallowed origin),
  // oversized-body errors from express.json(), and anything else forwarded
  // via next(err), so clients always get a clean JSON error instead of
  // Express's default HTML error page.
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) {
      return;
    }
    if (err?.type === "entity.too.large") {
      return res.status(413).json({ error: "Request body too large" });
    }
    if (typeof err?.message === "string" && err.message.includes("not allowed by CORS policy")) {
      return res.status(403).json({ error: "Origin not allowed" });
    }
    console.error("Unhandled request error:", err?.message ?? err);
    return res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

export interface StartedServer {
  app: Express;
  lifecycle: ServerLifecycle;
}

/**
 * Load validated runtime config, bind HTTP, and install SIGTERM/SIGINT shutdown.
 * Optional in-process scheduler ticks are tracked so shutdown clears them;
 * backups remain cron-only (see backup.crontab) — content/format unchanged.
 */
export function startServer(
  env: NodeJS.ProcessEnv = process.env,
): StartedServer {
  const runtime = loadRuntimeConfig(env);
  const app = createApp();

  const { server, lifecycle } = listenWithLifecycle(app, {
    port: runtime.port,
    host: runtime.host,
    shutdownTimeoutMs: runtime.shutdownTimeoutMs,
    disconnectDb,
    onListening: (port, host) => {
      console.log(`Listening on ${host}:${port}`);

      // STARTS THE INDEXER HERE
      // startIndexer().catch((err: any) => {
      //   console.error("Failed to start Soroban Indexer:", err);
      // });

      // Backups are scheduled only by backup.crontab. runBackup itself also takes a
      // MongoDB lease, so overlapping cron/container invocations cannot run twice.
    },
  });

  // Optional in-process tick is registered after listen returns so the lifecycle
  // handle exists. Does not run backups — content/format unchanged (#171 non-goal).
  if (runtime.enableInprocessScheduler) {
    const startTick = () => {
      const tick = setInterval(() => {
        // Reserved for future non-backup in-process work. Intentionally empty.
      }, runtime.schedulerTickMs);
      lifecycle.trackTimer(tick);
      console.log(
        `[lifecycle] in-process scheduler tick every ${runtime.schedulerTickMs}ms (backups still cron-only)`,
      );
    };
    if (server.listening) startTick();
    else server.once("listening", startTick);
  }

  return { app, lifecycle };
}

// Boot the HTTP server. Lifecycle tests import lifecycle/runtime modules
// directly and do not load this entrypoint.
startServer();
