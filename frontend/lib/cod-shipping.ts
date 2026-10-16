// Cash on Delivery orders are charged a FLAT shipping fee, whatever the courier rate, item count or weight. The backend (orders.shipping.ts) is the authority and recomputes it - this is only what the
// order form shows and sends, so the preview, the request and the saved order agree. Prepaid orders ship free (the prepaid promotion is a discount, not a shipping rule).
export const COD_SHIPPING_CHARGE = "50.00";
