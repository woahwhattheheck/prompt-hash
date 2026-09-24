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

## Tests

```bash
npm run test:sitemap-origin
```

## Non-goals

Sitemap ranking fields (`changefreq`, `priority`) are unchanged.
