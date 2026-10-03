import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guard = join(root, "scripts/guard-no-stochastic-marketplace.mjs");

function runGuard(args = []) {
  const result = spawnSync(process.execPath, [guard, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { status: result.status, output: result.stdout + result.stderr };
}

function withBundle(files, check) {
  const dir = mkdtempSync(join(tmpdir(), "marketplace-guard-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const path = join(dir, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    check(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertRejected(args, message) {
  const result = runGuard(args);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, message);
  assert.doesNotMatch(
    result.output,
    /bundle scan clean|All marketplace stochastic-tx checks passed/,
  );
}

test("no arguments preserves the source-only check", () => {
  const result = runGuard();
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /All marketplace stochastic-tx checks passed/);
  assert.doesNotMatch(result.output, /bundle scan/);
});

for (const [name, args] of [
  ["missing bundle argument", ["--bundle"]],
  ["empty bundle argument", ["--bundle", ""]],
  ["blank bundle argument", ["--bundle", "   "]],
  ["another flag as the bundle argument", ["--bundle", "--help"]],
  ["unknown option", ["--bundel", "dist"]],
  ["duplicate bundle options", ["--bundle", "dist", "--bundle", "other-dist"]],
]) {
  test(`rejects ${name}`, () => {
    assertRejected(args, /Usage:.*\[--bundle <directory>\]/);
  });
}

test("rejects a missing bundle directory", () => {
  withBundle({}, (dir) => {
    assertRejected(
      ["--bundle", relative(root, join(dir, "not-built"))],
      /bundle.*directory/i,
    );
  });
});

test("rejects a file in place of a bundle directory", () => {
  withBundle({ "index.js": "export const ready = true;" }, (dir) => {
    assertRejected(
      ["--bundle", relative(root, join(dir, "index.js"))],
      /ENOTDIR|bundle.*directory/i,
    );
  });
});

for (const [name, files] of [
  ["empty output", {}],
  ["CSS-only output", { "assets/app.css": "body { color: black; }" }],
  ["source maps without JavaScript", { "assets/app.js.map": "{}" }],
  ["zero-byte JavaScript", { "assets/app.js": "" }],
  ["blank JavaScript", { "assets/app.mjs": " \n\t " }],
]) {
  test(`rejects ${name}`, () => {
    withBundle(files, (dir) => {
      assertRejected(
        ["--bundle", relative(root, dir)],
        /no nonempty JavaScript/i,
      );
    });
  });
}

for (const [extension, absolute] of [
  ["js", true],
  ["mjs", false],
  ["cjs", false],
]) {
  test(`scans nested ${extension} output through an ${absolute ? "absolute" : "ordinary relative"} path`, () => {
    withBundle(
      { [`assets/app.${extension}`]: "console.log('ready');" },
      (dir) => {
        const result = runGuard([
          "--bundle",
          absolute ? dir : relative(root, dir),
        ]);
        assert.equal(result.status, 0, result.output);
        assert.match(result.output, /bundle scan clean \(1 files under /);
        assert.match(
          result.output,
          /All marketplace stochastic-tx checks passed/,
        );
      },
    );
  });
}

for (const [name, content, message] of [
  [
    "demo hashes",
    'export const tx = "tx_demo_success_00000001";',
    /deterministic demo marketplace fixture/,
  ],
  [
    "random transaction hashes",
    'export const tx = Math.random() + "tx_";',
    /stochastic marketplace pattern/,
  ],
  [
    "enabled demo flags",
    'const VITE_ENABLE_DEMO_MARKETPLACE = "1";',
    /demo marketplace flag baked as enabled/,
  ],
]) {
  test(`rejects ${name} even alongside a clean JavaScript artifact`, () => {
    withBundle(
      {
        "assets/clean.js": "console.log('ready');",
        "assets/unsafe.mjs": content,
      },
      (dir) => {
        assertRejected(["--bundle", relative(root, dir)], message);
      },
    );
  });
}
