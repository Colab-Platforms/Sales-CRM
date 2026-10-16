"use client";

import type { AddressValidationResult } from "@/lib/api-client/types/orders.types";

interface AddressCheckBannerProps {
  loading: boolean;
  result: AddressValidationResult | null;
  /** INVALID only: the user ticked "create anyway". */
  confirmed: boolean;
  onConfirmChange: (confirmed: boolean) => void;
  onBack: () => void;
}

/** Google's verdict on the delivery address, shown on the review step. SKIPPED / unavailable renders nothing and never blocks. */
export function AddressCheckBanner({ loading, result, confirmed, onConfirmChange, onBack }: AddressCheckBannerProps) {
  if (loading) return <p className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">Checking the delivery address with Google…</p>;
  if (!result || result.status === "SKIPPED") return null;

  if (result.status === "VERIFIED") {
    return (
      <div role="status" className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-400">
        ✓ Address verified by Google.
      </div>
    );
  }

  const invalid = result.status === "INVALID";
  return (
    <div role={invalid ? "alert" : "status"} className={`grid gap-2 rounded-lg border p-3 text-sm ${invalid ? "border-destructive/50 bg-destructive/10 text-destructive" : "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"}`}>
      <p className="font-medium">{invalid ? "Google could not find this address." : "Google could only partly confirm this address."}</p>
      {result.reasons.length ? (
        <ul className="list-disc pl-5 text-xs">
          {result.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
      {result.formattedAddress ? (
        <p className="text-xs">
          Google suggests: <span className="font-medium break-words">{result.formattedAddress}</span>
        </p>
      ) : null}
      <button type="button" onClick={onBack} className="w-fit text-xs font-medium underline underline-offset-2">
        Go back and edit the address
      </button>
      {invalid ? (
        <label className="flex cursor-pointer items-start gap-2 text-xs">
          <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => onConfirmChange(e.target.checked)} />
          <span>I have confirmed this address with the customer. Create the order anyway.</span>
        </label>
      ) : null}
    </div>
  );
}
