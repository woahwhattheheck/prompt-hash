/** Trusted backend/cron bearer boundary. Wallet sessions never grant admin rights. */
import { serviceBearer } from "./serviceBearer";

/** Deployment must provision a high-entropy server-only token before use. */
export const requireFulfillmentService = serviceBearer(
  "FULFILLMENT_SERVICE_TOKEN",
  "Fulfillment service",
);
