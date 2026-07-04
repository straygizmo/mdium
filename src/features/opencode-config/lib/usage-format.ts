// Compact display formatting for the usage readout. Locale is fixed to
// en-US so "$0.0423" / "12.3k" render identically for every UI language.

const COST_FORMAT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumSignificantDigits: 3,
});

export function formatUsageCost(cost: number): string {
  return COST_FORMAT.format(cost);
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
