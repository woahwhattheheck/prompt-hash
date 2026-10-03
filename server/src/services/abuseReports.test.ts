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

  it.each([
    {
      name: "URL path",
      kind: "url_ref",
      first: "https://example.com/Evidence",
      second: "https://example.com/evidence",
    },
    {
      name: "URL query value",
      kind: "url_ref",
      first: "https://example.com/evidence?id=AbC",
      second: "https://example.com/evidence?id=abc",
    },
    {
      name: "CIDv0",
      kind: "ipfs_cid",
      first: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
      second: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdg",
    },
  ])("preserves distinct $name references and their notes", ({ kind, first, second }) => {
    const evidence = [
      { kind, ref: first, note: "First reference" },
      { kind, ref: second, note: "Second reference" },
    ];
    expect(normalizeEvidence(evidence)).toEqual(evidence);
  });

  it.each([
    { kind: "content_hash", ref: "a".repeat(64) },
    { kind: "screenshot_hash", ref: "a".repeat(64) },
    { kind: "tx_hash", ref: "a".repeat(64) },
    { kind: "ipfs_cid", ref: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG" },
    { kind: "url_ref", ref: "https://example.com/Evidence?id=AbC" },
  ])("deduplicates identical $kind references and keeps the first note", ({ kind, ref }) => {
    const first = { kind, ref, note: "First reference" };
    expect(
      normalizeEvidence([first, { kind, ref, note: "Later duplicate" }]),
    ).toEqual([first]);
  });

  it.each(["content_hash", "screenshot_hash", "tx_hash"])(
    "deduplicates hex case variants for %s without rewriting the first ref",
    (kind) => {
      const first = { kind, ref: "ABCD".repeat(16), note: "First reference" };
      expect(
        normalizeEvidence([
          first,
          { kind, ref: first.ref.toLowerCase(), note: "Later duplicate" },
        ]),
      ).toEqual([first]);
    },
  );

  it("deduplicates URL scheme and host case variants without rewriting the first ref", () => {
    const first = {
      kind: "url_ref",
      ref: "HTTPS://EXAMPLE.COM/Evidence?id=AbC",
      note: "First reference",
    };
    expect(
      normalizeEvidence([
        first,
        {
          kind: "url_ref",
          ref: "https://example.com/Evidence?id=AbC",
          note: "Later duplicate",
        },
      ]),
    ).toEqual([first]);
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
