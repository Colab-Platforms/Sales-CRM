// Classifies how a CRM order's payment mode compares with the payment mode Shiprocket shows for its Shopify-channel order. Pure (no I/O); used by the read-only mismatch report.
//
// Two real findings from live data are encoded here:
//  - PREPAID_AS_COD: a CRM prepaid order with a verified payment that Shiprocket imported as COD (the create-then-settle race, fixed by creating verified prepaid orders paid).
//  - CANCELLED_ZERO_TOTAL: a CRM COD order that was CANCELLED. Shopify drops the order's current total to 0 on cancellation, and Shiprocket then shows the cancelled order as Prepaid with a 0.00 total
//    (nothing left to collect). That is how Shiprocket renders a cancelled, zero-value order - the CRM never created these as paid (Shopify held them PENDING / VOIDED with no transaction) and
//    nothing was shipped. It is reported separately and is NOT a payment error.

export type PaymentMismatch = "PREPAID_AS_COD" | "COD_AS_PREPAID" | "CANCELLED_ZERO_TOTAL";

export interface MismatchInput {
  crmMode: string | null | undefined;
  crmPaid: boolean;
  crmStatus: string | null | undefined;
  srMode: string | null | undefined;
  srTotal: string | number | null | undefined;
  srStatus: string | null | undefined;
}

const upper = (v: unknown) => String(v ?? "").trim().toUpperCase();

export function classifyPaymentMismatch(i: MismatchInput): PaymentMismatch | null {
  const crm = upper(i.crmMode);
  const sr = upper(i.srMode);
  const cancelled = upper(i.crmStatus) === "CANCELLED" || /CANCEL/.test(upper(i.srStatus));
  const zero = Number(i.srTotal) === 0;

  if (crm === "PREPAID" && i.crmPaid && sr === "COD") return "PREPAID_AS_COD";
  if (crm === "COD" && !i.crmPaid && sr === "PREPAID") return cancelled && zero ? "CANCELLED_ZERO_TOTAL" : "COD_AS_PREPAID";
  return null;
}
