import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const root = process.cwd();
const sourceRef = process.env.CANDIDATE_REF;
const parentRef = process.env.BASELINE_REF;
const hookPath = "src/hooks/useSellerNotifications.ts";
const results = path.join(root, "acceptance-results");
fs.mkdirSync(results, { recursive: true });
const paths = [
  hookPath,
  "src/lib/notifications/sellerNotifications.test.ts",
  "src/lib/notifications/sellerNotifications.ts",
  "src/lib/notifications/sellerNotificationClient.ts",
  "src/lib/notifications/sellerNotificationCursor.ts",
  "src/lib/notifications/sellerNotificationTypes.ts",
];
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const candidate = fs.readFileSync(hookPath);
const sources = paths.map((file) => {
  const expected = git("rev-parse", sourceRef + ":" + file);
  const actual = git("hash-object", file);
  assert.equal(actual, expected, "Published source differs: " + file);
  return {
    path: file,
    gitBlob: actual,
    sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
  };
});

function run(label) {
  const outputFile = path.join(results, label + ".json");
  const started = performance.now();
  const child = spawnSync(process.execPath, [
    "node_modules/vitest/vitest.mjs",
    "run",
    "src/lib/notifications/sellerNotifications.test.ts",
    "--config", "scripts/seller-wallet.vitest.config.mjs",
    "--configLoader", "runner",
    "--reporter=verbose",
    "--reporter=json",
    "--outputFile=" + outputFile,
  ], { cwd: root, encoding: "utf8", timeout: 90_000 });
  const elapsedMs = performance.now() - started;
  const log = (child.stdout ?? "") + (child.stderr ?? "");
  fs.writeFileSync(path.join(results, label + ".log"), log);
  process.stdout.write(log);
  if (child.error) throw child.error;
  const report = JSON.parse(fs.readFileSync(outputFile, "utf8"));
  return { status: child.status, elapsedMs, report };
}

let before;
try {
  fs.writeFileSync(hookPath, execFileSync("git", ["show", parentRef + ":" + hookPath]));
  before = run("baseline");
  assert.equal(before.status, 1, "Baseline must fail the interaction regression");
  assert.equal(before.report.numTotalTests, 7);
  assert.equal(before.report.numPassedTests, 6);
  assert.equal(before.report.numFailedTests, 1);
  const failures = before.report.testResults.flatMap((r) =>
    r.assertionResults.filter((a) => a.status === "failed"),
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0].fullName, /isolates seller alerts on wallet changes/);
  assert.match(failures[0].failureMessages.join("\n"), /expected false to be true/);
} finally {
  fs.writeFileSync(hookPath, candidate);
}

const after = run("candidate");
assert.equal(after.status, 0, "Published source must pass");
assert.equal(after.report.numTotalTests, 7);
assert.equal(after.report.numPassedTests, 7);
assert.equal(after.report.numFailedTests, 0);
assert.equal(after.report.numPendingTests, 0);
for (const file of sources) {
  assert.equal(git("hash-object", file.path), file.gitBlob);
}

const packageVersions = Object.fromEntries([
  "vitest", "vite", "react", "react-dom",
  "@testing-library/react", "@testing-library/dom", "jsdom",
].map((name) => [name, JSON.parse(fs.readFileSync(path.join("node_modules", name, "package.json"), "utf8")).version]));
const evidence = {
  candidateRef: sourceRef,
  baselineRef: parentRef,
  node: process.version,
  packages: packageVersions,
  baseline: { passed: 6, failed: 1, total: 7, elapsedMs: before.elapsedMs },
  candidate: { passed: 7, failed: 0, total: 7, elapsedMs: after.elapsedMs },
  sources,
};
fs.writeFileSync(path.join(results, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
console.log("EXACT_SOURCE_EVIDENCE " + JSON.stringify(evidence));
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    "# Seller wallet isolation\n\n" +
    "Published source: `" + sourceRef + "`\n\n" +
    "Previous hook: 6 passed / 1 expected wallet-isolation failure.\n\n" +
    "Published hook: 7 passed / 0 failed / 0 skipped.\n\n" +
    "Existing test mocks control wallet, query and client boundaries; real React rendering and effects.\n");
}
