// Shared constants/helpers for the WhatsApp template builder (New/Edit template dialog). Kept in one place so the
// form and its live preview never disagree about limits or variable extraction.
import type { TemplateButtonType, TemplateHeaderType } from "./api-client/types/whatsapp-templates.types";

export const NAME_PATTERN = /^[a-z0-9_]*$/;

// Meta's own three template categories - the only ones this builder offers, never invented ones.
export const CATEGORY_OPTIONS = ["UTILITY", "MARKETING", "AUTHENTICATION"] as const;

// A practical subset of WhatsApp's own supported template languages - human labels shown, canonical codes stored.
export const LANGUAGE_OPTIONS: { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "en_US", label: "English (US)" },
  { code: "en_GB", label: "English (UK)" },
  { code: "hi", label: "Hindi" },
  { code: "kn", label: "Kannada" },
  { code: "ta", label: "Tamil" },
  { code: "te", label: "Telugu" },
  { code: "mr", label: "Marathi" },
  { code: "bn", label: "Bengali" },
  { code: "gu", label: "Gujarati" },
  { code: "ml", label: "Malayalam" },
  { code: "pa", label: "Punjabi" },
  { code: "ar", label: "Arabic" },
  { code: "es", label: "Spanish" },
];

export const HEADER_TYPE_OPTIONS: { value: TemplateHeaderType; label: string }[] = [
  { value: "TEXT", label: "Text" },
  { value: "IMAGE", label: "Image" },
  { value: "VIDEO", label: "Video" },
  { value: "DOCUMENT", label: "Document" },
];

export const BUTTON_TYPE_OPTIONS: { value: TemplateButtonType; label: string }[] = [
  { value: "QUICK_REPLY", label: "Quick reply" },
  { value: "URL", label: "Website URL" },
  { value: "PHONE_NUMBER", label: "Phone number" },
];

export const BODY_MAX = 1024; // WhatsApp's own template body limit
export const HEADER_TEXT_MAX = 60;
export const FOOTER_MAX = 60;
export const BUTTON_TEXT_MAX = 25;
export const MAX_BUTTONS = 3;

// Same {{name}} rule the backend enforces (whatsapp.template.variables.ts) - checked here only for instant
// feedback; the server is still the source of truth for what actually gets saved.
const VARIABLE_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;
export function extractVariables(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(VARIABLE_PATTERN)) {
    const name = match[1];
    if (name && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) seen.add(name);
  }
  return [...seen];
}

/** A button "kind" for the quick-reply-vs-CTA mutual-exclusion rule Meta enforces. */
export function buttonKind(type: TemplateButtonType): "QUICK_REPLY" | "CTA" {
  return type === "QUICK_REPLY" ? "QUICK_REPLY" : "CTA";
}

/** Renders WhatsApp's own lightweight markup (*bold*, _italic_, ~strikethrough~) to safe HTML for the live
 *  preview only - text is escaped first, so nothing here is ever interpreted as real markup/HTML. */
export function renderWhatsAppFormatting(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped
    .replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>")
    .replace(/_([^_\n]+)_/g, "<em>$1</em>")
    .replace(/~([^~\n]+)~/g, "<del>$1</del>")
    .replace(/\n/g, "<br />");
}

/** Substitutes {{name}} with its example value (or a bracketed placeholder) for the live preview. */
export function substituteExamples(body: string, examples: Record<string, string>): string {
  return body.replace(VARIABLE_PATTERN, (_match, name: string) => examples[name]?.trim() || `[${name}]`);
}
