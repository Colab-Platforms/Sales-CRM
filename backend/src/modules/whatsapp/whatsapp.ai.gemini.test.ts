import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "@google/genai";
import { DEFAULT_GEMINI_MODEL, GeminiAIProvider, type GeminiClientLike } from "./whatsapp.ai.gemini.provider.js";
import { getAIProvider } from "./whatsapp.ai.factory.js";
import { buildOrderContextText, ORDER_AGENT_SYSTEM_PROMPT, OrderExtractionError, type ExtractOrderInfoInput } from "./whatsapp.ai.provider.js";

// Every test uses a fake Gemini client - no network and no real GEMINI_API_KEY anywhere.

const SECRET_KEY = "AIzaSy-super-secret-test-key-123";

const INPUT: ExtractOrderInfoInput = {
  history: [{ direction: "OUTBOUND", text: "Hi! What would you like to order?" }],
  currentDraft: null,
  currentState: "DISCOVERY",
  catalog: [{ id: "p1", name: "Immunity Booster", basePrice: "499.00", variants: [{ id: "v1", name: "500ml", price: "499.00" }] }],
  newMessageText: "2 immunity booster bhej do",
};

const validResponse = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ confidence: 0.9, customerWantsHuman: false, unsupportedRequest: false, customerConfirmed: false, suggestedReply: "Sure! Please share your name and address.", ...overrides });

function fakeClient(respond: (params: any) => Promise<{ text?: string }>): GeminiClientLike & { calls: any[] } {
  const calls: any[] = [];
  return { calls, models: { generateContent: async (params) => { calls.push(params); return respond(params); } } };
}

async function rejectsWithCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (err: unknown) => err instanceof OrderExtractionError && err.code === code);
}

describe("GeminiAIProvider - setup", () => {
  it("initializes with a key, identifies as gemini, and defaults to a Flash-Lite model", async () => {
    const client = fakeClient(async () => ({ text: validResponse() }));
    const provider = new GeminiAIProvider({ apiKey: "k", client });
    assert.equal(provider.name, "gemini");
    await provider.extractOrderInfo(INPUT);
    assert.equal(client.calls[0].model, DEFAULT_GEMINI_MODEL);
    assert.match(DEFAULT_GEMINI_MODEL, /flash-lite/);
  });

  it("uses GEMINI_MODEL-style overrides", async () => {
    const client = fakeClient(async () => ({ text: validResponse() }));
    await new GeminiAIProvider({ apiKey: "k", model: "gemini-custom", client }).extractOrderInfo(INPUT);
    assert.equal(client.calls[0].model, "gemini-custom");
  });

  it("refuses to construct without an API key (no client, no network attempt)", () => {
    assert.throws(() => new GeminiAIProvider({ apiKey: "  " }), (err: unknown) => err instanceof OrderExtractionError && err.code === "NOT_CONFIGURED");
  });
});

describe("GeminiAIProvider - structured output", () => {
  it("requests JSON-schema-constrained output with the backend's system prompt", async () => {
    const client = fakeClient(async () => ({ text: validResponse() }));
    await new GeminiAIProvider({ apiKey: "k", client }).extractOrderInfo(INPUT);
    const { config, contents } = client.calls[0];
    assert.equal(config.responseMimeType, "application/json");
    assert.equal(config.systemInstruction, ORDER_AGENT_SYSTEM_PROMPT);
    assert.ok(config.responseJsonSchema.properties.suggestedReply);
    assert.equal("$schema" in config.responseJsonSchema, false);
    assert.match(contents, /Immunity Booster/);
    assert.match(contents, /2 immunity booster bhej do/);
  });

  it("parses a structured ORDER response: product, quantity and payment method", async () => {
    const client = fakeClient(async () => ({ text: validResponse({ productMention: "Immunity Booster", quantity: 2, paymentMethod: "COD" }) }));
    const result = await new GeminiAIProvider({ apiKey: "k", client }).extractOrderInfo(INPUT);
    assert.equal(result.productMention, "Immunity Booster");
    assert.equal(result.quantity, 2);
    assert.equal(result.paymentMethod, "COD");
  });

  it("parses customer details and treats explicit nulls as absent", async () => {
    const client = fakeClient(async () => ({
      text: validResponse({ customerName: "Ravi Kumar", phone: "9876543210", addressLine: "12 MG Road", city: "Mumbai", state: "MH", pincode: "400053", productMention: null, quantity: null, paymentMethod: null }),
    }));
    const result = await new GeminiAIProvider({ apiKey: "k", client }).extractOrderInfo(INPUT);
    assert.equal(result.customerName, "Ravi Kumar");
    assert.equal(result.pincode, "400053");
    assert.equal(result.productMention, undefined);
    assert.equal(result.quantity, undefined);
  });

  it("detects a human-handoff request and an explicit confirmation", async () => {
    const handoff = fakeClient(async () => ({ text: validResponse({ customerWantsHuman: true }) }));
    assert.equal((await new GeminiAIProvider({ apiKey: "k", client: handoff }).extractOrderInfo(INPUT)).customerWantsHuman, true);
    const confirmed = fakeClient(async () => ({ text: validResponse({ customerConfirmed: true }) }));
    assert.equal((await new GeminiAIProvider({ apiKey: "k", client: confirmed }).extractOrderInfo(INPUT)).customerConfirmed, true);
  });

  it("rejects malformed, empty, and schema-invalid output as INVALID_RESPONSE", async () => {
    const make = (text?: string) => new GeminiAIProvider({ apiKey: "k", client: fakeClient(async () => ({ text })) }).extractOrderInfo(INPUT);
    await rejectsWithCode(make("not json at all"), "INVALID_RESPONSE");
    await rejectsWithCode(make(""), "INVALID_RESPONSE");
    await rejectsWithCode(make(undefined), "INVALID_RESPONSE");
    await rejectsWithCode(make(validResponse({ confidence: 7 })), "INVALID_RESPONSE");
    await rejectsWithCode(make(validResponse({ quantity: -3 })), "INVALID_RESPONSE");
    await rejectsWithCode(make(JSON.stringify({ suggestedReply: "missing required fields" })), "INVALID_RESPONSE");
  });
});

