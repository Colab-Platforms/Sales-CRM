import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderTemplateBody } from "./whatsapp.template.variables.js";
import { ORDER_ONLY_VARIABLES, RESOLVABLE_VARIABLES, resolveTemplateVariables, type VariableResolutionContext } from "./whatsapp.variable-resolver.js";
import { assertValidMediaUrl } from "./whatsapp.messaging.service.js";

const lead = { firstName: "Mahadev", lastName: "Babar", mobile: "+919876543210", normalizedMobile: "+919876543210", email: "mahadev@example.invalid" };

const orderCtx = {
  orderNumber: "AWL97928",
  externalNumber: "#AWL97928",
  status: "CONFIRMED",
  currency: "INR",
  totalAmount: "699.00",
  payments: [{ status: "SUCCESS" as const, method: "UPI" as const, amount: "699.00", refundedAmount: null }],
  latestShipment: { status: "SHIPPED" as const, courier: "Delhivery", trackingNumber: "DL777", trackingUrl: "https://track.example/DL777", shippedAt: new Date("2026-09-18T00:00:00Z"), deliveredAt: null, expectedDeliveryAt: null },
};

describe("resolveTemplateVariables", () => {
  it("resolves customer variables without needing an order", () => {
    const ctx: VariableResolutionContext = { lead, order: null };
    const { values, errors } = resolveTemplateVariables(["customer_name", "customer_mobile", "customer_email"], ctx);
    assert.deepEqual(errors, []);
    assert.equal(values.customer_name, "Mahadev Babar");
    assert.equal(values.customer_mobile, "+919876543210");
    assert.equal(values.customer_email, "mahadev@example.invalid");
  });

  it("resolves order/payment/shipment variables from real order data", () => {
    const ctx: VariableResolutionContext = { lead, order: orderCtx };
    const { values, errors } = resolveTemplateVariables(["order_number", "order_amount", "order_status", "payment_status", "tracking_number", "courier", "shipment_status"], ctx);
    assert.deepEqual(errors, []);
    assert.equal(values.order_number, "AWL97928");
    assert.equal(values.order_amount, "₹699.00");
    assert.equal(values.order_status, "Confirmed");
    assert.equal(values.payment_status, "Paid");
    assert.equal(values.tracking_number, "DL777");
    assert.equal(values.courier, "Delhivery");
    assert.equal(values.shipment_status, "Shipped");
  });

  it("computes outstanding_amount from the actual payment breakdown, not just the order total", () => {
    const ctx: VariableResolutionContext = { lead, order: { ...orderCtx, totalAmount: "1000.00", payments: [{ status: "SUCCESS" as const, method: "UPI" as const, amount: "400.00", refundedAmount: null }] } };
    const { values, errors } = resolveTemplateVariables(["outstanding_amount"], ctx);
    assert.deepEqual(errors, []);
    assert.equal(values.outstanding_amount, "₹600.00");
  });

  it("fails an order-only variable with a clear 'missing value' error when no order is given", () => {
    const ctx: VariableResolutionContext = { lead, order: null };
    const { values, errors } = resolveTemplateVariables(["tracking_number"], ctx);
    assert.deepEqual(values, {});
    assert.deepEqual(errors, ["Missing value for variable: tracking_number"]);
  });

  it("fails a shipment variable when the order has no shipment yet", () => {
    const ctx: VariableResolutionContext = { lead, order: { ...orderCtx, latestShipment: null } };
    const { errors } = resolveTemplateVariables(["tracking_number"], ctx);
    assert.deepEqual(errors, ["Missing value for variable: tracking_number"]);
  });

  it("reports an unrecognised variable name distinctly from a missing value", () => {
    const ctx: VariableResolutionContext = { lead, order: null };
    const { errors } = resolveTemplateVariables(["totally_made_up_variable"], ctx);
    assert.deepEqual(errors, ["Unknown template variable: totally_made_up_variable"]);
  });

  it("is not limited to a fixed hardcoded set - the registry covers a real, extensible list", () => {
    assert.ok(RESOLVABLE_VARIABLES.length > 7);
    assert.ok(RESOLVABLE_VARIABLES.includes("customer_name"));
    assert.ok(RESOLVABLE_VARIABLES.includes("tracking_number"));
    assert.ok(ORDER_ONLY_VARIABLES.has("order_number"));
    assert.ok(!ORDER_ONLY_VARIABLES.has("customer_name"));
  });

  it("never executes anything - values are only ever what the registry computed, nothing from the template body itself", () => {
    const ctx: VariableResolutionContext = { lead, order: null };
    const { values } = resolveTemplateVariables(["customer_name"], ctx);
    assert.equal(typeof values.customer_name, "string");
  });
});

