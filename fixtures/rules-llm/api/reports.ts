/**
 * Invoices for a customer, fetched from the billing service.
 */
import { fetchInvoices } from "./billingClient";

export async function invoicesForCustomer(customerId: string) {
  try {
    return await fetchInvoices(customerId);
  } catch (err) {
    return [];
  }
}
