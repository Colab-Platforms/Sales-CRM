// The order's shipping charge comes ONLY from the Shiprocket rate of the selected courier. Nothing here computes a charge: it picks one of the
// couriers Shiprocket returned (the cheapest by default, or the one the operator chose) and passes its charge through unchanged.
import type { CourierOption, ServiceabilityResult } from "@/lib/api-client/types/delivery.types";

export const courierKey = (o: Pick<CourierOption, "name" | "rate">): string => `${o.name ?? "courier"}|${o.rate ?? ""}`;

/** Couriers that came back with a usable (numeric) charge, cheapest first. A courier without a charge can never be selected. */
export const priced = (options: CourierOption[] | undefined): CourierOption[] => (options ?? []).filter((o) => o.rate !== null && o.rate !== undefined).sort((a, b) => a.rate! - b.rate!);

/** The chosen courier if it is still among the returned ones, otherwise the cheapest (the existing default). */
export function selectedCourier(options: CourierOption[] | undefined, pickKey: string | null): CourierOption | null {
  const list = priced(options);
  return (pickKey ? list.find((o) => courierKey(o) === pickKey) : undefined) ?? list[0] ?? null;
}

export type ShippingChargeState =
  | { kind: "idle" } // rates not requested yet (something is still missing): "Not calculated"
  | { kind: "calculating" } // inputs changed / request in flight: no charge, never the previous one
  | { kind: "rate"; amount: number; courier: string | null } // Shiprocket's charge for the selected courier (0 only if Shiprocket said 0)
  | { kind: "unavailable" }; // Shiprocket failed or returned no usable rate: "Not available"

export function shippingChargeState(input: { requested: boolean; calculating: boolean; failed: boolean; result: ServiceabilityResult | undefined; pickKey: string | null }): ShippingChargeState {
  if (!input.requested) return { kind: "idle" };
  if (input.calculating) return { kind: "calculating" };
  if (input.failed) return { kind: "unavailable" };
  if (!input.result) return { kind: "calculating" };
  if (input.result.status !== "serviceable") return { kind: "unavailable" };
  const chosen = selectedCourier(input.result.courierOptions, input.pickKey);
  return chosen ? { kind: "rate", amount: chosen.rate!, courier: chosen.name } : { kind: "unavailable" };
}

/** The charge as the amount field's text: Shiprocket's value verbatim, "" when there is none. */
export const chargeText = (s: ShippingChargeState): string => (s.kind === "rate" ? String(s.amount) : "");
