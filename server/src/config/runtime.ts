/**
 * Validated process runtime config for the Express server (issue #171).
 * Port / host / shutdown bound / optional in-process scheduler knobs.
 * Backup content and schedule remain cron-driven (backup.crontab) — non-goal.
 */
import { z } from "zod";

const DEFAULT_PORT = 5000;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 300_000;
const DEFAULT_SCHEDULER_TICK_MS = 60_000;

function envBool(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw == null || raw === "") return defaultValue;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`expected boolean, got ${JSON.stringify(raw)}`);
}

function envInt(
  raw: string | undefined,
  opts: { defaultValue: number; min: number; max: number; name: string },
): number {
  if (raw == null || raw === "") return opts.defaultValue;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < opts.min || n > opts.max) {
    throw new Error(
      `${opts.name} must be an integer between ${opts.min} and ${opts.max}, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

const schema = z.object({
  port: z.number().int().min(1).max(65535),
  host: z.string().min(1),
  shutdownTimeoutMs: z.number().int().min(100).max(MAX_SHUTDOWN_TIMEOUT_MS),
  enableInprocessScheduler: z.boolean(),
  schedulerTickMs: z.number().int().min(100).max(24 * 60 * 60 * 1000),
});

export type RuntimeConfig = z.infer<typeof schema>;

/**
 * Load and validate runtime settings from an env-like source.
 * Throws a descriptive Error on invalid values (fail-fast at boot).
 */
export function loadRuntimeConfig(source: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  let enableInprocessScheduler: boolean;
  try {
    enableInprocessScheduler = envBool(source.ENABLE_INPROCESS_SCHEDULER, false);
  } catch (err) {
    throw new Error(
      `Invalid runtime configuration: ENABLE_INPROCESS_SCHEDULER: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let port: number;
  let shutdownTimeoutMs: number;
  let schedulerTickMs: number;
  try {
    port = envInt(source.PORT, {
      defaultValue: DEFAULT_PORT,
      min: 1,
      max: 65535,
      name: "PORT",
    });
    shutdownTimeoutMs = envInt(source.SHUTDOWN_TIMEOUT_MS, {
      defaultValue: DEFAULT_SHUTDOWN_TIMEOUT_MS,
      min: 100,
      max: MAX_SHUTDOWN_TIMEOUT_MS,
      name: "SHUTDOWN_TIMEOUT_MS",
    });
    schedulerTickMs = envInt(source.SCHEDULER_TICK_MS, {
      defaultValue: DEFAULT_SCHEDULER_TICK_MS,
      min: 100,
      max: 24 * 60 * 60 * 1000,
      name: "SCHEDULER_TICK_MS",
    });
  } catch (err) {
    throw new Error(
      `Invalid runtime configuration: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const hostRaw = source.HOST;
  const host =
    hostRaw == null || hostRaw === "" ? DEFAULT_HOST : hostRaw.trim();
  if (!host) {
    throw new Error("Invalid runtime configuration: HOST must be a non-empty string");
  }

  if (enableInprocessScheduler && schedulerTickMs < 100) {
    throw new Error(
      "Invalid runtime configuration: SCHEDULER_TICK_MS must be >= 100 when ENABLE_INPROCESS_SCHEDULER=true",
    );
  }

  const parsed = schema.safeParse({
    port,
    host,
    shutdownTimeoutMs,
    enableInprocessScheduler,
    schedulerTickMs,
  });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid runtime configuration: ${details}`);
  }
  return Object.freeze(parsed.data);
}

export const RUNTIME_DEFAULTS = Object.freeze({
  port: DEFAULT_PORT,
  host: DEFAULT_HOST,
  shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
  enableInprocessScheduler: false,
  schedulerTickMs: DEFAULT_SCHEDULER_TICK_MS,
});
