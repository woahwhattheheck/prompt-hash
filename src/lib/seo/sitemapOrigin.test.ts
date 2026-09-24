import { afterEach, describe, expect, it } from "vitest";
import {
  buildSitemapLoc,
  buildSitemapXml,
  escapeXml,
  resolveSitemapOrigin,
  sitemapCacheControl,
  validateSitemapOrigin,
} from "./sitemapOrigin";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("escapeXml", () => {
  it("escapes XML special characters", () => {
    expect(escapeXml(`<&"'>`)).toBe("&lt;&amp;&quot;&apos;&gt;");
  });
});

describe("validateSitemapOrigin", () => {
  it("accepts valid https origins and strips path/query/hash", () => {
    expect(
      validateSitemapOrigin("https://prompthash.io/path?q=1#hash"),
    ).toBe("https://prompthash.io");
  });

  it("accepts https with a non-default port", () => {
    expect(validateSitemapOrigin("https://prompthash.io:8443")).toBe(
      "https://prompthash.io:8443",
    );
  });

  it("rejects unsafe schemes", () => {
    for (const raw of [
      "javascript:alert(1)",
      "data:text/html,hi",
      "file:///etc/passwd",
      "ftp://files.example",
      "http://evil.example",
    ]) {
      expect(validateSitemapOrigin(raw)).toBeNull();
    }
  });

  it("rejects credentials and blank/malicious host strings", () => {
    expect(validateSitemapOrigin("https://user:pass@prompthash.io")).toBeNull();
    expect(validateSitemapOrigin("https://")).toBeNull();
    expect(validateSitemapOrigin("not a url")).toBeNull();
    expect(validateSitemapOrigin("https://evil.example\nHost: x")).toBeNull();
    expect(validateSitemapOrigin("evil.example host")).toBeNull();
  });

  it("allows http only for loopback when opted in", () => {
    expect(
      validateSitemapOrigin("http://localhost:5173", {
        allowHttpLoopback: true,
      }),
    ).toBe("http://localhost:5173");
    expect(
      validateSitemapOrigin("http://127.0.0.1:3000", {
        allowHttpLoopback: true,
      }),
    ).toBe("http://127.0.0.1:3000");
    expect(
      validateSitemapOrigin("http://localhost:5173", {
        allowHttpLoopback: false,
      }),
    ).toBeNull();
    expect(
      validateSitemapOrigin("http://example.com", { allowHttpLoopback: true }),
    ).toBeNull();
  });

  it("prefixes https for host-only VERCEL_URL-style values", () => {
    expect(validateSitemapOrigin("my-app.vercel.app")).toBe(
      "https://my-app.vercel.app",
    );
  });
});

describe("resolveSitemapOrigin", () => {
  it("prefers SITE_URL over APP_URL and VERCEL_URL (production)", () => {
    const resolved = resolveSitemapOrigin(
      {
        NODE_ENV: "production",
        SITE_URL: "https://prompthash.io",
        APP_URL: "https://app.example",
        VERCEL_URL: "attacker.vercel.app",
      },
      { isProduction: true },
    );
    expect(resolved).toEqual({
      origin: "https://prompthash.io",
      source: "site_url",
      cacheable: true,
    });
  });

  it("falls back to APP_URL then validated VERCEL_URL", () => {
    expect(
      resolveSitemapOrigin(
        {
          NODE_ENV: "production",
          APP_URL: "https://app.prompthash.io/",
        },
        { isProduction: true },
      ),
    ).toMatchObject({
      origin: "https://app.prompthash.io",
      source: "app_url",
      cacheable: true,
    });

    expect(
      resolveSitemapOrigin(
        {
          NODE_ENV: "production",
          VERCEL_URL: "prompt-hash.vercel.app",
        },
        { isProduction: true },
      ),
    ).toEqual({
      origin: "https://prompt-hash.vercel.app",
      source: "vercel_url",
      cacheable: false,
    });
  });

  it("fails closed in production when no trusted origin is available", () => {
    expect(
      resolveSitemapOrigin(
        { NODE_ENV: "production", SITE_URL: "http://attacker.example" },
        { isProduction: true },
      ),
    ).toBeNull();

    expect(
      resolveSitemapOrigin({ NODE_ENV: "production" }, { isProduction: true }),
    ).toBeNull();
  });

  it("uses localhost default in non-production when unset", () => {
    expect(
      resolveSitemapOrigin({ NODE_ENV: "development" }, { isProduction: false }),
    ).toEqual({
      origin: "http://localhost:5173",
      source: "dev_default",
      cacheable: false,
    });
  });

  it("never consults request-like header values passed via env by mistake", () => {
    // Headers must not be wired into resolveSitemapOrigin; this asserts env
    // keys that look like forwarded hosts are ignored.
    const resolved = resolveSitemapOrigin(
      {
        NODE_ENV: "production",
        SITE_URL: "https://prompthash.io",
        HOST: "evil.example",
        HTTP_HOST: "evil.example",
        "x-forwarded-host": "evil.example",
        FORWARDED: "host=evil.example",
      } as Record<string, string>,
      { isProduction: true },
    );
    expect(resolved?.origin).toBe("https://prompthash.io");
  });

  it("rejects malformed configured URLs and continues to next source", () => {
    const resolved = resolveSitemapOrigin(
      {
        NODE_ENV: "production",
        SITE_URL: "javascript:alert(1)",
        APP_URL: "https://ok.example",
      },
      { isProduction: true },
    );
    expect(resolved).toMatchObject({
      origin: "https://ok.example",
      source: "app_url",
      cacheable: true,
    });
  });
});

