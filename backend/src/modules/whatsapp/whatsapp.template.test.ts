import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AiSensyProvider } from "./whatsapp.aisensy.provider.js";
import { resolveWhatsAppConfig } from "./whatsapp.config.js";
import { GupshupProvider } from "./whatsapp.gupshup.provider.js";
import { extractTemplateVariables, validateVariableValues } from "./whatsapp.template.variables.js";

const jsonResponse = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// ==== Variable extraction/validation ====

describe("extractTemplateVariables", () => {
  it("extracts named placeholders in order of first appearance, de-duplicated", () => {
    const { variables, errors } = extractTemplateVariables("Hi {{customer_name}}, order {{order_number}} for {{customer_name}} is ready.");
    assert.deepEqual(variables, ["customer_name", "order_number"]);
    assert.deepEqual(errors, []);
  });

  it("is not limited to any fixed set of variable names", () => {
    const { variables, errors } = extractTemplateVariables("{{tracking_number}} {{delivery_partner}} {{eta_hours}}");
    assert.deepEqual(variables, ["tracking_number", "delivery_partner", "eta_hours"]);
    assert.deepEqual(errors, []);
  });

  it("tolerates whitespace inside braces", () => {
    const { variables } = extractTemplateVariables("Hello {{ customer_name }}!");
    assert.deepEqual(variables, ["customer_name"]);
  });

  it("has no placeholders in plain text", () => {
    const { variables, errors } = extractTemplateVariables("Thank you for your order.");
    assert.deepEqual(variables, []);
    assert.deepEqual(errors, []);
  });

  it("flags an empty placeholder", () => {
    const { errors } = extractTemplateVariables("Hello {{}}!");
    assert.ok(errors.some((e) => /empty placeholder/.test(e)));
  });

  it("flags an invalid placeholder name (not a valid identifier)", () => {
    const { errors } = extractTemplateVariables("Hi {{customer name}} and {{1bad}} and {{order-number}}");
    assert.equal(errors.length, 3);
  });

  it("flags unbalanced braces", () => {
    const { errors } = extractTemplateVariables("Hi {{customer_name}, your order is ready");
    assert.ok(errors.some((e) => /unclosed or unmatched/.test(e)));
  });

  it("never executes anything - a placeholder is only ever a name, no matter what it contains", () => {
    const { variables, errors } = extractTemplateVariables("{{require('fs')}}");
    // Not a valid identifier, so it is reported as invalid, not evaluated.
    assert.deepEqual(variables, []);
    assert.ok(errors.length > 0);
  });
});

describe("validateVariableValues", () => {
  it("reports a missing value and an unknown key", () => {
    const errors = validateVariableValues(["customer_name", "order_number"], { customer_name: "Priya" });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /order_number/);
  });

  it("passes when every placeholder has a non-empty value and nothing extra is given", () => {
    const errors = validateVariableValues(["customer_name"], { customer_name: "Priya" });
    assert.deepEqual(errors, []);
  });

  it("treats a blank value the same as a missing one", () => {
    const errors = validateVariableValues(["customer_name"], { customer_name: "   " });
    assert.match(errors[0], /customer_name/);
  });
});

// ==== AiSensy: template listing is genuinely unsupported ====

describe("AiSensyProvider.listTemplates", () => {
  it("reports unsupported with a clear reason, never fake templates", async () => {
    const r = resolveWhatsAppConfig({ WHATSAPP_PROVIDER: "AISENSY", AISENSY_API_KEY: "k", AISENSY_SOURCE_NUMBER: "91", AISENSY_WEBHOOK_SECRET: "s" });
    if (!r.ok || r.config.kind !== "AISENSY") throw new Error("bad setup");
    const provider = new AiSensyProvider(r.config);
    const result = await provider.listTemplates();
    assert.equal(result.supported, false);
    if (!result.supported) assert.match(result.reason, /does not provide an endpoint/);
  });
});

