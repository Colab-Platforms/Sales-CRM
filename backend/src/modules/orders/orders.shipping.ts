// The shipping charge of a CRM-created order is a BUSINESS RULE, decided by the backend and never taken from the browser or from a courier quote:
//   - Cash on Delivery: a flat INR 50, whatever the courier rate, item count, weight, pincode or the shippingAmount the request carried (one charge per order, never per item);
//   - prepaid: free (the prepaid promotion is a discount, see orders.service.ts - it is not a shipping rule).
// The courier quotes (Shiprocket) still decide whether a pincode is serviceable and what the shipment costs us; they no longer set what the customer is charged.
export const COD_SHIPPING_AMOUNT = "50.00";
export const COD_SHIPPING_CENTS = 5000;

/** The shipping charge in cents for a new order. */
export const shippingChargeCents = (isCod: boolean): number => (isCod ? COD_SHIPPING_CENTS : 0);
