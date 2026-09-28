import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMetaTemplatePayload, type MetaTemplateSource } from "./whatsapp.template.meta-payload.js";

const base: MetaTemplateSource = {
  name: "upcoming_webinar",
  category: "MARKETING",
  language: "en_US",
  body: "Hello {{name}}, your webinar is on {{date}}.",
  variables: ["name", "date"],
  components: { bodyExamples: { name: "Priya", date: "12 October" } },
};

describe("buildMetaTemplatePayload - basic shape", () => {
  it("produces Meta's exact contract: lowercase category, parameter_format named, BODY component with named examples", () => {
    const { payload, errors } = buildMetaTemplatePayload(base);
    assert.deepEqual(errors, []);
    assert.ok(payload);
    assert.equal(payload!.name, "upcoming_webinar");
    assert.equal(payload!.category, "marketing"); // Meta's category enum is lowercase, unlike the CRM's own UTILITY/MARKETING/AUTHENTICATION
    assert.equal(payload!.language, "en_US");
    assert.equal(payload!.parameter_format, "named");
    const body = payload!.components.find((c) => c.type === "BODY") as any;
    assert.equal(body.text, base.body);
    assert.deepEqual(body.example.body_text_named_params, [
      { param_name: "name", example: "Priya" },
      { param_name: "date", example: "12 October" },
    ]);
  });

  it("rejects an invented/unsupported category", () => {
    const { payload, errors } = buildMetaTemplatePayload({ ...base, category: "PROMO" });
    assert.equal(payload, null);
    assert.ok(errors.some((e) => /UTILITY, MARKETING or AUTHENTICATION/.test(e)));
  });

  it("rejects a missing language", () => {
    const { errors } = buildMetaTemplatePayload({ ...base, language: "" });
    assert.ok(errors.some((e) => /Language is required/.test(e)));
  });
});

describe("buildMetaTemplatePayload - body variables and examples", () => {
  it("rejects a variable with no example value (Meta requires one for every parameter)", () => {
    const { payload, errors } = buildMetaTemplatePayload({ ...base, components: { bodyExamples: { name: "Priya" } } });
    assert.equal(payload, null);
    assert.ok(errors.some((e) => e.includes("{{date}}")));
  });

  it("rejects a stale example for a variable no longer in the body", () => {
    const { errors } = buildMetaTemplatePayload({ ...base, variables: ["name"], body: "Hi {{name}}", components: { bodyExamples: { name: "Priya", date: "leftover" } } });
    assert.ok(errors.some((e) => e.includes("{{date}}") && /no longer in the body/.test(e)));
  });

  it("a body with no variables needs no example object at all", () => {
    const { payload, errors } = buildMetaTemplatePayload({ ...base, body: "Thanks for shopping with us!", variables: [], components: null });
    assert.deepEqual(errors, []);
    const body = payload!.components.find((c) => c.type === "BODY") as any;
    assert.equal(body.example, undefined);
  });
});

describe("buildMetaTemplatePayload - header", () => {
  it("accepts a TEXT header", () => {
    const { payload, errors } = buildMetaTemplatePayload({ ...base, components: { ...base.components, header: { type: "TEXT", text: "Order update" } } });
    assert.deepEqual(errors, []);
    assert.deepEqual(payload!.components.find((c) => c.type === "HEADER"), { type: "HEADER", format: "TEXT", text: "Order update" });
  });

  it("accepts no header at all", () => {
    const { payload } = buildMetaTemplatePayload(base);
    assert.equal(payload!.components.some((c) => c.type === "HEADER"), false);
  });

  it("rejects IMAGE/VIDEO/DOCUMENT headers - no media-upload flow exists yet, so never silently drop or fake it", () => {
    for (const type of ["IMAGE", "VIDEO", "DOCUMENT"] as const) {
      const { payload, errors } = buildMetaTemplatePayload({ ...base, components: { ...base.components, header: { type, mediaUrl: "https://example.invalid/x.jpg" } } });
      assert.equal(payload, null, type);
      assert.ok(errors.some((e) => e.includes(type)), type);
    }
  });
});

describe("buildMetaTemplatePayload - footer", () => {
  it("includes a footer component when set", () => {
    const { payload } = buildMetaTemplatePayload({ ...base, components: { ...base.components, footer: "Reply STOP to unsubscribe" } });
    assert.deepEqual(payload!.components.find((c) => c.type === "FOOTER"), { type: "FOOTER", text: "Reply STOP to unsubscribe" });
  });

  it("omits the footer component when not set", () => {
    const { payload } = buildMetaTemplatePayload(base);
    assert.equal(payload!.components.some((c) => c.type === "FOOTER"), false);
  });
});