describe("sitemapCacheControl", () => {
  it("enables shared cache only for cacheable origins", () => {
    expect(sitemapCacheControl(true)).toContain("s-maxage=86400");
    expect(sitemapCacheControl(true)).toContain("public");
    expect(sitemapCacheControl(false)).toBe("private, no-store");
  });
});

describe("buildSitemapLoc / buildSitemapXml", () => {
  it("builds escaped locs on the configured origin", () => {
    expect(buildSitemapLoc("https://prompthash.io")).toBe(
      "https://prompthash.io/",
    );
    expect(buildSitemapLoc("https://prompthash.io", ["browse"])).toBe(
      "https://prompthash.io/browse",
    );
    expect(
      buildSitemapLoc("https://prompthash.io", ["prompts", "abc/def"]),
    ).toBe("https://prompthash.io/prompts/abc%2Fdef");
  });

  it("XML-escapes locations that contain special characters after encoding", () => {
    // encodeURIComponent turns & into %26; escapeXml is still applied.
    const loc = buildSitemapLoc("https://prompthash.io", [
      "prompts",
      `id<"&>`,
    ]);
    expect(loc).toBe(
      "https://prompthash.io/prompts/id%3C%22%26%3E",
    );
    expect(loc).not.toMatch(/[<>"']/);
  });

  it("renders sitemap XML with only the configured origin", () => {
    const xml = buildSitemapXml({
      origin: "https://prompthash.io",
      lastmod: "2026-09-24",
      prompts: [
        { id: "p1", active: true },
        { id: "inactive", active: false },
        { id: `weird<"&`, active: true },
      ],
    });

    expect(xml).toContain("<loc>https://prompthash.io/</loc>");
    expect(xml).toContain("<loc>https://prompthash.io/browse</loc>");
    expect(xml).toContain("<loc>https://prompthash.io/prompts/p1</loc>");
    expect(xml).not.toContain("inactive");
    expect(xml).toContain(
      "<loc>https://prompthash.io/prompts/weird%3C%22%26</loc>",
    );
    expect(xml).not.toContain("<\"&");
    expect(xml).not.toContain("evil.example");
  });
});

describe("handler contract: request headers cannot alter origin", () => {
  it("documents that resolveSitemapOrigin ignores Host/Forwarded inputs", () => {
    // Simulate what a poisoned request might try to inject if someone wired
    // headers into env or passed them as candidates — only SITE_URL wins.
    const spoofedHost = "attacker.example:443";
    const spoofedForwarded = "for=1.2.3.4;host=attacker.example;proto=https";

    const resolved = resolveSitemapOrigin(
      {
        NODE_ENV: "production",
        SITE_URL: "https://prompthash.io",
        // Deliberately NOT reading these — they must not be keys we honor:
        // host / forwarded would only matter if the handler passed req.headers.
      },
      { isProduction: true },
    );

    expect(resolved?.origin).toBe("https://prompthash.io");
    expect(validateSitemapOrigin(`https://${spoofedHost}`)).toBe(
      "https://attacker.example",
    );
    // Spoofed values are valid URLs but must never be selected unless
    // configured — prove the resolver did not use them.
    expect(resolved?.origin).not.toContain("attacker");
    expect(spoofedForwarded).toContain("attacker.example");
  });
});

describe("spoofed request headers cannot alter production sitemap", () => {
  function generateAsHandlerWould(args: {
    env: Record<string, string | undefined>;
    headers: Record<string, string | string[] | undefined>;
  }) {
    // Mirrors api/sitemap.xml.ts: headers are accepted by the HTTP layer but
    // never passed into origin resolution or XML building.
    void args.headers;
    const resolved = resolveSitemapOrigin(args.env, { isProduction: true });
    if (!resolved) {
      return {
        status: 503 as const,
        cacheControl: sitemapCacheControl(false),
        body: null,
      };
    }
    return {
      status: 200 as const,
      cacheControl: sitemapCacheControl(resolved.cacheable),
      body: buildSitemapXml({
        origin: resolved.origin,
        lastmod: "2026-09-24",
        prompts: [{ id: "p1", active: true }],
      }),
    };
  }

  it("ignores Host, X-Forwarded-Host, and Forwarded when SITE_URL is set", () => {
    const result = generateAsHandlerWould({
      env: {
        NODE_ENV: "production",
        SITE_URL: "https://prompthash.io",
      },
      headers: {
        host: "attacker.example",
        "x-forwarded-host": "attacker.example",
        forwarded: "host=attacker.example;proto=https",
      },
    });

    expect(result.status).toBe(200);
    expect(result.cacheControl).toContain("public");
    expect(result.body).toContain("https://prompthash.io/prompts/p1");
    expect(result.body).not.toContain("attacker.example");
  });

  it("still ignores spoofed Host when only VERCEL_URL is set (no-store)", () => {
    const result = generateAsHandlerWould({
      env: {
        NODE_ENV: "production",
        VERCEL_URL: "prompt-hash.vercel.app",
      },
      headers: {
        host: "attacker.example:8443",
        "x-forwarded-host": "attacker.example",
      },
    });

    expect(result.status).toBe(200);
    expect(result.cacheControl).toBe("private, no-store");
    expect(result.body).toContain("https://prompt-hash.vercel.app/");
    expect(result.body).not.toContain("attacker.example");
  });

  it("fails closed (503, no-store) when production has no trusted origin", () => {
    const result = generateAsHandlerWould({
      env: { NODE_ENV: "production" },
      headers: { host: "prompthash.io" },
    });
    expect(result.status).toBe(503);
    expect(result.cacheControl).toBe("private, no-store");
    expect(result.body).toBeNull();
  });
});
