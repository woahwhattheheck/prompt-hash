/**
 * Opt-in demo marketplace mode (#154).
 *
 * Demo fixtures are NEVER enabled in production builds. In development they
 * require an explicit signal (?demo=1, ?e2e=1, VITE_ENABLE_DEMO_MARKETPLACE=1,
 * or Vitest's test mode).
 */

export function isProductionBuild(): boolean {
  return import.meta.env.PROD === true;
}

function readQueryFlag(name: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get(name) === "1";
  } catch {
    return false;
  }
}

/** True only when deterministic demo/test marketplace adapters may run. */
export function isDemoMarketplaceEnabled(): boolean {
  if (isProductionBuild()) return false;
  if (import.meta.env.MODE === "test") return true;
  if (import.meta.env.VITE_ENABLE_DEMO_MARKETPLACE === "1") return true;
  return readQueryFlag("demo") || readQueryFlag("e2e");
}

/** Startup / build guard: demo flag must never ship enabled in production. */
export function assertDemoMarketplaceSafe(): void {
  if (
    isProductionBuild() &&
    import.meta.env.VITE_ENABLE_DEMO_MARKETPLACE === "1"
  ) {
    throw new Error(
      "[release-safety] VITE_ENABLE_DEMO_MARKETPLACE must not be set in production builds (#154).",
    );
  }
}

export function requireDemoMarketplace(context: string): void {
  if (!isDemoMarketplaceEnabled()) {
    throw new Error(
      `[release-safety] ${context} requires opt-in demo marketplace mode (?demo=1, ?e2e=1, or VITE_ENABLE_DEMO_MARKETPLACE=1). Stochastic mocks are disabled outside demo mode (#154).`,
    );
  }
}
