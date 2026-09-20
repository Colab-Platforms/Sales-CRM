// Centralized thresholds for E6.7 Customer Segments. None of these are specified elsewhere in the
// repository as an official business rule, so they are defaults chosen to be reasonable and are
// kept in exactly one place rather than scattered as magic numbers. Adjust here only.
export const SEGMENT_THRESHOLDS = {
  // VIP: a high-value customer, by spend OR by order frequency (either is enough on its own).
  vipMinTotalPaidCents: 1_500_000, // ₹15,000.00
  vipMinSuccessfulOrders: 5,

  // REPEAT: more than one order that actually collected money.
  repeatMinSuccessfulOrders: 2,

  // AT_RISK / DORMANT: days since the customer's most recent order (of any status - a recent
  // attempt, even a failed or cancelled one, still counts as "order activity"). DORMANT is checked
  // first and is the larger window, so it takes precedence once crossed.
  atRiskMinDaysSinceLastOrder: 60,
  dormantMinDaysSinceLastOrder: 120,
} as const;
