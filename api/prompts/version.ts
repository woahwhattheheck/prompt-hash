/**
 * Serverless adapter for prompt versioning (#184).
 *
 * Thin HTTP shim over the shared prompt-versioning domain. Do not add
 * validation or entitlement logic here — put it in
 * `src/lib/domain/promptVersioningDomain.ts` so Express stays in lockstep.
 */
import { withObservability } from "../../src/lib/observability/wrapper";
import { sendDomainResult } from "../../src/lib/domain/domainResult";
import { handlePromptVersionHttp } from "../../src/lib/domain/promptVersioningDomain";
import {
  createPromptVersioningDeps,
  ensureDb,
} from "../../src/lib/domain/promptVersioningDeps";

async function handler(req: any, res: any) {
  try {
    await ensureDb();
    const result = await handlePromptVersionHttp(createPromptVersioningDeps(), {
      method: req.method,
      query: req.query ?? {},
      body: req.body ?? {},
    });
    sendDomainResult(res, result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export default withObservability(handler, "prompts/version");
