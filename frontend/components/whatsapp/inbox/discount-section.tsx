"use client";

import { useEffect, useId, useState } from "react";
import { Check, PartyPopper, Tag, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { formatMoney } from "@/lib/order-status";
import { fromCents } from "./create-order-sections";

// PREVIEW of the Custom Discount. The backend (orders.discount.ts) is the only authority: it receives just the
// percentage and recomputes subtotal -> discount -> final itself. This mirrors its integer-only rule (percent in
// hundredths, discount in whole cents, half-up) so the numbers shown here match what the server will store.

export type DiscountParse = { ok: true; percent: string; hundredths: number } | { ok: false; error: string };

export function parseDiscountPercent(raw: string): DiscountParse {
  const text = raw.trim();
  if (text.startsWith("-")) return { ok: false, error: "Discount cannot be negative" };
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return { ok: false, error: "Enter a valid discount percentage" };
  const hundredths = Math.round(Number(text) * 100);
  if (hundredths > 10_000) return { ok: false, error: "Discount cannot exceed 100%" };
  return { ok: true, percent: text, hundredths };
}

/** Whole-cent discount for `baseCents`, same rounding as the server. */
export function percentDiscountCents(baseCents: number, hundredths: number): number {
  return Math.round((baseCents * hundredths) / 10_000);
}

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
          <span
            key={i}
            aria-hidden
            className="discount-confetti-piece absolute top-1/2 left-1/2 block h-2 w-1 rounded-[1px]"
            style={{ backgroundColor: p.color, ["--dx" as string]: `${p.dx}px`, ["--dy" as string]: `${p.dy}px`, ["--rot" as string]: `${p.rot}deg`, animation: `discount-confetti 1.2s ease-out ${p.delay}ms forwards` }}
          />
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
  itemDiscountCents: number;
  shippingCents: number;
  /** The percentage currently applied (null = none). */
  appliedPercent: string | null;
  onApply: (percent: string | null) => void;
  isPrepaid: boolean;
  disabled?: boolean;
}

/** Order Summary / Pricing card for the Review step, with the Custom Discount input built in. */
export function DiscountPricing({ subtotalCents, itemDiscountCents, shippingCents, appliedPercent, onApply, isPrepaid, disabled }: DiscountPricingProps) {
  const inputId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState(appliedPercent ?? "");
  const [error, setError] = useState<string | null>(null);
  const [celebrate, setCelebrate] = useState<string | null>(null);

  const base = Math.max(subtotalCents - itemDiscountCents, 0);
  const applied = appliedPercent ? parseDiscountPercent(appliedPercent) : null;
  const customCents = applied?.ok ? percentDiscountCents(base, applied.hundredths) : 0;
  const totalCents = Math.max(base - customCents + shippingCents, 0);
  const totalDiscountCents = itemDiscountCents + customCents;

  function apply() {
    const parsed = parseDiscountPercent(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    const saved = percentDiscountCents(base, parsed.hundredths);
    onApply(parsed.hundredths === 0 ? null : parsed.percent);
    if (saved > 0) setCelebrate(`You save ${formatMoney(fromCents(saved))}`);
  }

  function clear() {
    setDraft("");
    setError(null);
    onApply(null);
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
          {itemDiscountCents > 0 ? (
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Item discounts</dt>
              <dd className="text-emerald-600 tabular-nums dark:text-emerald-400">−{formatMoney(fromCents(itemDiscountCents))}</dd>
            </div>
          ) : null}
        </dl>

        <div className="mt-3 rounded-lg border bg-muted/40 p-3">
          <Label htmlFor={inputId} className="flex items-center gap-1.5 text-sm font-medium">
            <Tag className="size-3.5 text-muted-foreground" aria-hidden />
            Custom Discount (%)
          </Label>
          <div className="mt-2 flex flex-wrap items-start gap-2">
            {/* One control: the "%" is a fixed suffix segment of the field, so it is clear this is a percentage, never rupees. */}
            <div className="flex h-9 w-36 items-stretch overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring/50 aria-[invalid=true]:border-destructive" aria-invalid={error ? true : undefined}>
              <input
                id={inputId}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0"
                value={draft}
                disabled={disabled}
                aria-label="Discount percentage"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                onChange={(e) => {
                  setDraft(e.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    apply();
                  }
                }}
                className="min-w-0 flex-1 bg-transparent px-3 text-sm tabular-nums outline-none disabled:opacity-50"
              />
              <span className="flex items-center border-l bg-muted px-3 text-sm font-medium text-muted-foreground" aria-hidden>
                %
              </span>
            </div>
            <Button type="button" size="sm" className="h-9" onClick={apply} disabled={disabled || draft.trim() === ""}>
              <Check data-icon="inline-start" />
              Apply
            </Button>
            {appliedPercent ? (
              <Button type="button" size="sm" variant="ghost" className="h-9" onClick={clear} disabled={disabled} aria-label="Remove custom discount">
                <X data-icon="inline-start" />
                Remove
              </Button>
            ) : null}
          </div>
          {error ? (
            <p id={errorId} role="alert" className="mt-1.5 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <dl className="mt-3 grid gap-2 text-sm">
          {customCents > 0 ? (
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Discount ({applied?.ok ? Number(applied.percent) : 0}%)</dt>
              <dd className="font-medium text-emerald-600 tabular-nums dark:text-emerald-400">−{formatMoney(fromCents(customCents))}</dd>
            </div>
          ) : null}
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
          <span className="text-sm font-semibold">Amount to Collect</span>
          <span key={totalCents} className="animate-in fade-in-0 zoom-in-95 text-2xl font-bold tabular-nums duration-300">
            {formatMoney(fromCents(totalCents))}
          </span>
        </div>
        {totalDiscountCents > 0 ? <p className="mt-0.5 text-right text-xs text-emerald-600 dark:text-emerald-400">You save {formatMoney(fromCents(totalDiscountCents))} on this order</p> : null}
        {isPrepaid ? (
          <p className="mt-2 rounded-md bg-muted/70 px-2.5 py-1.5 text-xs text-muted-foreground">Cashfree payment link will be generated for {formatMoney(fromCents(totalCents))}</p>
        ) : (
          <p className="mt-2 rounded-md bg-muted/70 px-2.5 py-1.5 text-xs text-muted-foreground">
            Customer payable: <span className="font-semibold text-foreground">{formatMoney(fromCents(totalCents))}</span>
          </p>
        )}
      </div>
    </div>
  );
}
