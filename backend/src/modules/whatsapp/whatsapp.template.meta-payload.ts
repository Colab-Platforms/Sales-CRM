// Converts the CRM's own template representation (name/category/language/body/variables/components) into the exact
// request body Meta's Message Templates API requires - confirmed against Meta's current published contract
// (POST /{WABA_ID}/message_templates): named parameters (parameter_format: "named"), body examples as
// body_text_named_params, HEADER/FOOTER/BUTTONS component shapes, category values lowercased.
//
// This is a pure function: no network call, no DB. All Meta-specific rules that would otherwise fail a real
// submission (a variable with no example, a header type this builder does not yet support submitting, a dynamic
// URL button with no example) are caught here and returned as `errors`, so a rejection is a clear 400 - never a
// confusing Meta API error surfaced raw, and never a submission attempt Meta itself would definitely reject.
import type { TemplateButton, TemplateComponents } from "./whatsapp.template.types.js";

export interface MetaTemplateSource {
  name: string;
  category: string | null;
  language: string;
  body: string;
  variables: string[];
  components: TemplateComponents | null;
}

export interface MetaTemplatePayload {
  name: string;
  category: string;
  language: string;
  parameter_format: "named";
  components: Record<string, unknown>[];
}

export interface MetaPayloadResult {
  payload: MetaTemplatePayload | null;
  errors: string[];
}

const META_CATEGORIES = new Set(["UTILITY", "MARKETING", "AUTHENTICATION"]);

/** Media headers need a Meta-issued asset handle from the Resumable Upload API, not a plain URL - this builder does
 *  not implement that upload flow yet, so IMAGE/VIDEO/DOCUMENT headers are refused here rather than silently
 *  submitted as something Meta would reject anyway (or worse, silently dropped). TEXT and no header are safe today. */
const UNSUPPORTED_HEADER_TYPES = new Set(["IMAGE", "VIDEO", "DOCUMENT"]);

export function buildMetaTemplatePayload(source: MetaTemplateSource): MetaPayloadResult {
  const errors: string[] = [];

  if (!source.category || !META_CATEGORIES.has(source.category)) {
    errors.push("Category must be UTILITY, MARKETING or AUTHENTICATION before submitting to Meta.");
  }
  if (!source.language.trim()) {
    errors.push("Language is required before submitting to Meta.");
  }
  if (!source.body.trim()) {
    errors.push("Body is required before submitting to Meta.");
  }

  const examples = source.components?.bodyExamples ?? {};
  const missingExamples = source.variables.filter((v) => !examples[v]?.trim());
  if (missingExamples.length > 0) {
    errors.push(`Every variable needs an example value before submitting to Meta - missing: ${missingExamples.map((v) => `{{${v}}}`).join(", ")}.`);
  }
  const staleExamples = Object.keys(examples).filter((k) => !source.variables.includes(k));
  if (staleExamples.length > 0) {
    errors.push(`These example values refer to variables no longer in the body: ${staleExamples.map((v) => `{{${v}}}`).join(", ")}.`);
  }

  const components: Record<string, unknown>[] = [];

  const header = source.components?.header;
  if (header) {
    if (UNSUPPORTED_HEADER_TYPES.has(header.type)) {
      errors.push(`A ${header.type} header cannot be submitted to Meta yet - this builder only supports a TEXT header or no header at all. Use NONE or TEXT, or create this template's media header directly in Meta's own console.`);
    } else if (header.type === "TEXT") {
      if (!header.text?.trim()) errors.push("Header text is empty.");
      else components.push({ type: "HEADER", format: "TEXT", text: header.text });
    }
  }

  components.push({
    type: "BODY",
    text: source.body,
    ...(source.variables.length > 0 ? { example: { body_text_named_params: source.variables.map((name) => ({ param_name: name, example: examples[name] ?? "" })) } } : {}),
  });

  if (source.components?.footer?.trim()) {
    components.push({ type: "FOOTER", text: source.components.footer });
  }

  const buttons = source.components?.buttons ?? [];
  if (buttons.length > 0) {
    const built: Record<string, unknown>[] = [];
    for (const b of buttons) {
      const built1 = buildButton(b, errors);
      if (built1) built.push(built1);
    }
    if (built.length > 0) components.push({ type: "BUTTONS", buttons: built });
  }

  if (errors.length > 0) return { payload: null, errors };

  return {
    payload: {
      name: source.name,
      category: source.category!.toLowerCase(),
      language: source.language,
      parameter_format: "named",
      components,
    },
    errors: [],
  };
}

function buildButton(b: TemplateButton, errors: string[]): Record<string, unknown> | null {
  if (b.type === "QUICK_REPLY") return { type: "QUICK_REPLY", text: b.text };
  if (b.type === "PHONE_NUMBER") {
    if (!b.phoneNumber?.trim()) {
      errors.push(`Button "${b.text}" needs a phone number before submitting to Meta.`);
      return null;
    }
    return { type: "PHONE_NUMBER", text: b.text, phone_number: b.phoneNumber };
  }
  // URL
  if (!b.url?.trim()) {
    errors.push(`Button "${b.text}" needs a URL before submitting to Meta.`);
    return null;
  }
  if (b.url.includes("{{") || b.dynamic) {
    // A dynamic URL needs its own example URL (Meta's `example: ["https://example.com/actual-value"]`), which this
    // builder has no field to collect yet - refused rather than submitted with a guessed/empty example.
    errors.push(`Button "${b.text}"'s URL looks dynamic ({{...}} or marked dynamic) - this builder does not yet collect the required example URL for a dynamic button. Use a static URL instead.`);
    return null;
  }
  return { type: "URL", text: b.text, url: b.url };
}
