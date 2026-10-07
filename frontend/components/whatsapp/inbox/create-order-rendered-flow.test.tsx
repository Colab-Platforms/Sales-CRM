// Renders the REAL components (not just the pieces) the telecaller actually uses, with React Query's cache pre-filled the way the live
// GET /orders/whatsapp-payment-options answers, and asserts what is visible: the real Create Order dialog (form + review step, COD vs
// prepaid), the real result screen, and the real Send Payment Link dialog body. The Create Order dialog is rendered through its inline
// seam (the same JSX the dialog shows, minus the portal).
// Run with: ../backend/node_modules/.bin/tsx --test components/whatsapp/inbox/create-order-rendered-flow.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CreateOrderDialog } from "./create-order-dialog";
import { ResultView } from "./create-order-sections";
import { SendPaymentLinkBody } from "@/components/orders/send-payment-link-dialog";
import { whatsAppPaymentOptionsQueryOptions } from "@/lib/api-client/queries/orders.queries";
import type { WhatsAppPaymentOptions } from "@/lib/whatsapp-payment";
import type { CreateManualOrderResult } from "@/lib/api-client/types/orders.types";

const LEAD = "11111111-1111-4111-8111-111111111111";
const tpl = (id: string, name: string, isDefault: boolean) => ({ id, name, language: "en", category: "UTILITY", provider: "META" as const, variables: ["customer_name", "order_number", "amount", "payment_link"], usableForPaymentLink: true, isDefault });
// Shaped exactly like the real endpoint's answer (prepaid_template first/default, plus a second approved payment template).
const options = (over: Partial<WhatsAppPaymentOptions> = {}): WhatsAppPaymentOptions => ({ templates: [tpl("t1", "prepaid_template", true), tpl("t2", "payment_link", false)], consent: null, hasWhatsAppNumber: true, hasConversation: true, ...over });

// The attribute, not the "disabled:" Tailwind classes every button carries.
const isDisabled = (button: string) => / disabled(=""|>| )/.test(button.replace(/class="[^"]*"/, ""));
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const withClient = (node: React.ReactNode, data: WhatsAppPaymentOptions | null) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (data) client.setQueryData(whatsAppPaymentOptionsQueryOptions(LEAD).queryKey, data);
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
};
const dialog = (props: Partial<React.ComponentProps<typeof CreateOrderDialog>>, data: WhatsAppPaymentOptions | null = options()) =>
  renderToStaticMarkup(withClient(<CreateOrderDialog open onOpenChange={() => {}} leadId={LEAD} customerName="Vishwa" customerMobile="+919594849404" inline {...props} />, data));

