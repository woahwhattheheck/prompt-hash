import type { VercelRequest, VercelResponse } from "@vercel/node";
// Using the mocked client to get all available prompts
import { PromptHashClient } from "../src/lib/stellar/promptHashClient";
import { browserStellarConfig } from "../src/lib/stellar/browserConfig";
import {
  buildSitemapXml,
  resolveSitemapOrigin,
  sitemapCacheControl,
} from "../src/lib/seo/sitemapOrigin";

/**
 * Sitemap generator.
 *
 * Origin is resolved from deployment config only (SITE_URL / APP_URL /
 * VERCEL_URL). Request Host / Forwarded headers are intentionally ignored
 * so a poisoned Host cannot poison shared-cache canonical URLs (#172).
 */
export default async function handler(
  _req: VercelRequest,
  res: VercelResponse,
) {
  try {
    const resolved = resolveSitemapOrigin(process.env);
    if (!resolved) {
      res.setHeader("Cache-Control", sitemapCacheControl(false));
      res.status(503).send("Sitemap origin is not configured");
      return;
    }

    const prompts = await PromptHashClient.getAllPrompts(browserStellarConfig);
    const sitemap = buildSitemapXml({
      origin: resolved.origin,
      prompts,
    });

    res.setHeader("Content-Type", "text/xml; charset=utf-8");
    res.setHeader("Cache-Control", sitemapCacheControl(resolved.cacheable));
    res.status(200).send(sitemap);
  } catch (error) {
    console.error("Failed to generate sitemap:", error);
    res.setHeader("Cache-Control", sitemapCacheControl(false));
    res.status(500).end();
  }
}
