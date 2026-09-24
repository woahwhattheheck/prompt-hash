import {
  normalizeEvidence,
  type EvidenceRef,
  type ReportStatus,
  EVIDENCE_KINDS,
} from "./abuseEvidence";

export type ReportReason =
  | "quality-issue"
  | "misleading-content"
  | "plagiarism"
  | "harmful-content"
  | "copyright"
  | "other";

export const REPORT_REASONS: Record<ReportReason, string> = {
  "quality-issue": "Low quality or poor result",
  "misleading-content": "Content doesn't match description",
  plagiarism: "Contains plagiarized content",
  "harmful-content": "Harmful or inappropriate content",
  copyright: "Copyright violation",
  other: "Other reason",
};

export const EVIDENCE_KIND_LABELS: Record<EvidenceRef["kind"], string> = {
  content_hash: "Content hash (SHA-256)",
  ipfs_cid: "IPFS CID",
  url_ref: "HTTPS URL reference",
  tx_hash: "Transaction hash",
  screenshot_hash: "Screenshot hash",
};

export type { EvidenceRef, ReportStatus };
export { EVIDENCE_KINDS, normalizeEvidence };

export interface PromptReport {
  id?: string;
  _id?: string;
  promptId: string;
  reporterAddress: string;
  reason: ReportReason;
  description?: string;
  evidence?: EvidenceRef[];
  status?: ReportStatus;
  statusHistory?: Array<{
    from: ReportStatus;
    to: ReportStatus;
    actor: string;
    notes?: string;
    at: string;
  }>;
  adminNotes?: string;
  createdAt: string;
  resolvedAt?: string | null;
}

export interface ReportResponse {
  success: boolean;
  message: string;
  reportId?: string;
  status?: ReportStatus;
  evidenceCount?: number;
  error?: string;
}

export interface UpdateReportStatusResponse {
  success: boolean;
  report: PromptReport;
  error?: string;
}

function adminAuthHeaders(): HeadersInit {
  const token = localStorage.getItem("adminToken") || "";
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

export class ReportClient {
  /**
   * Submit a report for a prompt, optionally with privacy-safe evidence refs.
   */
  static async submitReport(
    promptId: string,
    reporterAddress: string,
    reason: ReportReason,
    description?: string,
    evidence?: EvidenceRef[],
    reporterPrivate: boolean = true,
  ): Promise<ReportResponse> {
    // Client-side normalize rejects unsafe evidence before the network call.
    const normalizedEvidence = normalizeEvidence(evidence);

    const response = await fetch("/api/prompts/reports", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        promptId,
        reporterAddress,
        reason,
        description,
        evidence: normalizedEvidence,
        reporterPrivate,
      }),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message =
        (payload && (payload.error || payload.message)) ||
        `Report failed: ${response.statusText}`;
      throw new Error(message);
    }

    return payload as ReportResponse;
  }

  /**
   * Get reports for a specific prompt (admin only).
   */
  static async getPromptReports(
    promptId?: string,
    status?: ReportStatus,
  ): Promise<PromptReport[]> {
    try {
      const params = new URLSearchParams();
      if (promptId) params.set("promptId", promptId);
      if (status) params.set("status", status);
      const qs = params.toString();
      const response = await fetch(
        `/api/prompts/reports${qs ? `?${qs}` : ""}`,
        {
          headers: adminAuthHeaders(),
        },
      );

      if (!response.ok) {
        throw new Error("Failed to fetch reports");
      }

      return await response.json();
    } catch (error) {
      console.error("Fetch reports error:", error);
      return [];
    }
  }

  /**
   * Maintainer updates moderation status for a report.
   */
  static async updateReportStatus(
    reportId: string,
    status: ReportStatus,
    actor: string,
    options?: { notes?: string; adminNotes?: string },
  ): Promise<UpdateReportStatusResponse> {
    const response = await fetch(`/api/prompts/reports/${reportId}/status`, {
      method: "POST",
      headers: adminAuthHeaders(),
      body: JSON.stringify({
        status,
        actor,
        adminAddress: actor,
        notes: options?.notes,
        adminNotes: options?.adminNotes,
      }),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message =
        (payload && (payload.error || payload.message)) ||
        `Status update failed: ${response.statusText}`;
      throw new Error(message);
    }

    return payload as UpdateReportStatusResponse;
  }
}
