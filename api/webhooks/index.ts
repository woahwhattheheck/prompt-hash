/**
 * Serverless adapter for webhook subscriptions (#184).
 *
 * Thin HTTP shim over the shared webhook domain. Do not add auth, SSRF, or
 * event-filter logic here — put it in `src/lib/domain/webhookDomain.ts`.
 */
import { withObservability } from "../../src/lib/observability/wrapper";
import { sendDomainResult } from "../../src/lib/domain/domainResult";
import { handleWebhookHttp } from "../../src/lib/domain/webhookDomain";
import {
  createWebhookDomainDeps,
  ensureWebhookDb,
} from "../../src/lib/domain/webhookDeps";

async function handler(req: any, res: any) {
  try {
    await ensureWebhookDb();
    const result = await handleWebhookHttp(createWebhookDomainDeps(), {
      method: req.method,
      headers: req.headers,
      query: req.query ?? {},
      body: req.body ?? {},
    });
    sendDomainResult(res, result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export default withObservability(handler, "webhooks");
