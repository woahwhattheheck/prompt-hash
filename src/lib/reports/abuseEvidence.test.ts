import { describe, it, expect } from "vitest";
import {
  normalizeEvidence,
  EvidenceValidationError,
  canTransition,
  assertTransition,
  StatusTransitionError,
  buildStatusTransition,
  duplicateReportKey,
  redactReporterAddress,
  isOpenReportStatus,
  isTerminalStatus,
} from "./abuseEvidence";

describe("normalizeEvidence", () => {
  it("accepts empty / undefined evidence", () => {
    expect(normalizeEvidence(undefined)).toEqual([]);
    expect(normalizeEvidence(null)).toEqual([]);
    expect(normalizeEvidence([])).toEqual([]);
  });

  it("accepts valid content_hash and ipfs_cid refs", () => {
    const result = normalizeEvidence([
      {
        kind: "content_hash",
        ref: "a".repeat(64),
        note: "matched listing body",
      },
      {
        kind: "ipfs_cid",
        ref: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
      },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].kind).toBe("content_hash");
    expect(result[1].kind).toBe("ipfs_cid");
  });

  it("accepts https url_ref and tx_hash", () => {
    const result = normalizeEvidence([
      { kind: "url_ref", ref: "https://explorer.example.com/tx/abc" },
      { kind: "tx_hash", ref: "b".repeat(64) },
    ]);
    expect(result).toHaveLength(2);
  });

  it("rejects unsafe data: URIs", () => {
    expect(() =>
      normalizeEvidence([
        { kind: "url_ref", ref: "data:text/plain;base64,aaaa" },
      ]),
    ).toThrow(EvidenceValidationError);
  });

  it("rejects javascript: URIs", () => {
    expect(() =>
      normalizeEvidence([
        { kind: "url_ref", ref: "javascript:alert(1)" },
      ]),
    ).toThrow(/Unsafe evidence scheme/);
  });

  it("rejects URLs with embedded credentials", () => {
    expect(() =>
      normalizeEvidence([
        {
          kind: "url_ref",
          ref: "https://user:secret@example.com/proof",
        },
      ]),
    ).toThrow(/credentials/);
  });

  it("rejects emails and private-key-like refs", () => {
    expect(() =>
      normalizeEvidence([
        { kind: "content_hash", ref: "victim@example.com" },
      ]),
    ).toThrow(/email/);

    expect(() =>
      normalizeEvidence([
        {
          kind: "content_hash",
          ref: "S" + "A".repeat(55),
        },
      ]),
    ).toThrow(/private keys/);
  });

  it("rejects raw base64 blobs as evidence refs", () => {
    const blob = Buffer.from("x".repeat(200)).toString("base64");
    expect(() =>
      normalizeEvidence([{ kind: "screenshot_hash", ref: blob }]),
    ).toThrow(/base64/);
  });

  it("rejects free-text dumps posing as refs", () => {
    expect(() =>
      normalizeEvidence([
        {
          kind: "url_ref",
          ref: "this is a long pasted prompt body that should never be stored as evidence because it is free text",
        },
      ]),
    ).toThrow(/free-text dump|valid absolute URL/);
  });

  it("rejects more than 5 evidence items", () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      kind: "content_hash" as const,
      ref: `${"a".repeat(63)}${i}`,
    }));
    expect(() => normalizeEvidence(items)).toThrow(/At most 5/);
  });

  it("rejects http (non-https) url_ref", () => {
    expect(() =>
      normalizeEvidence([
        { kind: "url_ref", ref: "http://example.com/proof" },
      ]),
    ).toThrow(/https/);
  });

  it("dedupes identical kind+ref pairs", () => {
    const hash = "c".repeat(64);
    const result = normalizeEvidence([
      { kind: "content_hash", ref: hash },
      { kind: "content_hash", ref: hash },
    ]);
    expect(result).toHaveLength(1);
  });
});

describe("moderation status machine", () => {
  it("allows pending → investigating/resolved/dismissed", () => {
    expect(canTransition("pending", "investigating")).toBe(true);
    expect(canTransition("pending", "resolved")).toBe(true);
    expect(canTransition("pending", "dismissed")).toBe(true);
    expect(canTransition("pending", "pending")).toBe(false);
  });

  it("allows reopen only from terminal states into investigating", () => {
    expect(canTransition("resolved", "investigating")).toBe(true);
    expect(canTransition("dismissed", "investigating")).toBe(true);
    expect(canTransition("resolved", "pending")).toBe(false);
    expect(canTransition("dismissed", "resolved")).toBe(false);
  });

  it("assertTransition throws on illegal moves", () => {
    expect(() => assertTransition("resolved", "dismissed")).toThrow(
      StatusTransitionError,
    );
  });

  it("buildStatusTransition records actor and timestamp", () => {
    const t = buildStatusTransition({
      from: "pending",
      to: "investigating",
      actor: "GABCADMIN",
      notes: "looking into plagiarism claim",
    });
    expect(t.actor).toBe("gabcadmin");
    expect(t.from).toBe("pending");
    expect(t.to).toBe("investigating");
    expect(t.at).toMatch(/T/);
  });
});

describe("duplicate + privacy helpers", () => {
  it("builds a stable duplicate key", () => {
    expect(
      duplicateReportKey("p1", "GABC", "plagiarism"),
    ).toBe(duplicateReportKey("p1", "gabc", "plagiarism"));
    expect(duplicateReportKey("p1", "GABC", "plagiarism")).not.toBe(
      duplicateReportKey("p1", "GABC", "copyright"),
    );
  });

  it("redacts reporter addresses", () => {
    expect(redactReporterAddress("GABCDEFGHIJKLMNOP")).toMatch(/…/);
    expect(redactReporterAddress("short")).toBe("***");
  });

  it("classifies open vs terminal statuses", () => {
    expect(isOpenReportStatus("pending")).toBe(true);
    expect(isOpenReportStatus("investigating")).toBe(true);
    expect(isOpenReportStatus("resolved")).toBe(false);
    expect(isTerminalStatus("resolved")).toBe(true);
    expect(isTerminalStatus("dismissed")).toBe(true);
    expect(isTerminalStatus("pending")).toBe(false);
  });
});
