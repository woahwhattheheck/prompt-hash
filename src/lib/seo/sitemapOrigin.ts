/**
 * Canonical origin resolution for sitemap XML (#172).
 *
 * Request Host / Forwarded / X-Forwarded-* headers are never consulted.
 * Production requires a validated configured origin (SITE_URL / APP_URL) or a
 * validated platform VERCEL_URL; otherwise generation fails closed.
 */

export type SitemapOriginSource =
  | "site_url"
  | "app_url"
  | "vercel_url"
  | "dev_default";

export type ResolvedSitemapOrigin = {
  /** Scheme + host (+ non-default port). No path, query, hash, or credentials. */
  origin: string;
  source: SitemapOriginSource;
  /**
   * Shared edge/CDN caching is only safe when the origin came from an
   * explicit deployment config (SITE_URL / APP_URL).
   */
  cacheable: boolean;
};

export type ResolveSitemapOriginOptions = {
  /** Defaults to `env.NODE_ENV === "production"`. */
  isProduction?: boolean;
};

const DEV_DEFAULT_ORIGIN = "http://localhost:5173";

const SHARED_CACHE_CONTROL = "public, max-age=3600, s-maxage=86400";
const NO_STORE_CACHE_CONTROL = "private, no-store";

/** XML-escape text destined for sitemap element content (e.g. `<loc>`). */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function sitemapCacheControl(cacheable: boolean): string {
  return cacheable ? SHARED_CACHE_CONTROL : NO_STORE_CACHE_CONTROL;
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1"
  );
}

/**
 * Accept host-only values (e.g. VERCEL_URL) by prefixing https://.
 * Reject obvious CR/LF / whitespace smuggling before URL parse.
 */
function normalizeOriginCandidate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/[\r\n\t\0]/.test(trimmed) || /\s/.test(trimmed)) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

/**
 * Returns a canonical origin string, or null if the candidate is unsafe /
 * unusable for sitemap `<loc>` URLs.
 */
export function validateSitemapOrigin(
  raw: string,
  options: { allowHttpLoopback?: boolean } = {},
): string | null {
  const normalized = normalizeOriginCandidate(raw);
  if (!normalized) return null;

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol === "https:") {
    // ok
  } else if (
    protocol === "http:" &&
    options.allowHttpLoopback &&
    isLoopbackHostname(parsed.hostname)
  ) {
    // ok — local dev only
  } else {
    return null;
  }

  if (parsed.username || parsed.password) return null;
  if (!parsed.hostname) return null;

  // Reject weird / empty hostnames and header-injection style values that
  // somehow survived trim (URL parser can be permissive).
  if (/[\s<>"'`]/.test(parsed.hostname)) return null;

  return parsed.origin;
}

type EnvLike = Record<string, string | undefined>;

/**
 * Resolve the sitemap base origin without reading any request headers.
 * Returns null in production when no trusted origin can be validated.
 */
export function resolveSitemapOrigin(
  env: EnvLike = process.env,
  options: ResolveSitemapOriginOptions = {},
): ResolvedSitemapOrigin | null {
  const isProduction =
    options.isProduction ?? env.NODE_ENV === "production";
  const allowHttpLoopback = !isProduction;

  const configured: Array<{ key: "SITE_URL" | "APP_URL"; source: SitemapOriginSource }> =
    [
      { key: "SITE_URL", source: "site_url" },
      { key: "APP_URL", source: "app_url" },
    ];

  for (const { key, source } of configured) {
    const raw = env[key];
    if (!raw) continue;
    const origin = validateSitemapOrigin(raw, { allowHttpLoopback });
    if (origin) {
      return { origin, source, cacheable: true };
    }
  }

  const vercelRaw = env.VERCEL_URL;
  if (vercelRaw) {
    const origin = validateSitemapOrigin(vercelRaw, {
      // Platform host is never loopback http; require https.
      allowHttpLoopback: false,
    });
    if (origin) {
      return { origin, source: "vercel_url", cacheable: false };
    }
  }

  if (!isProduction) {
    return {
      origin: DEV_DEFAULT_ORIGIN,
      source: "dev_default",
      cacheable: false,
    };
  }

  return null;
}

/**
 * Build an absolute sitemap location URL on the given origin, encoding each
 * path segment and XML-escaping the final string for `<loc>` content.
 */
export function buildSitemapLoc(
  origin: string,
  pathSegments: readonly string[] = [],
): string {
  const base = origin.endsWith("/") ? origin : `${origin}/`;
  const path =
    pathSegments.length === 0
      ? ""
      : pathSegments.map((segment) => encodeURIComponent(segment)).join("/");
  const absolute = new URL(path, base).toString();
  // Root should keep a trailing slash for the homepage entry.
  if (pathSegments.length === 0) {
    const root = absolute.endsWith("/") ? absolute : `${absolute}/`;
    return escapeXml(root);
  }
  return escapeXml(absolute);
}

export type SitemapPromptEntry = {
  id: string;
  active?: boolean;
};

export type BuildSitemapXmlInput = {
  origin: string;
  prompts: readonly SitemapPromptEntry[];
  /** YYYY-MM-DD; defaults to UTC today. */
  lastmod?: string;
};

/** Pure sitemap XML builder (ranking priorities unchanged from prior handler). */
export function buildSitemapXml(input: BuildSitemapXmlInput): string {
  const lastmod =
    input.lastmod ?? new Date().toISOString().split("T")[0]!;
  const home = buildSitemapLoc(input.origin);
  const browse = buildSitemapLoc(input.origin, ["browse"]);

  const promptUrls = input.prompts
    .filter((prompt) => Boolean(prompt.active))
    .map((prompt) => {
      const loc = buildSitemapLoc(input.origin, ["prompts", prompt.id]);
      return `
  <url>
    <loc>${loc}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${home}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${browse}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>${promptUrls}
</urlset>`;
}
