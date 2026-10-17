import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { possibleDuplicateOf } from "./duplicate-order";

const axiosError = (status: number, body: unknown) => ({ response: { status, data: body } });

describe("possibleDuplicateOf: recognising the server's 'a matching recent order exists' warning", () => {
  it("recognises the 409 with the machine-readable code and returns the server's message and the existing order number", () => {
    const found = possibleDuplicateOf(axiosError(409, { success: false, message: "A matching order (CRM-1, pending payment) was already created for this customer 31 minutes ago.", data: { code: "POSSIBLE_DUPLICATE_ORDER", orderNumber: "CRM-1" } }));
    assert.deepEqual(found, { message: "A matching order (CRM-1, pending payment) was already created for this customer 31 minutes ago.", orderNumber: "CRM-1", replaceOrderId: null });
  });
  it("is not triggered by any other error: other 409s, other statuses, network errors, or nothing", () => {
    assert.equal(possibleDuplicateOf(axiosError(409, { message: "The order total changed.", data: null })), null);
    assert.equal(possibleDuplicateOf(axiosError(422, { message: "x", data: { code: "POSSIBLE_DUPLICATE_ORDER" } })), null);
    assert.equal(possibleDuplicateOf(axiosError(500, { message: "boom", data: {} })), null);
    assert.equal(possibleDuplicateOf(new Error("Network Error")), null);
    assert.equal(possibleDuplicateOf(null), null);
    assert.equal(possibleDuplicateOf(undefined), null);
  });
  it("falls back to a generic message and no order number when the body is thin", () => {
    const found = possibleDuplicateOf(axiosError(409, { data: { code: "POSSIBLE_DUPLICATE_ORDER" } }));
    assert.equal(found?.orderNumber, null);
    assert.match(found?.message ?? "", /matching order/);
  });
});

describe("possibleDuplicateOf: a re-priced open order can be replaced", () => {
  it("returns the order id to replace only when the server marks it supersedable", () => {
    const body = (data: Record<string, unknown>) => axiosError(409, { success: false, message: "open", data: { code: "POSSIBLE_DUPLICATE_ORDER", orderNumber: "CRM-9", ...data } });
    assert.equal(possibleDuplicateOf(body({ orderId: "11111111-1111-4111-8111-111111111111", supersedable: true }))?.replaceOrderId, "11111111-1111-4111-8111-111111111111");
    assert.equal(possibleDuplicateOf(body({ orderId: "11111111-1111-4111-8111-111111111111" }))?.replaceOrderId, null);
    assert.equal(possibleDuplicateOf(body({}))?.replaceOrderId, null);
  });
});
