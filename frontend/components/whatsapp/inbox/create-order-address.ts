// Pure address helpers for the Create Order form (no React, no I/O) so the rules are testable on their own.
// The backend (orders.validators.ts shippingAddressSchema) re-validates everything; this is the same rule set run early.

export type AddressType = "HOME" | "WORK" | "OTHER";
export const ADDRESS_TYPES: { value: AddressType; label: string }[] = [
  { value: "HOME", label: "Home" },
  { value: "WORK", label: "Work" },
  { value: "OTHER", label: "Other" },
];

export interface StructuredAddress {
  pincode: string;
  /** House / Flat / Building No. */
  houseNumber: string;
  building: string;
  area: string;
  street: string;
  landmark: string;
  city: string;
  state: string;
  addressType: AddressType;
}

export type AddressErrors = Partial<Record<"pincode" | "houseNumber" | "area" | "city" | "state", string>>;

// "Has real content": at least one letter or digit (any script). Rejects blank and punctuation-only ("-", "...") while
// accepting every legitimate Indian format - "12/A", "No. 3-B, 2nd Floor", "J.P. Nagar 2nd Phase".
const hasContent = (v: string) => /[\p{L}\p{N}]/u.test(v);

export const isValidPincode = (p: string) => /^[1-9]\d{5}$/.test(p);

export function validateAddress(a: StructuredAddress): AddressErrors {
  const errors: AddressErrors = {};
  if (!a.pincode.trim()) errors.pincode = "Pincode is required";
  else if (!isValidPincode(a.pincode.trim())) errors.pincode = "Enter a valid 6-digit pincode";
  if (!hasContent(a.houseNumber)) errors.houseNumber = "House / Flat / Building No. is required";
  if (!hasContent(a.area)) errors.area = "Area / Locality is required";
  if (!hasContent(a.city)) errors.city = "City is required";
  if (!hasContent(a.state)) errors.state = "State is required";
  return errors;
}

const join = (parts: string[]) => parts.map((p) => p.trim()).filter(Boolean).join(", ");

/** The two lines every downstream integration (Shopify, Shiprocket, order pages) already reads. */
export function composeLines(a: Pick<StructuredAddress, "houseNumber" | "building" | "area" | "street" | "landmark">): { line1: string; line2: string } {
  return { line1: join([a.houseNumber, a.building]), line2: join([a.street, a.area, a.landmark]) };
}

export function formatAddress(a: StructuredAddress): string {
  const { line1, line2 } = composeLines(a);
  return join([line1, line2, a.city, a.state, a.pincode]);
}

export interface SavedAddress {
  line1?: string;
  line2?: string;
  houseNumber?: string;
  building?: string;
  area?: string;
  street?: string;
  landmark?: string;
  addressType?: string;
}

/**
 * Prefill from a customer's previous order. A structured record maps field-for-field. A legacy free-text record (only
 * line1/line2) is carried over without loss: line1 -> House/Flat, line2 -> Area/Locality, both editable, so the
 * salesperson upgrades it to the structured format simply by confirming/adjusting it.
 */
export function structuredFromSaved(saved: SavedAddress | null | undefined): Pick<StructuredAddress, "houseNumber" | "building" | "area" | "street" | "landmark" | "addressType"> {
  const type = (["HOME", "WORK", "OTHER"] as const).find((t) => t === saved?.addressType) ?? "HOME";
  if (saved?.houseNumber || saved?.area) {
    return { houseNumber: saved.houseNumber ?? "", building: saved.building ?? "", area: saved.area ?? "", street: saved.street ?? "", landmark: saved.landmark ?? "", addressType: type };
  }
  return { houseNumber: saved?.line1 ?? "", building: "", area: saved?.line2 ?? "", street: "", landmark: "", addressType: type };
}
