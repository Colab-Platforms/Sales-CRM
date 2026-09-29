import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderTemplateBody } from "./whatsapp.template.variables.js";
import { classifyVariable, ORDER_ONLY_VARIABLES, RESOLVABLE_VARIABLES, resolveTemplateVariables, type VariableResolutionContext } from "./whatsapp.variable-resolver.js";
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

  it("fails an order-only variable with a clear 'value required' error when no order is given", () => {
    const ctx: VariableResolutionContext = { lead, order: null };
    const { values, errors } = resolveTemplateVariables(["tracking_number"], ctx);
    assert.deepEqual(values, {});
    assert.deepEqual(errors, ["Value required for tracking_number"]);
  });

  it("fails a shipment variable when the order has no shipment yet", () => {
    const ctx: VariableResolutionContext = { lead, order: { ...orderCtx, latestShipment: null } };
    const { errors } = resolveTemplateVariables(["tracking_number"], ctx);
    assert.deepEqual(errors, ["Value required for tracking_number"]);
  });

  // E9: a variable this CRM has no automatic source for (e.g. a webinar-specific name like
  // webinar_name) is never reported as "unknown" - it is a real variable of the template itself,
  // just one only a person can supply. classifyVariable is the single shared way the resolver and
  // the Send WhatsApp UI agree on which is which.
  it("classifies a variable with no CRM data source as manual, not unknown - and requires a value for it", () => {
    const ctx: VariableResolutionContext = { lead, order: null };
    assert.equal(classifyVariable("webinar_name"), "manual");
    assert.equal(classifyVariable("customer_name"), "crm");
    const { errors, fields } = resolveTemplateVariables(["webinar_name"], ctx);
    assert.deepEqual(errors, ["Value required for webinar_name"]);
    assert.deepEqual(fields, [{ name: "webinar_name", source: "manual", value: null }]);
  });

  it("accepts a manually supplied value for a variable with no CRM source", () => {
    const ctx: VariableResolutionContext = { lead, order: null };
    const { values, errors, fields } = resolveTemplateVariables(["customer_name", "webinar_name"], ctx, { webinar_name: "AyushWellness Webinar" });
    assert.deepEqual(errors, []);
    assert.equal(values.customer_name, "Mahadev Babar");
    assert.equal(values.webinar_name, "AyushWellness Webinar");
    assert.deepEqual(fields, [
      { name: "customer_name", source: "crm", value: "Mahadev Babar" },
      { name: "webinar_name", source: "manual", value: "AyushWellness Webinar" },
    ]);
  });

  it("lets a manually typed value override an otherwise-resolvable CRM variable", () => {
    const ctx: VariableResolutionContext = { lead, order: null };
    const { values } = resolveTemplateVariables(["customer_name"], ctx, { customer_name: "Preferred Name" });
    assert.equal(values.customer_name, "Preferred Name");
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
