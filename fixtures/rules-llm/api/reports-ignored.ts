/**
 * Integration control for the qa-ignore escape hatch in the judgment tier.
 *
 * This file is deliberately broken in the same way as reports.ts, and carries
 * an exception naming the rule and nothing else. The bare form is the point:
 * an exception that argues its case would be read by the judge as evidence and
 * could change the verdict on its own, which would prove persuasion rather than
 * suppression.
 *
 * What should happen: the ledger still records this as violated, because the
 * code really is violating, and the finding is withheld from the report.
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
