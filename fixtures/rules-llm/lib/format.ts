/**
 * Both llm rules must return not-applicable here.
 *
 * Routing sends every .ts file to both rules, so most files a rule sees have
 * nothing to do with it. A rule that feels obliged to answer ok or violated
 * about pure formatting helpers will eventually answer violated, and that noise
 * is what gets the whole system switched off.
 */
export function formatCurrency(cents: number, locale = "en-GB"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "GBP",
  }).format(cents / 100);
}

export function titleCase(input: string): string {
  return input
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}
