#!/usr/bin/env node
/**
 * Release-safety guard (#154): production marketplace sources must not contain
 * stochastic transaction outcomes or synthetic random tx hashes.
 *
 * Usage:
 *   node scripts/guard-no-stochastic-marketplace.mjs
 *   node scripts/guard-no-stochastic-marketplace.mjs --bundle dist
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const args = process.argv.slice(2);
const bundleIdx = args.indexOf("--bundle");
const bundleDir = bundleIdx >= 0 ? args[bundleIdx + 1] : null;

const SOURCE_PATHS = [
  "src/pages/Sell.tsx",
  "src/pages/Marketplace.tsx",
  "src/components/PurchaseProgress.tsx",
  "src/pages/browse/PromptModal.tsx",
  "src/lib/stellar/promptHashClient.ts",
  "src/lib/marketplace/productionMarketplaceAdapter.ts",
  "src/lib/marketplace/marketplaceTx.ts",
];

const FORBIDDEN = [
  {
    name: "Math.random in marketplace tx path",
    // Allow comments that say "no Math.random" / "never Math.random"
    test: (text) => {
      const withoutComments = text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      return /Math\.random\s*\(/.test(withoutComments);
    },
  },
  {
    name: "inline synthetic tx_ + Math.random hash",
    test: (text) => {
      const withoutComments = text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      return /["']tx_["']\s*\+\s*Math\.random/.test(withoutComments);
    },
  },
];

function walkJs(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkJs(full, out);
    else if (/\.(js|mjs|cjs|css)$/.test(entry)) out.push(full);
  }
  return out;
}

let failed = 0;

console.log("Marketplace stochastic-tx guard (#154)\n");

for (const rel of SOURCE_PATHS) {
  const full = join(root, rel);
  if (!existsSync(full)) {
    console.log(`  ✖ missing ${rel}`);
    failed++;
    continue;
  }
  const text = readFileSync(full, "utf8");
  let fileFailed = false;
  for (const rule of FORBIDDEN) {
    if (rule.test(text)) {
      console.log(`  ✖ ${rel}: ${rule.name}`);
      failed++;
      fileFailed = true;
    }
  }
  if (!fileFailed) console.log(`  ✔ ${rel}`);
}

// Demo adapter may exist but must not be reachable without opt-in; still forbid Math.random there.
const demoAdapter = join(root, "src/lib/marketplace/demo/demoMarketplaceAdapter.ts");
if (existsSync(demoAdapter)) {
  const text = readFileSync(demoAdapter, "utf8");
  if (/Math\.random\s*\(/.test(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1"))) {
    console.log("  ✖ demo adapter still uses Math.random (must be deterministic)");
    failed++;
  } else {
    console.log("  ✔ demo adapter is deterministic");
  }
}

if (bundleDir) {
  const files = walkJs(join(root, bundleDir));
  const demoFlag = /VITE_ENABLE_DEMO_MARKETPLACE["']?\s*[:=]\s*["']1["']/;
  let bundleHits = 0;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    // Production bundles must not embed stochastic marketplace helpers.
    if (/Math\.random\(\)[^;]{0,80}(op_not_authorized|op_underfunded|tx_)/.test(text)) {
      console.log(`  ✖ bundle ${relative(root, file)}: stochastic marketplace pattern`);
      bundleHits++;
    }
    if (demoFlag.test(text)) {
      console.log(`  ✖ bundle ${relative(root, file)}: demo marketplace flag baked as enabled`);
      bundleHits++;
    }
  }
  if (bundleHits === 0) {
    console.log(`  ✔ bundle scan clean (${files.length} files under ${bundleDir})`);
  }
  failed += bundleHits;
}

if (failed > 0) {
  console.error(`\nGuard failed with ${failed} finding(s).`);
  process.exit(1);
}

console.log("\nAll marketplace stochastic-tx checks passed.");
