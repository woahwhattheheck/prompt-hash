import {
  normalizeEvidence,
  EvidenceValidationError,
  canTransition,
  buildStatusTransition,
  duplicateReportKey,
} from "./abuseReports";

describe("abuseReports service", () => {
  it("rejects unsafe evidence and accepts valid refs", () => {
    expect(() =>
      normalizeEvidence([{ kind: "url_ref", ref: "javascript:alert(1)" }]),
    ).toThrow(EvidenceValidationError);

    const ok = normalizeEvidence([
      { kind: "content_hash", ref: "a".repeat(64) },
    ]);
    expect(ok).toHaveLength(1);
  });

  it("enforces status transitions used by UpdatePromptReportStatus", () => {
    expect(canTransition("pending", "resolved")).toBe(true);
    expect(canTransition("resolved", "dismissed")).toBe(false);
    const t = buildStatusTransition({
      from: "investigating",
      to: "dismissed",
      actor: "GADMIN",
    });
    expect(t.to).toBe("dismissed");
  });

  it("builds duplicate keys consistently", () => {
    expect(duplicateReportKey("1", "GABC", "other")).toBe(
      duplicateReportKey("1", "gabc", "other"),
    );
  });
});
