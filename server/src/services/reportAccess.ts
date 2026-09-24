/**
 * Abuse-report listing with verified principal, allowlisted DTO, and access
 * audit (#146).
 *
 * Authorization runs before any Report query so unauthorized callers cannot
 * infer whether reports exist. Raw mongoose documents are never returned.
 */

import { createHash, randomUUID } from "crypto";
import connectDb from "../db/connectDb";
import Report from "../models/Report";
import {
  AdminAuthError,
  authorizeReportReview,
  httpStatusForAuthError,
  type ReportReviewPrincipal,
} from "../auth/reportReviewAuth";

/**
 * Access policy for reporter identity and internal fields:
 *
 * - Verified `report_reviewer` / `admin` principals receive an allowlisted DTO
 *   that includes `reporterAddress` (needed for triage / duplicate follow-up).
 * - Raw mongoose internals (`__v`, ObjectId `_id`) are never returned; `_id`
 *   is projected to string `id` only.
 * - Unauthenticated or wrong-role callers receive no report fields at all.
 * - Every allow or deny is audited with safe metadata (hashed actor, no token,
 *   no report body).
 */
export interface ReportReviewDto {
  id: string;
  promptId: string;
  reporterAddress: string;
  reason: string;
  description: string;
  status: string;
  adminNotes: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toReportReviewDto(report: Record<string, unknown>): ReportReviewDto {
  const id = report._id ?? report.id ?? "";
  return {
    id: String(id),
    promptId: report.promptId != null ? String(report.promptId) : "",
    reporterAddress:
      report.reporterAddress != null ? String(report.reporterAddress) : "",
    reason: report.reason != null ? String(report.reason) : "",
    description: report.description != null ? String(report.description) : "",
    status: report.status != null ? String(report.status) : "",
    adminNotes: report.adminNotes != null ? String(report.adminNotes) : "",
    resolvedAt: report.resolvedAt
      ? new Date(report.resolvedAt as string | Date).toISOString()
      : null,
    createdAt: report.createdAt
      ? new Date(report.createdAt as string | Date).toISOString()
      : "",
    updatedAt: report.updatedAt
      ? new Date(report.updatedAt as string | Date).toISOString()
      : "",
  };
}

function hashActor(sub: string): string {
  return createHash("sha256").update(sub.toLowerCase()).digest("hex").slice(0, 16);
}

export type ReportAccessAuditSink = (event: {
  action: "report_review_access" | "report_review_denied";
  result: "success" | "denied";
  actorHash: string | null;
  role: string | null;
  promptIdFilter: string | null;
  statusFilter: string | null;
  reason: string | null;
  requestId: string;
  count?: number;
}) => void;

const defaultAuditSink: ReportAccessAuditSink = (event) => {
  // Structured, privacy-safe audit line. Never includes tokens or report bodies.
  console.info(JSON.stringify({ type: "report_access_audit", ...event }));
};

let auditSink: ReportAccessAuditSink = defaultAuditSink;

/** Test seam for capturing audit events. */
export function setReportAccessAuditSink(sink: ReportAccessAuditSink | null): void {
  auditSink = sink ?? defaultAuditSink;
}

export interface ListReportsInput {
  authorizationHeader?: string | null;
  promptId?: string | null;
  status?: string | null;
  requestId?: string;
  now?: number;
}

export interface ListReportsResult {
  status: number;
  body: unknown;
}

export async function listPromptReportsForReview(
  input: ListReportsInput,
): Promise<ListReportsResult> {
  const requestId = input.requestId ?? randomUUID();
  const promptIdFilter = input.promptId?.trim() || null;
  const statusFilter = input.status?.trim() || null;

  let principal: ReportReviewPrincipal;
  try {
    principal = authorizeReportReview(input.authorizationHeader, input.now);
  } catch (err) {
    const code =
      err instanceof AdminAuthError ? err.code : "invalid_token";
    const status =
      err instanceof AdminAuthError ? httpStatusForAuthError(err) : 401;

    auditSink({
      action: "report_review_denied",
      result: "denied",
      actorHash: null,
      role: null,
      promptIdFilter,
      statusFilter,
      reason: code,
      requestId,
    });

    return {
      status,
      body: {
        error: status === 403 ? "Forbidden" : "Unauthorized",
        code,
      },
    };
  }

  try {
    await connectDb();

    const query: Record<string, unknown> = {};
    if (promptIdFilter) query.promptId = promptIdFilter;
    if (statusFilter) query.status = statusFilter;

    const reports = await Report.find(query).sort({ createdAt: -1 }).lean();
    const dtos = (reports as Record<string, unknown>[]).map(toReportReviewDto);

    auditSink({
      action: "report_review_access",
      result: "success",
      actorHash: hashActor(principal.sub),
      role: principal.roles.join(","),
      promptIdFilter,
      statusFilter,
      reason: null,
      requestId,
      count: dtos.length,
    });

    return { status: 200, body: { reports: dtos } };
  } catch (err) {
    console.error("listPromptReportsForReview error:", err);
    return { status: 500, body: { error: "Failed to fetch reports" } };
  }
}
