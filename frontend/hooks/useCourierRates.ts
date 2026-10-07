import { useQuery } from "@tanstack/react-query";
import { serviceabilityQueryOptions } from "@/lib/api-client/queries/delivery.queries";
import type { ServiceabilityResult } from "@/lib/api-client/types/delivery.types";
import { rateKey, type RateInputs } from "@/lib/package-dimensions";
import { useDebouncedValue } from "./useDebouncedValue";

export const RATE_DEBOUNCE_MS = 600;

/**
 * Shiprocket's rate calculator for the parcel as it is NOW. Requested automatically once every input is valid, only after the inputs have stopped
 * changing (no request per keystroke), and again whenever any of them changes. A result is returned only if it was requested for exactly the
 * current inputs - after any change the previous result is gone (never shown or used) until the new one arrives.
 * The charges are Shiprocket's; nothing here computes one.
 */
export function useCourierRates(inputs: RateInputs | null, enabled = true) {
  const key = inputs ? rateKey(inputs) : null;
  const settledKey = useDebouncedValue(key, RATE_DEBOUNCE_MS);
  const settled = inputs && settledKey === key ? inputs : null;
  const query = useQuery({
    ...serviceabilityQueryOptions(settled?.pincode ?? "", settled?.cod ?? false, settled?.weightKg ?? 0, settled?.dims ?? undefined, settled?.value),
    enabled: enabled && settled !== null,
  });
  const waiting = enabled && key !== null && settledKey !== key;
  const calculating = enabled && key !== null && (waiting || query.isFetching);
  const result: ServiceabilityResult | undefined = settled && !waiting ? query.data : undefined;
  return {
    /** The rates for exactly the current inputs, or undefined while they are being (re)calculated / not yet requested. */
    result,
    calculating,
    failed: Boolean(settled && query.isError && !query.isFetching),
    /** The key the shown result belongs to (equals rateKey(current inputs) whenever `result` is defined). */
    key,
    refresh: () => void query.refetch(),
  };
}