// ==== Gupshup: real 3-step Partner API flow, gated on its own optional config ====

const gupshupBaseConfig = (templateSync: { appId: string; partnerEmail: string; partnerPassword: string } | null) => {
  const r = resolveWhatsAppConfig({ WHATSAPP_PROVIDER: "GUPSHUP", GUPSHUP_API_KEY: "k", GUPSHUP_APP_NAME: "App", GUPSHUP_SOURCE_NUMBER: "91", GUPSHUP_WEBHOOK_TOKEN: "t" });
  if (!r.ok || r.config.kind !== "GUPSHUP") throw new Error("bad setup");
  return { ...r.config, templateSync };
};

describe("GupshupProvider.listTemplates", () => {
  it("reports unsupported (not configured for template sync) when the Partner API credentials are absent", async () => {
    const provider = new GupshupProvider(gupshupBaseConfig(null));
    const result = await provider.listTemplates();
    assert.equal(result.supported, false);
    if (!result.supported) assert.match(result.reason, /Partner API credentials/);
  });

  it("performs the documented 3-step flow and normalizes the response", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url) === "https://partner.gupshup.io/partner/account/login") {
        const form = new URLSearchParams(init!.body as string);
        assert.equal(form.get("email"), "partner@example.invalid");
        assert.equal(form.get("password"), "s3cret");
        return jsonResponse(200, { token: "partner-token-abc" });
      }
      if (String(url) === "https://partner.gupshup.io/partner/app/app-123/token") {
        assert.equal((init!.headers as Record<string, string>).Authorization, "partner-token-abc");
        return jsonResponse(200, { status: "success", token: { token: "app-token-xyz" } });
      }
      if (String(url) === "https://partner.gupshup.io/partner/app/app-123/templates") {
        assert.equal((init!.headers as Record<string, string>).Authorization, "app-token-xyz");
        return jsonResponse(200, {
          status: "success",
          templates: [
            { id: "tmpl-1", elementName: "order_update", externalId: "meta-1", category: "UTILITY", languageCode: "en", data: "Your order {{1}} has shipped", status: "APPROVED", quality: "HIGH" },
            { id: "tmpl-2", elementName: "promo_offer", externalId: null, category: "MARKETING", languageCode: "en", data: "Special offer!", status: "PENDING", quality: "UNKNOWN" },
            { id: "tmpl-3", elementName: "old_promo", externalId: null, category: "MARKETING", languageCode: "en", data: "Old", status: "PAUSED", quality: "LOW" },
            { notATemplate: true },
          ],
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const provider = new GupshupProvider(gupshupBaseConfig({ appId: "app-123", partnerEmail: "partner@example.invalid", partnerPassword: "s3cret" }), { fetchImpl });
    const result = await provider.listTemplates();

    assert.equal(calls.length, 3);
    assert.equal(result.supported, true);
    if (!result.supported) return;
    assert.equal(result.templates.length, 3, "the malformed row is skipped, not guessed at");
    assert.deepEqual(result.templates[0], { providerTemplateId: "tmpl-1", externalId: "meta-1", name: "order_update", category: "UTILITY", language: "en", body: "Your order {{1}} has shipped", status: "APPROVED", quality: "HIGH" });
    assert.equal(result.templates[1].status, "PENDING");
    assert.equal(result.templates[2].status, "DISABLED", "an unrecognised provider status (PAUSED) is never treated as usable");
  });

  it("surfaces a clean error if the partner login itself fails, without leaking the password", async () => {
    const fetchImpl = (async () => jsonResponse(401, { message: "invalid credentials" })) as typeof fetch;
    const provider = new GupshupProvider(gupshupBaseConfig({ appId: "app-123", partnerEmail: "partner@example.invalid", partnerPassword: "wrong" }), { fetchImpl });
    await assert.rejects(() => provider.listTemplates(), (e: Error) => {
      assert.equal(e.message.includes("wrong"), false);
      return true;
    });
  });
});
