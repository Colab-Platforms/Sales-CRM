import type { OrderDetail, UpdateShippingAddressInput } from "@/lib/api-client/types/orders.types";

/** The address form's fields, pre-filled from the stored address; blank optional fields are not sent. */
export function addressDraft(order: Pick<OrderDetail, "shippingAddress" | "shippingPincode">): UpdateShippingAddressInput {
  const a = order.shippingAddress ?? {};
  return { name: a.name ?? "", phone: a.phone ?? "", line1: a.line1 ?? "", line2: a.line2 ?? "", city: a.city ?? "", state: a.state ?? "", pincode: a.pincode ?? order.shippingPincode ?? "" };
}

/** Client-side check mirroring the server's required fields, so an obviously incomplete form is not sent. */
export function validateAddressDraft(d: UpdateShippingAddressInput): string | null {
  if (!d.line1?.trim()) return "House / Flat / Building No. is required";
  if (!d.city?.trim()) return "City is required";
  if (!d.state?.trim()) return "State is required";
  if (!/^[1-9]\d{5}$/.test((d.pincode ?? "").trim())) return "Pincode must be a valid 6-digit Indian pincode";
  return null;
}

