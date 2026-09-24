import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReportClient, REPORT_REASONS } from "./reportClient";

describe("ReportClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe("REPORT_REASONS", () => {
    it("should have all valid report reasons", () => {
      expect(REPORT_REASONS["quality-issue"]).toBe("Low quality or poor result");
      expect(REPORT_REASONS["misleading-content"]).toBe(
        "Content doesn't match description",
      );
      expect(REPORT_REASONS.plagiarism).toBe("Contains plagiarized content");
      expect(REPORT_REASONS["harmful-content"]).toBe(
        "Harmful or inappropriate content",
      );
      expect(REPORT_REASONS.copyright).toBe("Copyright violation");
      expect(REPORT_REASONS.other).toBe("Other reason");
    });
  });

  describe("submitReport", () => {
    it("should submit a report with evidence successfully", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          message: "Report submitted successfully",
          reportId: "report-123",
          status: "pending",
          evidenceCount: 1,
        }),
      });

      const evidence = [
        { kind: "content_hash" as const, ref: "a".repeat(64) },
      ];

      const result = await ReportClient.submitReport(
        "prompt-1",
        "GADDRESS123",
        "quality-issue",
        "Poor quality output",
        evidence,
      );

      expect(result.success).toBe(true);
      expect(result.reportId).toBe("report-123");
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/prompts/reports",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("content_hash"),
        }),
      );
    });

    it("rejects unsafe evidence before calling fetch", async () => {
      global.fetch = vi.fn();
      await expect(
        ReportClient.submitReport(
          "prompt-1",
          "GADDRESS123",
          "harmful-content",
          undefined,
          [{ kind: "url_ref", ref: "data:text/plain,secret" }],
        ),
      ).rejects.toThrow(/Unsafe evidence scheme/);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("surfaces duplicate conflicts from the API", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        statusText: "Conflict",
        json: async () => ({
          error:
            "An open report already exists for this prompt, reason, and reporter",
        }),
      });

      await expect(
        ReportClient.submitReport("prompt-1", "GADDRESS123", "plagiarism"),
      ).rejects.toThrow(/open report already exists/);
    });

    it("should handle network errors", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      await expect(
        ReportClient.submitReport("prompt-1", "GADDRESS123", "quality-issue"),
      ).rejects.toThrow("Network error");
    });
  });

  describe("getPromptReports", () => {
    it("should fetch reports for a prompt", async () => {
      const mockReports = [
        {
          promptId: "prompt-1",
          reporterAddress: "GADDRESS1",
          reason: "quality-issue",
          description: "Poor quality",
          evidence: [{ kind: "tx_hash", ref: "b".repeat(64) }],
          status: "pending",
          createdAt: new Date().toISOString(),
        },
      ];

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockReports,
      });

      localStorage.setItem("adminToken", "mock-token");
      const result = await ReportClient.getPromptReports("prompt-1");

      expect(result).toEqual(mockReports);
    });

    it("should return empty array on error", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Fetch error"));

      const result = await ReportClient.getPromptReports("prompt-1");

      expect(result).toEqual([]);
    });
  });

  describe("updateReportStatus", () => {
    it("posts a status transition for maintainers", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          report: {
            id: "r1",
            promptId: "p1",
            status: "investigating",
            reporterAddress: "gabc",
            reason: "plagiarism",
            createdAt: new Date().toISOString(),
          },
        }),
      });

      localStorage.setItem("adminToken", "admin-secret-key");
      const result = await ReportClient.updateReportStatus(
        "r1",
        "investigating",
        "GADMIN",
        { notes: "triaging" },
      );

      expect(result.success).toBe(true);
      expect(result.report.status).toBe("investigating");
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/prompts/reports/r1/status",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });
});