describe("GeminiAIProvider - failures are classified and never leak credentials", () => {
  const failing = (error: unknown) => new GeminiAIProvider({ apiKey: SECRET_KEY, client: fakeClient(async () => { throw error; }) }).extractOrderInfo(INPUT);

  it("maps rate limit, auth, invalid-key-as-400, timeout and generic failures to codes", async () => {
    await rejectsWithCode(failing(new ApiError({ message: "quota", status: 429 })), "RATE_LIMIT");
    await rejectsWithCode(failing(new ApiError({ message: "denied", status: 403 })), "AUTH");
    await rejectsWithCode(failing(new ApiError({ message: "API key not valid. Please pass a valid API key.", status: 400 })), "AUTH");
    await rejectsWithCode(failing(Object.assign(new Error("aborted"), { name: "TimeoutError" })), "TIMEOUT");
    await rejectsWithCode(failing(new ApiError({ message: "boom", status: 500 })), "PROVIDER_ERROR");
    await rejectsWithCode(failing(new Error("ECONNRESET")), "PROVIDER_ERROR");
  });

  it("the API key never appears in the thrown error, its serialization, or any log line", async () => {
    const logged: string[] = [];
    const spy = mock.method(console, "error", (...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    try {
      const echoing = new ApiError({ message: `API key not valid: ${SECRET_KEY}`, status: 400 });
      const error = await failing(echoing).then(() => null, (e: unknown) => e as OrderExtractionError);
      assert.ok(error);
      for (const surface of [error!.message, String(error), JSON.stringify(error), error!.stack ?? "", ...logged]) {
        assert.equal(surface.includes(SECRET_KEY), false);
      }
      assert.ok(logged.length > 0, "the failure was logged, just safely");
    } finally {
      spy.mock.restore();
    }
  });
});

describe("Prompt and request context", () => {
  it("instructs the model never to invent products/prices, never to claim an order is placed, and to hand off on request", () => {
    assert.match(ORDER_AGENT_SYSTEM_PROMPT, /Never invent or alter a product, price, SKU/);
    assert.match(ORDER_AGENT_SYSTEM_PROMPT, /Never say an order is placed/);
    assert.match(ORDER_AGENT_SYSTEM_PROMPT, /customerWantsHuman=true/);
    assert.match(ORDER_AGENT_SYSTEM_PROMPT, /Hinglish/);
    assert.match(ORDER_AGENT_SYSTEM_PROMPT, /untrusted/);
  });

  it("the request context carries catalog data from the backend and no credential-like text", () => {
    const text = buildOrderContextText(INPUT);
    assert.match(text, /Immunity Booster \(base price 499.00\)/);
    for (const forbidden of ["apikey", "api_key", "secret", "password", "GEMINI"]) assert.equal(text.toLowerCase().includes(forbidden.toLowerCase()), false);
  });
});

describe("getAIProvider (factory)", () => {
  it("selects Gemini for AI_PROVIDER=gemini with a key, honouring GEMINI_MODEL", () => {
    const provider = getAIProvider({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k", GEMINI_MODEL: "gemini-x" });
    assert.equal(provider?.name, "gemini");
  });

  it("defaults to Gemini when AI_PROVIDER is unset (Anthropic is not an option)", () => {
    assert.equal(getAIProvider({ GEMINI_API_KEY: "k" })?.name, "gemini");
    assert.equal(getAIProvider({ AI_PROVIDER: "anthropic", GEMINI_API_KEY: "k" }), null);
  });

  it("is disabled (null) for AI_PROVIDER=none, a missing key, or an unknown provider", () => {
    assert.equal(getAIProvider({ AI_PROVIDER: "none", GEMINI_API_KEY: "k" }), null);
    assert.equal(getAIProvider({ AI_PROVIDER: "gemini" }), null);
    assert.equal(getAIProvider({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "   " }), null);
    assert.equal(getAIProvider({ AI_PROVIDER: "something-else", GEMINI_API_KEY: "k" }), null);
  });
});

describe("AIProvider boundary", () => {
  it("exposes only extraction - there is no order-creation capability on a provider", () => {
    const provider = new GeminiAIProvider({ apiKey: "k", client: fakeClient(async () => ({ text: validResponse() })) });
    const surface = [...Object.getOwnPropertyNames(Object.getPrototypeOf(provider)), ...Object.keys(provider)].filter((n) => n !== "constructor");
    assert.deepEqual(surface.sort(), ["client", "extractOrderInfo", "model", "name"]);
  });
});
