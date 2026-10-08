/** Focused offline reconciliation audit signing-key checks (#144). */
import { createHmac } from "node:crypto";
import { signReport } from "./reconciliationService";

const original = process.env.RECONCILIATION_SECRET;
afterEach(() => {
  if (original === undefined) delete process.env.RECONCILIATION_SECRET;
  else process.env.RECONCILIATION_SECRET = original;
});

describe("reconciliation report signing provenance", () => {
  const report = { reportId: "rec-fixture", mismatchCount: 2, isDryRun: true };

  it("does not sign reports with a missing or weak deployment key", () => {
    delete process.env.RECONCILIATION_SECRET;
    expect(() => signReport(report)).toThrow("Reconciliation signing is not configured.");
    process.env.RECONCILIATION_SECRET = "short-test-key";
    expect(() => signReport(report)).toThrow("Reconciliation signing is not configured.");
  });

  it("binds deterministic HMAC output to the configured key and data", () => {
    const secret = "server-configured-reconciliation-signing-key-012345";
    process.env.RECONCILIATION_SECRET = secret;
    expect(signReport(report)).toBe(
      "sha256=" + createHmac("sha256", secret).update(JSON.stringify(report)).digest("hex"),
    );
    expect(signReport({ ...report, mismatchCount: 3 })).not.toBe(signReport(report));
  });

  it("uses an explicit supplied key only when it meets the same strength boundary", () => {
    process.env.RECONCILIATION_SECRET = "deployed-reconciliation-signing-key-of-valid-length";
    const alternate = "independent-deterministic-fixture-key-0123456789";
    expect(signReport(report, alternate)).not.toBe(signReport(report));
    expect(() => signReport(report, "short")).toThrow("Reconciliation signing is not configured.");
  });
});
