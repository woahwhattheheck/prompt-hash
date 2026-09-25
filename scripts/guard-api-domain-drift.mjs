#!/usr/bin/env node
/**
 * CI drift guard (#184): consolidated domain capabilities must not reintroduce
 * inline business logic in serverless or Express adapters.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

const REQUIRED = [
  {
    file: "api/prompts/version.ts",
    mustInclude: ["promptVersioningDomain", "domainResult"],
    forbid: [
      /function\s+isAdminRequest\s*\(/,
      /function\s+validateSigned\w*\s*\(/,
      /Purchase\.findOne/,
      /PromptVersion\.findOne/,
      /publishPromptVersion\s*\(/,
    ],
  },
  {
    file: "api/webhooks/index.ts",
    mustInclude: ["webhookDomain", "domainResult"],
    forbid: [
      /function\s+isAdminRequest\s*\(/,
      /function\s+validateSigned\w*\s*\(/,
      /WebhookSubscription\.(findOne|deleteOne|create)/,
      /validateWebhookUrl\s*\(/,
    ],
  },
  {
    file: "server/src/controllers/versioningControllers.ts",
    mustInclude: ["promptVersioningDomain", "domainResult"],
    forbid: [
      /Purchase\.findOne/,
      /PromptVersion\.findOne/,
      /publishPromptVersion\s*\(/,
      /User\.findOne/,
    ],
  },
  {
    file: "server/src/controllers/webhookControllers.ts",
    mustInclude: ["webhookDomain", "domainResult"],
    forbid: [
      /function\s+isAdminRequest\s*\(/,
      /function\s+validateSigned\w*\s*\(/,
      /WebhookSubscription\.(findOne|deleteOne)/,
      /validateWebhookUrl\s*\(/,
    ],
  },
];

let failed = false;

for (const rule of REQUIRED) {
  const full = join(root, rule.file);
  if (!existsSync(full)) {
    console.error(`[api-domain-drift] missing required adapter: ${rule.file}`);
    failed = true;
    continue;
  }
  const text = readFileSync(full, "utf8");
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  for (const needle of rule.mustInclude) {
    if (!text.includes(needle)) {
      console.error(
        `[api-domain-drift] ${rule.file} must reference shared domain module "${needle}"`,
      );
      failed = true;
    }
  }
  for (const pattern of rule.forbid) {
    if (pattern.test(stripped)) {
      console.error(
        `[api-domain-drift] ${rule.file} reintroduces forbidden inline domain logic: ${pattern}`,
      );
      failed = true;
    }
  }
}

const serverChallenge = join(root, "server/src/utils/challengeSignature.ts");
if (existsSync(serverChallenge)) {
  const text = readFileSync(serverChallenge, "utf8");
  if (!text.includes("src/lib/auth/challenge")) {
    console.error(
      "[api-domain-drift] server/src/utils/challengeSignature.ts must re-export src/lib/auth/challenge",
    );
    failed = true;
  }
  if (/Keypair\.fromPublicKey/.test(text) || /\.verify\(/.test(text)) {
    console.error(
      "[api-domain-drift] server/src/utils/challengeSignature.ts must not reimplement signature verify",
    );
    failed = true;
  }
}

if (failed) {
  console.error("[api-domain-drift] FAILED — see docs/api-adapter-consolidation.md");
  process.exit(1);
}
console.log("[api-domain-drift] OK — versioning + webhook adapters stay thin");
