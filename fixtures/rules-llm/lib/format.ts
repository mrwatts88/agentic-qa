/**
 * Formatting helpers for money and titles.
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
