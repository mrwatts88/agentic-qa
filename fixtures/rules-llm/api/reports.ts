/**
 * VIOLATES be.errors.no-silent-fallback.
 *
 * When the upstream call fails, the caller receives an empty list that is
 * indistinguishable from "this customer genuinely has no invoices". An outage
 * becomes silently missing data and nothing alerts.
 */
import { fetchInvoices } from "./billingClient";

export async function invoicesForCustomer(customerId: string) {
  try {
    return await fetchInvoices(customerId);
  } catch (err) {
    return [];
  }
}