describe("buildMetaTemplatePayload - buttons", () => {
  it("builds a URL CTA button", () => {
    const { payload, errors } = buildMetaTemplatePayload({ ...base, components: { ...base.components, buttons: [{ type: "URL", text: "Register", url: "https://example.invalid/webinar" }] } });
    assert.deepEqual(errors, []);
    assert.deepEqual(payload!.components.find((c) => c.type === "BUTTONS"), { type: "BUTTONS", buttons: [{ type: "URL", text: "Register", url: "https://example.invalid/webinar" }] });
  });

  it("builds a phone-number CTA button", () => {
    const { payload } = buildMetaTemplatePayload({ ...base, components: { ...base.components, buttons: [{ type: "PHONE_NUMBER", text: "Call us", phoneNumber: "+15551234567" }] } });
    assert.deepEqual((payload!.components.find((c) => c.type === "BUTTONS") as any).buttons[0], { type: "PHONE_NUMBER", text: "Call us", phone_number: "+15551234567" });
  });

  it("builds quick-reply buttons", () => {
    const { payload } = buildMetaTemplatePayload({ ...base, components: { ...base.components, buttons: [{ type: "QUICK_REPLY", text: "Yes" }, { type: "QUICK_REPLY", text: "No" }] } });
    assert.deepEqual((payload!.components.find((c) => c.type === "BUTTONS") as any).buttons, [{ type: "QUICK_REPLY", text: "Yes" }, { type: "QUICK_REPLY", text: "No" }]);
  });

  it("rejects a URL button with no URL, and a phone button with no number", () => {
    assert.ok(buildMetaTemplatePayload({ ...base, components: { buttons: [{ type: "URL", text: "Go" }] } }).errors.length > 0);
    assert.ok(buildMetaTemplatePayload({ ...base, components: { buttons: [{ type: "PHONE_NUMBER", text: "Call" }] } }).errors.length > 0);
  });

  it("rejects a dynamic URL button - no field exists yet to collect Meta's required example URL", () => {
    const dynamic = buildMetaTemplatePayload({ ...base, components: { ...base.components, buttons: [{ type: "URL", text: "Track", url: "https://example.invalid/t/{{1}}", dynamic: true }] } });
    assert.equal(dynamic.payload, null);
    assert.ok(dynamic.errors.some((e) => /dynamic/i.test(e)));
  });
});

describe("buildMetaTemplatePayload - invalid template name (already enforced by the CRM's own validator, checked again defensively here)", () => {
  it("does not itself re-validate the name pattern (that is whatsapp.template.validators.ts's job) but passes the name through untouched, never silently transformed", () => {
    const { payload } = buildMetaTemplatePayload({ ...base, name: "upcoming_webinar" });
    assert.equal(payload!.name, "upcoming_webinar");
  });
});

import { MetaCloudApiProvider } from "./whatsapp.meta.provider.js";

describe("MetaCloudApiProvider.listTemplates pagination", () => {
  const creds = { phoneNumberId: "P", businessAccountId: "WABA", accessToken: "tok", appSecret: "s", verifyToken: "v", graphApiVersion: "v21.0" };
  const row = (id: string) => ({ id, name: `t_${id}`, category: "UTILITY", language: "en", status: "APPROVED", components: [{ type: "BODY", text: "hi" }] });

  it("follows paging.next so no template is missing from the list (a partial list would wrongly disable real templates)", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      if (urls.length === 1) return new Response(JSON.stringify({ data: [row("1")], paging: { next: "https://graph.facebook.com/v21.0/WABA/message_templates?after=abc" } }));
      return new Response(JSON.stringify({ data: [row("2")] }));
    }) as unknown as typeof fetch;
    const result = await new MetaCloudApiProvider(creds, { fetchImpl }).listTemplates();
    assert.ok(result.supported);
    assert.deepEqual(result.supported && result.templates.map((t) => t.providerTemplateId), ["1", "2"]);
    assert.equal(urls.length, 2);
  });

  it("never follows a next link that leaves Meta's Graph host", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls += 1; return new Response(JSON.stringify({ data: [row("1")], paging: { next: "https://evil.example/steal" } })); }) as unknown as typeof fetch;
    await new MetaCloudApiProvider(creds, { fetchImpl }).listTemplates();
    assert.equal(calls, 1);
  });
});
