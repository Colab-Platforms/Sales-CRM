// Address checks used while creating an order (backend: /delivery/*, /orders/last-address).

export type PincodeStatus = "valid" | "invalid" | "unavailable";

export interface PincodeLookup {
  pincode: string;
  status: PincodeStatus;
  /** The postal district - what an address calls the city. */
  city: string | null;
  state: string | null;
  areas: string[];
  message: string | null;
}

export type ServiceabilityStatus = "serviceable" | "not_serviceable" | "unavailable";

/** One courier exactly as Shiprocket's rate calculator returned it; a field Shiprocket did not return is null. The CRM computes none of these. */
export interface CourierOption {
  name: string | null;
  /** Shiprocket's total charge for this parcel. */
  rate: number | null;
  days: number | null;
  codCharge?: number | null;
  tax?: number | null;
  etd?: string | null;
}

export interface ServiceabilityResult {
  status: ServiceabilityStatus;
  couriers: number;
  cheapestRate: number | null;
  minDays: number | null;
  maxDays: number | null;
  /** Each available courier with the shipping charge Shiprocket returned for this parcel weight (cheapest first). */
  courierOptions?: CourierOption[];
  /** true only when the destination is not serviceable AND this deployment blocks such orders. */
  blocksOrder: boolean;
  message: string | null;
}

export interface LastShippingAddress {
  name: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
  // Present only when that order used the structured form; older free-text addresses leave them "".
  houseNumber: string;
  building: string;
  area: string;
  street: string;
  landmark: string;
  addressType: string;
}
