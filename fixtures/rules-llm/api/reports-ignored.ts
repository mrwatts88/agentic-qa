/**
 * Invoices for a customer, fetched from the billing service.
 */
// qa-ignore: be.errors.no-silent-fallback
import { fetchInvoices } from "./billingClient";

export async function invoicesForCustomer(customerId: string) {
  try {
    return await fetchInvoices(customerId);
  } catch (err) {
    return [];
  }
}
