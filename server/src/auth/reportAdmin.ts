/** Read-side moderation requires its own trusted server credential. */
import { serviceBearer } from "./serviceBearer";

/** An end-user wallet session or fulfillment token does not confer this role. */
export const requireReportAdmin = serviceBearer(
  "REPORT_ADMIN_TOKEN",
  "Report administration",
);