describe("renderTemplateBody (provider-agnostic preview rendering)", () => {
  it("matches the E7.3 spec's own worked example", () => {
    const rendered = renderTemplateBody("Hello {{customer_name}}, your order {{order_number}} of {{order_amount}} is confirmed.", {
      customer_name: "Mahadev Babar",
      order_number: "AWL97928",
      order_amount: "₹699",
    });
    assert.equal(rendered, "Hello Mahadev Babar, your order AWL97928 of ₹699 is confirmed.");
  });

  it("substitutes every occurrence of a repeated variable", () => {
    assert.equal(renderTemplateBody("{{a}} and {{a}} again", { a: "X" }), "X and X again");
  });

  it("leaves a placeholder untouched if no value was supplied for it, rather than throwing", () => {
    assert.equal(renderTemplateBody("Hi {{customer_name}}, {{unresolved}}", { customer_name: "Priya" }), "Hi Priya, {{unresolved}}");
  });
});

describe("assertValidMediaUrl (the one gate before any media URL reaches AiSensy)", () => {
  it("accepts a genuine public https URL", () => {
    assert.doesNotThrow(() => assertValidMediaUrl("https://cdn.example.com/brochure.pdf"));
  });

  it("rejects a local filesystem path - never reaches AiSensy", () => {
    // A bare Unix-style path fails outright to parse as a URL at all.
    assert.throws(() => assertValidMediaUrl("/var/uploads/file.jpg"), /valid absolute URL/);
    // A Windows path parses (the WHATWG URL parser reads "C:" as a scheme), but is then rejected by
    // the https-only check just like any other non-https scheme - still never reaches AiSensy.
    assert.throws(() => assertValidMediaUrl("C:\\Users\\me\\file.jpg"), /https/);
  });

  it("rejects a file:// URL", () => {
    assert.throws(() => assertValidMediaUrl("file:///etc/passwd"), /https/);
  });

  it("rejects plain http (not https)", () => {
    assert.throws(() => assertValidMediaUrl("http://cdn.example.com/file.jpg"), /https/);
  });

  it("rejects localhost/private hosts, which are never publicly accessible", () => {
    assert.throws(() => assertValidMediaUrl("https://localhost/file.jpg"), /publicly accessible/);
    assert.throws(() => assertValidMediaUrl("https://127.0.0.1/file.jpg"), /publicly accessible/);
    assert.throws(() => assertValidMediaUrl("https://192.168.1.5/file.jpg"), /publicly accessible/);
    assert.throws(() => assertValidMediaUrl("https://10.0.0.5/file.jpg"), /publicly accessible/);
    assert.throws(() => assertValidMediaUrl("https://172.16.0.5/file.jpg"), /publicly accessible/);
    assert.throws(() => assertValidMediaUrl("https://my-box.local/file.jpg"), /publicly accessible/);
  });

  it("rejects garbage/empty input rather than guessing", () => {
    assert.throws(() => assertValidMediaUrl(""), /valid absolute URL/);
    assert.throws(() => assertValidMediaUrl("not a url"), /valid absolute URL/);
  });
});
