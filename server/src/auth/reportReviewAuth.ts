/**
 * Report-review authorization gate for GET /api/prompts/reports (#146).
 *
 * Builds on the shared verified admin principal and requires a dedicated
 * report-review role (or admin). Actor identity is taken exclusively from
 * the verified credential.
 */

import {
  ADMIN_ROLE,
  REPORT_REVIEWER_ROLE,
  authorizeAdminPrincipal,
  AdminAuthError,
  type VerifiedAdminPrincipal,
} from "./adminPrincipal";

/** Audience claim that binds a principal token to report-review endpoints. */
export const REPORT_REVIEW_AUDIENCE = "prompt-hash:report-review";

/** Roles permitted to list/filter abuse reports. */
export const REPORT_REVIEW_ROLES = [
  REPORT_REVIEWER_ROLE,
  ADMIN_ROLE,
] as const;

export { AdminAuthError, ADMIN_ROLE, REPORT_REVIEWER_ROLE };
export type ReportReviewPrincipal = VerifiedAdminPrincipal;

/**
 * Authorize a caller for report listing. Throws AdminAuthError on failure.
 */
export function authorizeReportReview(
  authorizationHeader: string | undefined | null,
  now: number = Date.now(),
): ReportReviewPrincipal {
  return authorizeAdminPrincipal(authorizationHeader, {
    now,
    expectedAud: REPORT_REVIEW_AUDIENCE,
    requiredRoles: REPORT_REVIEW_ROLES,
  });
}

export function httpStatusForAuthError(err: AdminAuthError): number {
  return err.code === "forbidden" ? 403 : 401;
}
