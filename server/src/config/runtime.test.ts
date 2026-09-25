import { loadRuntimeConfig, RUNTIME_DEFAULTS } from "./runtime";

describe("loadRuntimeConfig", () => {
  it("returns frozen defaults when env is empty", () => {
    const cfg = loadRuntimeConfig({});
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(cfg).toEqual(RUNTIME_DEFAULTS);
  });

  it("honors a deployment-provided PORT", () => {
    expect(loadRuntimeConfig({ PORT: "8080" }).port).toBe(8080);
  });

  it("honors HOST and SHUTDOWN_TIMEOUT_MS", () => {
    const cfg = loadRuntimeConfig({
      HOST: "127.0.0.1",
      SHUTDOWN_TIMEOUT_MS: "2500",
    });
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.shutdownTimeoutMs).toBe(2500);
  });

  it("rejects non-integer / out-of-range PORT", () => {
    expect(() => loadRuntimeConfig({ PORT: "0" })).toThrow(/Invalid runtime configuration/);
    expect(() => loadRuntimeConfig({ PORT: "65536" })).toThrow(/Invalid runtime configuration/);
    expect(() => loadRuntimeConfig({ PORT: "abc" })).toThrow(/Invalid runtime configuration/);
    expect(() => loadRuntimeConfig({ PORT: "5000.5" })).toThrow(/Invalid runtime configuration/);
  });

  it("rejects invalid SHUTDOWN_TIMEOUT_MS", () => {
    expect(() => loadRuntimeConfig({ SHUTDOWN_TIMEOUT_MS: "50" })).toThrow(
      /Invalid runtime configuration/,
    );
    expect(() => loadRuntimeConfig({ SHUTDOWN_TIMEOUT_MS: "nope" })).toThrow(
      /Invalid runtime configuration/,
    );
  });

  it("validates optional scheduler knobs", () => {
    expect(
      loadRuntimeConfig({
        ENABLE_INPROCESS_SCHEDULER: "true",
        SCHEDULER_TICK_MS: "5000",
      }),
    ).toMatchObject({ enableInprocessScheduler: true, schedulerTickMs: 5000 });

    expect(() => loadRuntimeConfig({ ENABLE_INPROCESS_SCHEDULER: "maybe" })).toThrow(
      /Invalid runtime configuration/,
    );
    expect(() =>
      loadRuntimeConfig({
        ENABLE_INPROCESS_SCHEDULER: "1",
        SCHEDULER_TICK_MS: "10",
      }),
    ).toThrow(/Invalid runtime configuration/);
  });

  it("keeps in-process scheduler off by default (backups stay cron-only)", () => {
    expect(loadRuntimeConfig({}).enableInprocessScheduler).toBe(false);
  });
});
