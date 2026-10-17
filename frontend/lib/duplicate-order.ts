// The server refuses (HTTP 409, data.code = POSSIBLE_DUPLICATE_ORDER) a new order that matches a very recent one for the same customer - same items, total and payment mode - unless the
// user confirms it is a separate purchase. Nothing was created by that refused request, so the form simply offers "create anyway", which resubmits with the SAME idempotency key plus the acknowledgement.
export interface PossibleDuplicate {
  message: string;
  orderNumber: string | null;
  /** Set when the open order has the same items but another total (price / discount changed): it can be REPLACED instead of leaving two payable orders. */
  replaceOrderId: string | null;
}

export function possibleDuplicateOf(error: unknown): PossibleDuplicate | null {
  const body = (error as { response?: { status?: number; data?: { message?: unknown; data?: { code?: unknown; orderNumber?: unknown; orderId?: unknown; supersedable?: unknown } | null } } } | null)?.response;
  if (!body || body.status !== 409 || body.data?.data?.code !== "POSSIBLE_DUPLICATE_ORDER") return null;
  const message = typeof body.data.message === "string" && body.data.message ? body.data.message : "A matching order was already created for this customer a moment ago.";
  const orderNumber = typeof body.data.data?.orderNumber === "string" ? body.data.data.orderNumber : null;
  const replaceOrderId = body.data.data?.supersedable === true && typeof body.data.data?.orderId === "string" ? body.data.data.orderId : null;
  return { message, orderNumber, replaceOrderId };
}