describe("Create Order (real dialog content): form step", () => {
  it("COD: no payment-link / WhatsApp section at all (unchanged)", () => {
    const t = text(dialog({ initialOrderType: "COD" }));
    assert.doesNotMatch(t, /Don't send|Send via WhatsApp|WhatsApp Template/);
  });
  it("prepaid: 'Payment Link - Don't send / Send via WhatsApp' is visible right under the payment method", () => {
    const h = dialog({ initialOrderType: "PAYMENT_LINK" });
    const t = text(h);
    assert.match(t, /Payment Link Don't send Send via WhatsApp/);
    assert.match(h, /data-testid="whatsapp-payment"/);
    assert.ok(h.indexOf('data-testid="whatsapp-payment"') > h.indexOf("Payment method") || h.indexOf('data-testid="whatsapp-payment"') > 0);
    assert.doesNotMatch(t, /WhatsApp Template/, "dropdown stays hidden until Send via WhatsApp is chosen");
  });
  it("prepaid + Send via WhatsApp: the WhatsApp Template dropdown is rendered with prepaid_template selected and the second template listed, plus consent", () => {
    const h = dialog({ initialOrderType: "PAYMENT_LINK", initialSendViaWhatsApp: true });
    const t = text(h);
    assert.match(t, /WhatsApp Template/);
    assert.match(h, /<select[^>]*id="wa-template"/);
    assert.match(t, /prepaid_template · en/);
    assert.match(t, /payment_link · en/);
    assert.match(h, /<option[^>]*value="t1"[^>]*selected|selected[^>]*value="t1"/, "prepaid_template is the default selection");
    assert.match(t, /Customer has not given WhatsApp consent\./);
    assert.match(t, /Customer has agreed to receive WhatsApp updates/);
    assert.match(t, /Required before sending a business-initiated WhatsApp message\./);
  });
  it("already opted in: the recorded-consent note instead of the checkbox", () => {
    const t = text(dialog({ initialOrderType: "PAYMENT_LINK", initialSendViaWhatsApp: true }, options({ consent: "OPTED_IN" })));
    assert.match(t, /WhatsApp consent already recorded for this customer\./);
    assert.doesNotMatch(t, /Customer has agreed to receive/);
  });
  it("options not loaded yet: the section is still there and says it is loading (never silently absent)", () => {
    const t = text(dialog({ initialOrderType: "PAYMENT_LINK", initialSendViaWhatsApp: true }, null));
    assert.match(t, /WhatsApp Template/);
    assert.match(t, /Loading/);
  });
});

describe("Create Order (real dialog content): review step", () => {
  const review = (props: Partial<React.ComponentProps<typeof CreateOrderDialog>>, data: WhatsAppPaymentOptions | null = options()) => dialog({ initialStep: "review", ...props }, data);
  const buttonOf = (h: string, label: string) => new RegExp(`<button[^>]*>[^<]*${label}`).exec(h)?.[0] ?? "";

  it("prepaid review shows the same section, and the button reads 'Create Order & Send Payment Link' - disabled until consent is confirmed", () => {
    const h = review({ initialOrderType: "PAYMENT_LINK", initialSendViaWhatsApp: true });
    const t = text(h);
    assert.match(t, /WhatsApp Template/);
    assert.match(t, /Create Order & Send Payment Link/);
    assert.match(buttonOf(h, "Create Order & amp; Send Payment Link") || buttonOf(h, "Create Order &amp; Send Payment Link"), /disabled/);
  });
  it("with recorded consent the same button is enabled", () => {
    const h = review({ initialOrderType: "PAYMENT_LINK", initialSendViaWhatsApp: true }, options({ consent: "OPTED_IN" }));
    const b = buttonOf(h, "Create Order &amp; Send Payment Link");
    assert.ok(b !== "" && !isDisabled(b), "button is enabled");
  });
  it("opted out: blocked, and the reason is shown", () => {
    const h = review({ initialOrderType: "PAYMENT_LINK", initialSendViaWhatsApp: true }, options({ consent: "OPTED_OUT" }));
    assert.match(text(h), /opted out/);
    assert.match(buttonOf(h, "Create Order &amp; Send Payment Link"), /disabled/);
  });
  it("Don't send: the normal 'Create prepaid order' button, enabled, no template dropdown", () => {
    const h = review({ initialOrderType: "PAYMENT_LINK" });
    assert.doesNotMatch(text(h), /WhatsApp Template/);
    assert.ok(!isDisabled(buttonOf(h, "Create prepaid order")) && buttonOf(h, "Create prepaid order") !== "", "button is enabled");
  });
  it("COD review: 'Create COD order', no WhatsApp section", () => {
    const t = text(review({ initialOrderType: "COD" }));
    assert.match(t, /Create COD order/);
    assert.doesNotMatch(t, /Send via WhatsApp|WhatsApp Template/);
  });
});

const created = (whatsapp: CreateManualOrderResult["whatsapp"]): CreateManualOrderResult => ({
  order: { id: "o1", orderNumber: "AWL-1", currency: "INR", totalAmount: "449.00", paymentMode: "PREPAID", items: [{ id: "i1", productName: "Herbal Tea", variantName: null, quantity: 1 }], customer: { leadId: LEAD, name: "Vishwa", leadNumber: "L1", mobile: "+919594849404", email: null } },
  shopify: { status: "created", shopifyOrderName: "#1" },
  paymentLink: { status: "created", paymentId: "p1", paymentUrl: "https://payments.cashfree.com/links/abc", expiresAt: null },
  whatsapp,
} as unknown as CreateManualOrderResult);
const result = (r: CreateManualOrderResult) => renderToStaticMarkup(withClient(<ResultView result={r} customerMobile="+919594849404" onRetryShopify={() => {}} retrying={false} onCreateShipment={() => {}} onDone={() => {}} />, options()));

describe("Create Order result screen", () => {
  it("success names the template that was sent", () => {
    const t = text(result(created({ sent: true, via: "TEMPLATE", provider: "META", templateName: "payment_link" })));
    assert.match(t, /Payment link sent to \+919594849404 via Meta Cloud API/);
    assert.match(t, /Template: payment_link/);
  });
  it("not sent: a plain reason (no repetition, no provider error) and a 'Send Payment Link' button to choose a template and send now", () => {
    const h = result(created({ sent: false, via: null, provider: null, reason: "Not sent: WhatsApp sending was not selected." }));
    assert.match(text(h), /Payment link not sent/);
    assert.match(h, />Send Payment Link</);
  });
});

describe("Send Payment Link dialog body (existing order)", () => {
  const body = (data: WhatsAppPaymentOptions | null) => renderToStaticMarkup(withClient(<SendPaymentLinkBody paymentId="p1" orderId="o1" leadId={LEAD} customerName="Vishwa" onClose={() => {}} />, data));

  it("shows the WhatsApp Template dropdown with prepaid_template selected and the second template listed", () => {
    const h = body(options());
    const t = text(h);
    assert.match(t, /WhatsApp Template/);
    assert.match(h, /<select[^>]*id="payment-link-template"/);
    assert.match(t, /prepaid_template · en/);
    assert.match(t, /payment_link · en/);
    assert.match(h, /<option[^>]*value="t1"[^>]*selected|selected[^>]*value="t1"/);
    assert.match(t, /Send Payment Link/);
  });
  it("first contact (never messaged) without consent: visibly blocked, Send disabled, checkbox offered", () => {
    const h = body(options({ hasConversation: false }));
    assert.match(text(h), /Confirm that the customer has agreed to receive WhatsApp updates/);
    assert.match(text(h), /Customer has agreed to receive WhatsApp updates/);
    const send = /<button[^>]*>[^<]*Send Payment Link/.exec(h)?.[0] ?? "";
    assert.ok(send !== "" && isDisabled(send), "Send Payment Link is disabled");
  });
  it("first contact + opted out: blocked with the opt-out reason and no checkbox", () => {
    const t = text(body(options({ hasConversation: false, consent: "OPTED_OUT" })));
    assert.match(t, /opted out/);
    assert.doesNotMatch(t, /Customer has agreed to receive/);
  });
  it("existing OPTED_IN customer: consent noted, nothing blocks", () => {
    const h = body(options({ hasConversation: false, consent: "OPTED_IN" }));
    assert.doesNotMatch(text(h), /Confirm that the customer has agreed/);
  });
  it("no valid template: says so instead of an empty dropdown", () => {
    assert.match(text(body(options({ templates: [] }))), /No approved template/);
  });
});

describe("Create Order: parcel weight field (real dialog content)", () => {
  it("shows the helper text; no weight typed -> no error and nothing assumed", () => {
    const t = text(dialog({ initialOrderType: "PAYMENT_LINK" }));
    assert.match(t, /Parcel weight \(kg\)/);
    assert.match(t, /Parcel weight not available — enter the actual parcel weight\./);
    assert.doesNotMatch(t, /must be greater than 0|cannot be negative/);
  });
  it("0 and a negative weight are rejected visibly (the field is invalid and the reason is shown)", () => {
    assert.match(text(dialog({ initialWeight: "0" })), /Parcel weight must be greater than 0\./);
    assert.match(text(dialog({ initialWeight: "-0.5" })), /Parcel weight cannot be negative\./);
    assert.match(text(dialog({ initialWeight: "abc" })), /Parcel weight must be a number/);
  });
  it("a valid weight (0.5) raises no error", () => {
    assert.doesNotMatch(text(dialog({ initialWeight: "0.5" })), /Parcel weight (must|cannot)/);
  });
});


// ---------------------------------------------------------------------------------------------------------------------------
// Product weight -> suggested parcel weight, in the REAL dialog content with the product list seeded like GET /products answers.
import { productListQueryOptions } from "@/lib/api-client/queries/products.queries";
import type { ProductListItem } from "@/lib/api-client/types/products.types";

const P_A: ProductListItem = { id: "pa", name: "Ayush Wellness Product", sku: "AW-1", basePrice: "499.00", weightKg: "0.25", variants: [] };
const P_B: ProductListItem = { id: "pb", name: "Brain Fuel Capsules", sku: "AW-2", basePrice: "299.00", weightKg: null, variants: [{ id: "vb1", name: "Pack Of 1", sku: "AW-2-1", price: "299.00", weightKg: "0.1" }, { id: "vb3", name: "Pack Of 3", sku: "AW-2-3", price: "799.00", weightKg: null }] };
const P_NONE: ProductListItem = { id: "pn", name: "Unweighed Tonic", sku: "AW-3", basePrice: "150.00", weightKg: null, variants: [] };

const withProducts = (props: Partial<React.ComponentProps<typeof CreateOrderDialog>>) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(productListQueryOptions({ page: 1, pageSize: 100 }).queryKey, { items: [P_A, P_B, P_NONE], pagination: { page: 1, pageSize: 100, totalItems: 3, totalPages: 1 } });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CreateOrderDialog open onOpenChange={() => {}} leadId={LEAD} customerName="Vishwa" customerMobile="+919594849404" inline initialOrderType="PAYMENT_LINK" {...props} />
    </QueryClientProvider>,
  );
};
const weightValue = (h: string) => /id="ship-weight"[^>]*value="([^"]*)"|value="([^"]*)"[^>]*id="ship-weight"/.exec(h)?.slice(1).find((v) => v !== undefined) ?? null;

describe("Create Order (real dialog): product weight -> suggested parcel weight", () => {
  it("one product 0.25 kg x 2: the item shows its weights, the estimate is 0.5 kg, and the parcel weight is SUGGESTED as 0.5 with the right hint", () => {
    const h = withProducts({ initialItems: [{ productId: "pa", quantity: "2", unitPrice: "499.00" }] });
    const t = text(h);
    assert.match(t, /Weight: 0\.25 kg/);
    assert.match(t, /Product weight: 0\.50 kg \(estimate - not the parcel weight\)/);
    assert.equal(weightValue(h), "0.5");
    assert.match(t, /Suggested from product weights\. Adjust for packaging and actual parcel weight\./);
    assert.doesNotMatch(t, /Use suggested weight/, "nothing to restore - the value IS the suggestion");
  });

  it("several products: 0.25 x 2 + 0.10 x 1 = 0.6 kg", () => {
    const h = withProducts({ initialItems: [{ productId: "pa", quantity: "2", unitPrice: "499.00" }, { productId: "pb", variantId: "vb1", quantity: "1", unitPrice: "299.00" }] });
    assert.match(text(h), /Product weight: 0\.60 kg \(estimate - not the parcel weight\)/);
    assert.equal(weightValue(h), "0.6");
  });

  it("the quantity changes the suggestion (1 -> 0.25, 4 -> 1)", () => {
    assert.equal(weightValue(withProducts({ initialItems: [{ productId: "pa", quantity: "1", unitPrice: "499.00" }] })), "0.25");
    assert.equal(weightValue(withProducts({ initialItems: [{ productId: "pa", quantity: "4", unitPrice: "499.00" }] })), "1");
  });

  it("a typed parcel weight (0.5) is preserved even though the estimate is different (0.25 x 4 = 1), and the suggestion can be restored", () => {
    const h = withProducts({ initialItems: [{ productId: "pa", quantity: "4", unitPrice: "499.00" }], initialWeight: "0.5" });
    assert.equal(weightValue(h), "0.5");
    assert.match(text(h), /Estimated — used only to check courier availability\./);
    assert.match(text(h), /Product weight: 1\.00 kg \(estimate - not the parcel weight\)/);
    assert.match(text(h), /Use suggested weight/);
  });

  it("a product with NO recorded weight: the parcel weight is empty (not invented) and the operator is told to enter it", () => {
    const h = withProducts({ initialItems: [{ productId: "pn", quantity: "2", unitPrice: "150.00" }] });
    assert.equal(weightValue(h), "");
    assert.match(text(h), /Parcel weight not available — enter the actual parcel weight\./);
    assert.doesNotMatch(text(h), /Product weight:/);
  });

  it("only some products have weights: nothing is suggested, and the form says why", () => {
    const h = withProducts({ initialItems: [{ productId: "pa", quantity: "2", unitPrice: "499.00" }, { productId: "pn", quantity: "1", unitPrice: "150.00" }] });
    assert.equal(weightValue(h), "");
    assert.match(text(h), /Some product weights are not recorded\. Enter parcel weight manually\./);
  });

  it("a variant without a recorded weight (Pack Of 3) is treated as unknown even though Pack Of 1 has one", () => {
    const h = withProducts({ initialItems: [{ productId: "pb", variantId: "vb3", quantity: "1", unitPrice: "799.00" }] });
    assert.equal(weightValue(h), "");
    assert.match(text(h), /Parcel weight not available/);
  });

  it("invalid typed weights are rejected visibly: empty is simply not entered; 0, negative, non-numeric, >100 show the reason", () => {
    const items = [{ productId: "pn", quantity: "1", unitPrice: "150.00" }];
    assert.doesNotMatch(text(withProducts({ initialItems: items, initialWeight: "" })), /Parcel weight (must|cannot)/);
    assert.match(text(withProducts({ initialItems: items, initialWeight: "0" })), /must be greater than 0/);
    assert.match(text(withProducts({ initialItems: items, initialWeight: "-2" })), /cannot be negative/);
    assert.match(text(withProducts({ initialItems: items, initialWeight: "abc" })), /must be a number/);
    assert.match(text(withProducts({ initialItems: items, initialWeight: "101" })), /100 kg or less/);
  });
});
