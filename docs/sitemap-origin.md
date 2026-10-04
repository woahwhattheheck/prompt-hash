# Sitemap origin policy (#172)

## Problem

`api/sitemap.xml.ts` previously built canonical `<loc>` URLs from
`VERCEL_URL || req.headers.host` and cached the XML with a long shared
`s-maxage`. A client-controlled `Host` (or forwarded host) could poison
CDN-cached sitemap links.

## Policy

1. **Never** derive the sitemap origin from request headers (`Host`,
   `Forwarded`, `X-Forwarded-Host`, etc.).
2. Resolve origin in this order:
   - `SITE_URL` (preferred explicit canonical)
   - `APP_URL` (same semantics as notification email links)
   - `VERCEL_URL` (platform deployment host — validated, not request-controlled)
   - Non-production only: `http://localhost:5173`
3. Production with no validated source **fails closed** (`503`, `private, no-store`).
4. Every `<loc>` is built on the resolved origin, path-encoded, and XML-escaped.
5. **Shared caching** (`public`, `s-maxage=86400`) only when the origin came
   from `SITE_URL` / `APP_URL`. Otherwise `private, no-store`.

## Ops

Set `SITE_URL=https://<canonical-host>` (or `APP_URL`) on production so the
sitemap is cacheable and points at the public domain rather than a preview
`*.vercel.app` host.

## Catalog input and deployment boundary

`buildSitemapXml` accepts string or bigint prompt IDs. This matches the
`PromptRecord.id` values returned by the current client. Bigints become exact
decimal path segments without a `Number` conversion; string IDs retain the
existing path encoding and XML escaping. Inactive records remain excluded.

The [current handler](../api/sitemap.xml.ts) reads inventory through
`PromptHashClient.getAllPrompts(browserStellarConfig)`. On this branch, that
[client method](../src/lib/stellar/promptHashClient.ts) ignores its configuration
and returns two fixed active mock records. Configuring `SITE_URL`, `APP_URL`,
`VERCEL_URL`, or an RPC URL does not replace that catalog reader. An explicit
canonical origin can therefore enable the documented shared-cache policy for
a sitemap containing those mock records.

Production catalog integration remains separate work: connect an authoritative
inventory reader and verify its deployed sitemap entries. Origin validation,
encoding and cache-policy checks alone establish only those specific behaviors;
they do not establish live contract inventory or production deployment readiness.

## Tests

```bash
npm run test:sitemap-origin
npm run typecheck
```

The added client-record case uses the actual `PromptRecord` ID type and a bigint
above the safe integer range. Run both commands to check the typed assignment
and the XML output; the focused runtime command is not a full deployment check.

### Recorded bigint execution (2026-10-04)

One direct execution of `buildSitemapXml` passed on Node.js 24.19.0 (Linux x64)
using the existing bigint case's inputs: active `9007199254740993n` and inactive
`9007199254740995n`. The XML contained the exact active decimal ID, omitted the
rounded value `9007199254740992`, and omitted the inactive ID. The executed
module was copied byte-for-byte from commit
`1a8cee0471088e43d0c1b7e8c3f76f21720dec17`; its Git blob was
`76f982806de6bbde18a0d14914551992612ada9b`.

The same runtime check can be reproduced from the repository root:

```bash
node --experimental-strip-types --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { buildSitemapXml } from './src/lib/seo/sitemapOrigin.ts';
const xml = buildSitemapXml({
  origin: 'https://prompthash.io',
  lastmod: '2026-09-24',
  prompts: [
    { id: 9007199254740993n, active: true },
    { id: 9007199254740995n, active: false },
  ],
});
assert.ok(xml.includes('<loc>https://prompthash.io/prompts/9007199254740993</loc>'));
assert.ok(!xml.includes('9007199254740992'));
assert.ok(!xml.includes('9007199254740995'));
console.log('PASS: existing bigint sitemap case');
NODE
```

This executes the production XML builder with native type stripping. It does
not run Vitest, typecheck the `PromptRecord` assignment, execute the HTTP handler,
or establish lint, build or deployed-catalog results. The maintained
`npm run test:sitemap-origin` command remains unrun for this continuation;
its pinned Vitest/Vite runtime was unavailable in the checked workspace.

## Non-goals

Sitemap ranking fields (`changefreq`, `priority`) are unchanged.
