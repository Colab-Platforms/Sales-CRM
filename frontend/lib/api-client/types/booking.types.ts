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

export type BookingPaymentMethod = "PAYMENT_LINK" | "COD";

export interface CreateBookingRequest {
  leadId: string;
  idempotencyKey: string;
  customer: { firstName: string; lastName?: string; mobile: string; email?: string };
  address: { line1: string; line2?: string; city: string; state: string; pincode: string };
  items: BookingItemInput[];
  discountPercent: number;
  discountReason?: string;
  paymentMethod: BookingPaymentMethod;
  confirmed: true;
}

export interface BookingOrder {
  id: string;
  orderNumber: string;
  status: string;
  subtotal: string;
  discountAmount: string;
  totalAmount: string;
  payments: { id: string; method: string | null; status: string }[];
}

export interface CreateBookingResult {
  order: BookingOrder;
  duplicate: boolean;
}

export interface BookingPaymentLink {
  paymentId: string;
  orderId: string;
  linkId: string;
  amount: string;
  currency: string;
  status: string;
  paymentUrl: string | null;
  expiresAt: string | null;
  reused: boolean;
  webhookRegistered: boolean;
}

export interface CreateBookingResponse extends CreateBookingResult {
  paymentLink: BookingPaymentLink | null;
  paymentLinkError: string | null;
  whatsApp: { sent: boolean; reason: string | null } | null;
}