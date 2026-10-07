// Run with: ../backend/node_modules/.bin/tsx --test components/whatsapp/inbox/whatsapp-payment-section.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { WhatsAppPaymentSection } from "./whatsapp-payment-section";
import { friendlyWhatsApp } from "./create-order-sections";
import { NO_WHATSAPP, selectedTemplate, toApiWhatsApp, whatsappBlockReason, type PaymentTemplateOption, type WhatsAppPaymentOptions } from "@/lib/whatsapp-payment";

const tpl = (over: Partial<PaymentTemplateOption>): PaymentTemplateOption => ({ id: "t1", name: "prepaid_template", language: "en", category: "UTILITY", provider: "META", variables: ["customer_name", "order_number", "amount", "payment_link"], usableForPaymentLink: true, isDefault: true, ...over });
const options = (over: Partial<WhatsAppPaymentOptions> = {}): WhatsAppPaymentOptions => ({ templates: [tpl({}), tpl({ id: "t2", name: "payment_reminder", isDefault: false })], consent: null, hasWhatsAppNumber: true, ...over });
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const SEND = { ...NO_WHATSAPP, send: true };

describe("choice logic", () => {
  it("defaults to Don't send; the payload then carries only an explicit false (nothing else changes)", () => {
    assert.equal(NO_WHATSAPP.send, false);
    assert.deepEqual(toApiWhatsApp(options(), NO_WHATSAPP), { sendPaymentLinkViaWhatsApp: false });
    assert.equal(whatsappBlockReason(options(), false, NO_WHATSAPP), null);
  });
  it("the default template is prepaid_template; a picked template wins; others stay selectable (nothing hardcoded)", () => {
    assert.equal(selectedTemplate(options(), SEND)?.name, "prepaid_template");
    assert.equal(selectedTemplate(options(), { ...SEND, templateId: "t2" })?.name, "payment_reminder");
    assert.equal(selectedTemplate(options({ templates: [tpl({ id: "x", name: "other", isDefault: false })] }), SEND)?.name, "other");
    assert.equal(selectedTemplate(options({ templates: [] }), SEND), null);
  });
  it("the payload sends the template's INTERNAL id (never a Meta numeric id) and the ticked consent", () => {
    assert.deepEqual(toApiWhatsApp(options(), { send: true, templateId: null, consent: true }), { sendPaymentLinkViaWhatsApp: true, whatsappTemplateId: "t1", whatsappConsent: true });
    assert.deepEqual(toApiWhatsApp(options({ consent: "OPTED_IN" }), { send: true, templateId: "t2", consent: false }), { sendPaymentLinkViaWhatsApp: true, whatsappTemplateId: "t2" });
  });
  it("blocks until number, consent and template are in place; OPTED_OUT can never be ticked through", () => {
    assert.match(whatsappBlockReason(null, true, SEND) ?? "", /Loading/);
    assert.match(whatsappBlockReason(options({ hasWhatsAppNumber: false }), false, { ...SEND, consent: true }) ?? "", /valid WhatsApp number/);
    assert.match(whatsappBlockReason(options({ consent: "OPTED_OUT" }), false, { ...SEND, consent: true }) ?? "", /opted out/);
    assert.match(whatsappBlockReason(options({ templates: [] }), false, { ...SEND, consent: true }) ?? "", /No approved WhatsApp payment template/);
    assert.match(whatsappBlockReason(options(), false, SEND) ?? "", /agreed to receive WhatsApp updates/);
    assert.equal(whatsappBlockReason(options(), false, { ...SEND, consent: true }), null);
    assert.equal(whatsappBlockReason(options({ consent: "OPTED_IN" }), false, SEND), null, "recorded consent needs no tick");
  });
});

describe("Payment Link section", () => {
  const render = (choice = NO_WHATSAPP, o: WhatsAppPaymentOptions | null = options(), loading = false) =>
    renderToStaticMarkup(<WhatsAppPaymentSection options={o} loading={loading} choice={choice} onChange={() => {}} />);

  it("shows Don't send / Send via WhatsApp, with Don't send selected and nothing else until WhatsApp is chosen", () => {
    const h = render();
    assert.match(text(h), /Payment Link Don't send Send via WhatsApp/);
    assert.match(h, /aria-checked="true"[^>]*>Don&#x27;t send/);
    assert.doesNotMatch(text(h), /WhatsApp Template|agreed to receive/);
  });
  it("Send via WhatsApp: template dropdown (prepaid_template first and selected), consent checkbox with helper text, and what the template sends", () => {
    const h = render(SEND);
    const t = text(h);
    assert.match(t, /WhatsApp Template/);
    assert.match(t, /prepaid_template · en/);
    assert.match(t, /payment_reminder · en/);
    assert.match(t, /Sends: customer_name, order_number, amount, payment_link/);
    assert.match(t, /Customer has agreed to receive WhatsApp updates/);
    assert.match(t, /Required before sending a business-initiated WhatsApp message\./);
    assert.match(h, /type="checkbox"/);
    assert.match(h, /<option[^>]*value="t1"[^>]*selected|selected[^>]*value="t1"/);
  });
  it("no recorded consent: says so and offers the confirmation checkbox; opted out says that instead", () => {
    assert.match(text(render(SEND)), /Customer has not given WhatsApp consent\./);
    assert.match(text(render(SEND)), /Customer has agreed to receive WhatsApp updates/);
    assert.match(text(render(SEND, options({ consent: "UNKNOWN" }))), /Customer has not given WhatsApp consent\./);
    assert.match(text(render(SEND, options({ consent: "OPTED_OUT" }))), /Customer has opted out of WhatsApp messages\./);
    assert.doesNotMatch(text(render(SEND, options({ consent: "OPTED_IN" }))), /has not given/);
  });
  it("consent already recorded: no checkbox, a clear note instead", () => {
    const t = text(render(SEND, options({ consent: "OPTED_IN" })));
    assert.match(t, /consent already recorded/i);
    assert.doesNotMatch(t, /Customer has agreed/);
  });
  it("shows exactly what is missing (consent / opted out / no number / no template)", () => {
    assert.match(text(render(SEND)), /Confirm that the customer has agreed/);
    assert.match(text(render(SEND, options({ consent: "OPTED_OUT" }))), /opted out/);
    assert.match(text(render(SEND, options({ hasWhatsAppNumber: false }))), /valid WhatsApp number/);
    assert.match(text(render({ ...SEND, consent: true }, options({ templates: [] }))), /No approved payment template/);
  });
  it("loading state is shown while the options load", () => {
    assert.match(text(render(SEND, null, true)), /Loading/);
  });
});

describe("result message", () => {
  it("does not repeat 'Payment link not sent' and never shows a provider/credential error", () => {
    assert.equal(friendlyWhatsApp("Payment link not sent — WhatsApp consent is required before sending a business-initiated message."), "WhatsApp consent is required before sending a business-initiated message.");
    const unsafe = friendlyWhatsApp("Payment link not sent — Meta Cloud API rejected the template message (HTTP 401): Invalid OAuth access token [REDACTED]");
    assert.match(unsafe, /couldn't deliver the message right now/);
    assert.doesNotMatch(unsafe, /OAuth|HTTP 401/);
  });
});
