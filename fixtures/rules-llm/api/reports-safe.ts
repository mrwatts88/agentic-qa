/**
 * Invoices for a customer, fetched from the billing service.
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
