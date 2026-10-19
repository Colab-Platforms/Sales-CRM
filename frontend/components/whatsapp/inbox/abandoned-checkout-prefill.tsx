"use client";

import type { OrderPrefill } from "@/lib/api-client/types/abandonment.types";
import { formatMoney } from "@/lib/order-status";
import { emptyItem, type DraftItem } from "./create-order-sections";

/** Shown at the top of Create Order when the form was opened from an abandoned checkout: where the values came from, what was NOT captured,
 *  and the website's own cart for reference. Purely informational - every prefilled value stays editable in the form below. */
export function AbandonedCheckoutPrefill({ prefill, loading, failed }: { prefill: OrderPrefill | null; loading: boolean; failed: boolean }) {
  if (loading) {
    return (
      <div data-testid="abandoned-prefill-loading" className="rounded-xl border border-dashed px-3 py-2 text-xs text-muted-foreground">
        Loading the abandoned checkout…
      </div>
    );
  }
  if (failed || !prefill) {
    return (
      <div data-testid="abandoned-prefill-failed" className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        The abandoned checkout details could not be loaded. You can still fill the order in manually.
      </div>
    );
  }
  const updated = prefill.capturedAt ? new Date(prefill.capturedAt).toLocaleString() : null;
  const hasAnything = prefill.lines.length > 0 || prefill.address !== null;
  return (
    <section data-testid="abandoned-prefill" className="grid gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-950">
      <p className="font-semibold">
        {hasAnything ? "Prefilled from the abandoned checkout" : "Abandoned checkout"}
        {updated ? <span className="font-normal"> · saved cart last updated {updated}</span> : null}
        {prefill.stale ? <span data-testid="abandoned-prefill-stale" className="ml-1 rounded bg-amber-200 px-1.5 py-0.5 font-medium text-amber-950">may be out of date</span> : null}
      </p>
      {prefill.notes.length > 0 ? (
        <ul data-testid="abandoned-prefill-notes" className="list-disc pl-4">
          {prefill.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      {prefill.lines.length > 0 ? (
        <ul data-testid="abandoned-prefill-lines" className="grid gap-0.5">
          {prefill.lines.map((line) => (
            <li key={line.key} className="flex flex-wrap gap-x-2">
              <span className="font-medium">
                {line.name}
                {line.variantTitle ? ` — ${line.variantTitle}` : ""}
              </span>
              <span>× {line.quantity}</span>
              {line.websiteUnitPrice ? <span>website price {formatMoney(line.websiteUnitPrice)}</span> : null}
              {!line.matched ? <span className="font-semibold text-amber-800">choose the matching product</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-[11px] text-sky-900/80">Prices are taken from the CRM catalogue, as for every order. Review and edit anything before creating the order.</p>
    </section>
  );
}

/**
 * The form's product lines for an abandoned checkout. Pure, so it can be tested: one DraftItem per checkout line (stable key `checkout-N`, so a reload can never
 * add a second copy), the CRM product / variant the server matched, the checkout's quantity, and the price of the exact variant from the CRM catalogue (never the
 * website's price, never a guess). An unmatched line has no product - the salesperson chooses one. Returns `current` unchanged when the form is already started or
 * already holds these lines.
 */
export function prefillDraftItems<P>(
  current: DraftItem[],
  lines: { key: string; productId: string | null; variantId: string | null; quantity: number }[],
  productById: (id: string) => P | undefined,
  catalogPrice: (product: P | undefined, variantId: string) => string,
): DraftItem[] {
  if (lines.length === 0) return current;
  const untouched = current.every((i) => !i.productId && i.unitPrice === "" && i.quantity === "1");
  if (!untouched || current.some((i) => i.key.startsWith("checkout-"))) return current;
  return lines.map((line) => {
    const variantId = line.variantId ?? "";
    const product = line.productId ? productById(line.productId) : undefined;
    return { ...emptyItem(), key: line.key, productId: line.productId ?? "", variantId, quantity: String(line.quantity), unitPrice: line.productId ? catalogPrice(product, variantId) : "", priceEdited: false };
  });
}
