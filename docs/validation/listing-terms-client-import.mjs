import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SourceTextModule } from "node:vm";
import { createServer } from "vite";

// Run with --experimental-vm-modules. This executes Vite's served client
// module graph using the native ESM linker; it does not launch a browser.
const root = resolve(process.argv[2] ?? ".");
const client = readFileSync(join(root, "src/lib/prompts/unlock.ts"), "utf8");
const importedTerms =
  /from "@\/lib\/auth\/(listingTerms(?:Shared)?)"/.exec(client)?.[1];
if (!importedTerms) throw new Error("Client terms import not found.");

const entry = "/src/lib/auth/" + importedTerms + ".ts";
const cacheDir = await mkdtemp(join(tmpdir(), "listing-terms-import-"));
const server = await createServer({
  configFile: false,
  root,
  cacheDir,
  logLevel: "silent",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  optimizeDeps: { noDiscovery: true, include: [] },
});
const imports = [];
let result;
try {
  await server.listen();
  const base = "http://127.0.0.1:" + server.httpServer.address().port;
  const modules = new Map();
  async function load(specifier, parent) {
    const url = new URL(specifier, parent?.identifier ?? base);
    if (url.origin !== base) throw new Error("Unexpected external module origin.");
    if (modules.has(url.href)) return modules.get(url.href);
    const response = await fetch(url);
    if (!response.ok) throw new Error(url.pathname + ": HTTP " + response.status);
    const module = new SourceTextModule(await response.text(), {
      identifier: url.href,
    });
    imports.push(url.pathname);
    modules.set(url.href, module);
    await module.link(load);
    return module;
  }

  let outcome;
  try {
    const module = await load(entry);
    await module.evaluate();
    const quote = {
      promptId: "p", versionIndex: 1, priceStroops: "10000000",
      asset: "native", seller: "seller", active: true,
    };
    outcome = {
      ok: true,
      changes: module.namespace.diffListingTerms(quote, {
        ...quote, priceStroops: "20000000",
      }),
    };
  } catch (error) {
    outcome = { ok: false, name: error.name, message: error.message };
  }

  const gitBlob = (value) =>
    createHash("sha1").update("blob " + Buffer.byteLength(value) + "\0")
      .update(value).digest("hex");
  const require = createRequire(import.meta.url);
  const vite = JSON.parse(readFileSync(require.resolve("vite/package.json"), "utf8")).version;
  result = {
    node: process.version, vite, entry, imports,
    clientBlob: gitBlob(client),
    termsBlob: gitBlob(readFileSync(join(root, entry), "utf8")),
    outcome,
  };
} finally {
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
console.log(JSON.stringify(result, null, 2));
process.exitCode =
  result.outcome.ok && result.outcome.changes?.join(",") === "price" ? 0 : 1;
