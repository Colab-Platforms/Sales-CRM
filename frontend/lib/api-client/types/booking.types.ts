// E5 on-call booking: API shapes (mirror backend/src/modules/orders/orders.booking.*).

export interface BookingLead {
  id: string;
  leadNumber: string;
  firstName: string;
  lastName: string | null;
  mobile: string | null;
  email: string | null;
  location: string | null;
  workingStatus: string;
  externalSource: string | null;
  source: { name: string; type: string } | null;
  registeredOnWebsite: boolean;
  lastShippingAddress: unknown;
  lastShippingPincode: string | null;
}

export interface BookingLookupResult {
  normalizedMobile: string;
  leads: BookingLead[];
  existsForAnotherOwner: boolean;
}

export interface BookingVariant {
  id: string;
  title: string;
  sku: string | null;
  price: string;
  sellable: boolean;
  inventoryQuantity: number | null;
  tracksInventory: boolean;
}

export interface BookingProduct {
  id: string;
  title: string;
  sections: string[];
  variants: BookingVariant[];
}

export type ServiceabilityStatus = "SERVICEABLE" | "NOT_SERVICEABLE" | "UNKNOWN";

export interface ServiceabilityResult {
  pincode: string;
  status: ServiceabilityStatus;
  reason: string | null;
  courierCount: number | null;
  checkedAt: string;
}

export interface BookingItemInput {
  variantGid: string;
  quantity: number;
}

export interface BookingQuoteRequest {
  items: BookingItemInput[];
  discountPercent: number;
  discountReason?: string;
}

export interface BookingQuoteLine {
  variantGid: string;
  variantTitle: string;
  productGid: string;
  productTitle: string;
  sku: string | null;
  unitPrice: string;
  quantity: number;
  lineTotal: string;
}

export interface BookingQuote {
  currency: "INR";
  lines: BookingQuoteLine[];
  subtotal: string;
  discountPercent: number;
  discountAmount: string;
  total: string;
  maxDiscountPercent: number;
}