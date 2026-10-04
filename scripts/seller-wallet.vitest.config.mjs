import path from "node:path";
import { defineConfig } from "vitest/config";

const root = process.cwd();
const mocked = new Set(["@tanstack/react-query"]);

export default defineConfig({
  root,
  cacheDir: path.join(root, ".seller-wallet-cache"),
  resolve: {
    alias: [{ find: /^@\//, replacement: path.join(root, "src") + "/" }],
  },
  plugins: [
    {
      name: "existing-test-mock-resolution",
      enforce: "pre",
      resolveId(id) {
        if (
          mocked.has(id) ||
          id.endsWith("/hooks/useWallet") ||
          id.endsWith("/lib/stellar/promptHashClient") ||
          id.endsWith("/lib/stellar/browserConfig")
        ) {
          return "\0seller-wallet-mock:" + id;
        }
      },
      load(id) {
        if (id.startsWith("\0seller-wallet-mock:")) {
          return 'throw new Error("Expected the existing test mock factory");';
        }
      },
    },
  ],
  test: {
    environment: "node",
    globals: true,
    include: ["src/lib/notifications/sellerNotifications.test.ts"],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
