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
  // Every part is taken field-for-field when it exists. A part the record does not have falls back to the legacy composed line it would have been folded into, so a partly structured
  // address never loses what it holds: no House/Flat -> line1; no Area and no Street -> line2.
  const structured = Boolean(saved?.houseNumber || saved?.area);
  const houseNumber = saved?.houseNumber || (structured && saved?.building ? "" : (saved?.line1 ?? ""));
  const area = saved?.area || (saved?.street ? "" : (saved?.line2 ?? ""));
  return { houseNumber, building: saved?.building ?? "", area, street: saved?.street ?? "", landmark: saved?.landmark ?? "", addressType: type };
}

export interface AddressDraftFields extends StructuredAddress {
  name: string;
  phone: string;
  deliveryInstructions: string;
}

export interface SavedFull extends SavedAddress {
  name?: string;
  phone?: string;
  pincode?: string;
  city?: string;
  state?: string;
  deliveryInstructions?: string;
}

/**
 * The address shown in the Create Order form. Precedence for EVERY field: what the operator typed (even an emptied field) > the saved address (the selected customer's) > what the
 * pincode itself resolves to (city/state only). A saved value never replaces something typed, and changing an unrelated order field never touches any of this.
 */
export function buildAddressDraft(input: {
  saved: SavedFull | null;
  edits: Partial<AddressDraftFields>;
  customerName: string;
  customerMobile?: string;
  resolvedCity: string | null;
  resolvedState: string | null;
}): AddressDraftFields {
  const { saved, edits, customerName, customerMobile, resolvedCity, resolvedState } = input;
  const base = structuredFromSaved(saved);
  const pincode = edits.pincode ?? saved?.pincode ?? "";
  const sameAsSaved = Boolean(saved && saved.pincode === pincode);
  return {
    // `||` (not `??`) for what is merely suggested: a saved address with an EMPTY name/phone still falls back to the selected customer's own.
    name: edits.name ?? (saved?.name || customerName),
    phone: edits.phone ?? (saved?.phone || customerMobile || ""),
    houseNumber: edits.houseNumber ?? base.houseNumber,
    building: edits.building ?? base.building,
    area: edits.area ?? base.area,
    street: edits.street ?? base.street,
    landmark: edits.landmark ?? base.landmark,
    addressType: edits.addressType ?? base.addressType,
    pincode,
    deliveryInstructions: edits.deliveryInstructions ?? (saved?.deliveryInstructions ?? ""),
    city: edits.city ?? ((sameAsSaved && saved!.city) || (resolvedCity ?? "")),
    state: edits.state ?? ((sameAsSaved && saved!.state) || (resolvedState ?? "")),
  };
}
