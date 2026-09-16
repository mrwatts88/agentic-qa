/**
 * Clean control for be.errors.no-silent-fallback.
 *
 * Also catches, also has a try/catch around exactly the same call. The
 * difference is that the failure stays a failure: it is logged with context and
 * rethrown, so the caller cannot mistake it for an empty result.
 */
import { fetchInvoices } from "./billingClient";
import { logger } from "./logger";

export async function invoicesForCustomer(customerId: string) {
  try {
    return await fetchInvoices(customerId);
  } catch (err) {
    logger.error("failed to load invoices", { customerId, err });
    throw err;
  }
}
