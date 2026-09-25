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

export interface ServiceabilityResult {
  status: ServiceabilityStatus;
  couriers: number;
  cheapestRate: number | null;
  minDays: number | null;
  maxDays: number | null;
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
}
