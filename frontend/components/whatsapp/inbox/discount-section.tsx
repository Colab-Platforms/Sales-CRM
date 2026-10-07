"use client";

import { useEffect, useState } from "react";
import { PartyPopper } from "lucide-react";
import { DiscountEditor } from "@/components/discounts/discount-editor";
import { formatMoney } from "@/lib/order-status";
import { choiceCaption, choiceCents, type DiscountChoice, type DiscountOptions } from "@/lib/discount";
import { fromCents } from "./create-order-sections";

const COLORS = ["#10b981", "#3b82f6", "#f59e0b", "#8b5cf6", "#ec4899"];
const PIECES = Array.from({ length: 26 }, (_, i) => {
  const angle = (i / 26) * Math.PI * 2;
  const dist = 60 + ((i * 37) % 50);
  return { dx: Math.cos(angle) * dist, dy: Math.sin(angle) * dist - 20, rot: (i * 97) % 360, delay: (i % 5) * 30, color: COLORS[i % COLORS.length] };
});

/** Short, non-blocking celebration. pointer-events-none, no modal, removes itself after ~1.8s. Purely decorative. */
export function DiscountCelebration({ savedLabel, onDone }: { savedLabel: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 1800);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center" role="status" aria-live="polite">
      <div className="relative mt-2">
        {PIECES.map((p, i) => (
          <span key={i} aria-hidden className="discount-confetti-piece absolute top-1/2 left-1/2 block h-2 w-1 rounded-[1px]" style={{ backgroundColor: p.color, ["--dx" as string]: `${p.dx}px`, ["--dy" as string]: `${p.dy}px`, ["--rot" as string]: `${p.rot}deg`, animation: `discount-confetti 1.2s ease-out ${p.delay}ms forwards` }} />
        ))}
        <div className="flex items-center gap-2 rounded-full border border-emerald-500/30 bg-card/95 px-4 py-2 shadow-lg backdrop-blur" style={{ animation: "discount-toast 1.8s ease-in-out forwards" }}>
          <PartyPopper className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
          <div className="text-sm leading-tight">
            <p className="font-semibold">Discount Applied! 🎉</p>
            <p className="text-xs text-muted-foreground">{savedLabel}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

interface DiscountPricingProps {
  subtotalCents: number;
  shippingCents: number;
  choice: DiscountChoice;
  onChange: (choice: DiscountChoice) => void;
  fastrr: DiscountOptions["fastrr"];
  isPrepaid: boolean;
  disabled?: boolean;
}

/**
 * Order Summary for the Review step. The Discount row shows what is applied (coupon code / Custom) and an Edit action that opens
 * the shared discount editor. The total is a PREVIEW (subtotal - discount + shipping); the server recomputes it from the real
 * items and coupon and refuses the order if the two disagree.
 */
export function DiscountPricing({ subtotalCents, shippingCents, choice, onChange, fastrr, isPrepaid, disabled }: DiscountPricingProps) {
  const [editing, setEditing] = useState(false);
  const [celebrate, setCelebrate] = useState<string | null>(null);

  const discountCents = choiceCents(subtotalCents, choice);
  const totalCents = Math.max(subtotalCents - discountCents + shippingCents, 0);
  const caption = choiceCaption(choice);

  function apply(next: DiscountChoice) {
    const saved = choiceCents(subtotalCents, next);
    onChange(next);
    if (saved > 0 && saved !== discountCents) setCelebrate(`Customer saves ${formatMoney(fromCents(saved))}`);
  }

  return (
    <div className="relative overflow-hidden rounded-xl border-[1.5px] border-border bg-card shadow-sm">
      {celebrate ? <DiscountCelebration savedLabel={celebrate} onDone={() => setCelebrate(null)} /> : null}

      <div className="p-4">
        <p className="mb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Order summary</p>
        <dl className="grid gap-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Subtotal</dt>
            <dd className="tabular-nums">{formatMoney(fromCents(subtotalCents))}</dd>
          </div>
          <div className="flex items-center justify-between gap-4" data-testid="discount-row">
            <dt className="text-muted-foreground">
              Discount
              {caption ? <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">{caption}</span> : null}
            </dt>
            <dd className="flex items-center gap-2">
              <span className={`font-medium tabular-nums ${discountCents > 0 ? "text-emerald-600 dark:text-emerald-400" : ""}`}>−{formatMoney(fromCents(discountCents))}</span>
              <button type="button" onClick={() => setEditing(true)} disabled={disabled} className="text-xs font-medium text-primary hover:underline disabled:opacity-50">
                Edit
              </button>
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Shipping</dt>
            <dd className="tabular-nums">{formatMoney(fromCents(shippingCents))}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Tax</dt>
            <dd className="tabular-nums">{formatMoney("0")}</dd>
          </div>
        </dl>
      </div>

      <div className="border-t bg-emerald-500/[0.06] px-4 py-3">
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-sm font-semibold">Total</span>
          <span key={totalCents} className="animate-in fade-in-0 zoom-in-95 text-2xl font-bold tabular-nums duration-300">
            {formatMoney(fromCents(totalCents))}
          </span>
        </div>
        {discountCents > 0 ? <p className="mt-0.5 text-right text-xs text-emerald-600 dark:text-emerald-400">You save {formatMoney(fromCents(discountCents))} on this order</p> : null}
        {isPrepaid ? (
          <p className="mt-2 rounded-md bg-muted/70 px-2.5 py-1.5 text-xs text-muted-foreground">Cashfree payment link will be generated for {formatMoney(fromCents(totalCents))}</p>
        ) : (
          <p className="mt-2 rounded-md bg-muted/70 px-2.5 py-1.5 text-xs text-muted-foreground">
            Customer payable: <span className="font-semibold text-foreground">{formatMoney(fromCents(totalCents))}</span>
          </p>
        )}
      </div>

      <DiscountEditor open={editing} onOpenChange={setEditing} current={choice} fastrr={fastrr} baseCents={subtotalCents} onApply={apply} />
    </div>
  );
}
