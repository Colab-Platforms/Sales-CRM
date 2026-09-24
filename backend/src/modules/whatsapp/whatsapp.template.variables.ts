// Extracts and validates the named placeholders in a template body, e.g. "Hi {{customer_name}},
// your order {{order_number}} is on its way." Never executes anything - a placeholder is just a
// name pulled out with a regex; E7.3's sender is responsible for substituting real values (and
// for mapping these named placeholders onto whatever positional {{1}}/{{2}} syntax a provider's
// actual approved template actually uses).

const VALID_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
// Matches {{ name }} (whitespace around the name is allowed), and separately catches anything
// brace-shaped so malformed cases can be reported instead of silently ignored.
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

export interface VariableExtractionResult {
  /** Ordered by first appearance in the body, de-duplicated. */
  variables: string[];
  errors: string[];
}

export function extractTemplateVariables(body: string): VariableExtractionResult {
  const errors: string[] = [];
  const seen = new Set<string>();
  const variables: string[] = [];

  // Unbalanced braces: more opens than closes or vice versa, outside of matched pairs.
  const opens = (body.match(/\{\{/g) ?? []).length;
  const closes = (body.match(/\}\}/g) ?? []).length;
  if (opens !== closes) errors.push("Template body has an unclosed or unmatched {{ }} placeholder.");

  for (const match of body.matchAll(PLACEHOLDER)) {
    const raw = match[1];
    if (!raw) {
      errors.push("Template body has an empty placeholder: {{}}.");
      continue;
    }
    if (!VALID_NAME.test(raw)) {
      errors.push(`"{{${raw}}}" is not a valid placeholder name - use letters, numbers and underscores, starting with a letter or underscore.`);
      continue;
    }
    if (!seen.has(raw)) {
      seen.add(raw);
      variables.push(raw);
    }
  }

  return { variables, errors };
}

/** True if every name in `provided` is a real placeholder in the template, and every placeholder has a value - for E7.3's sender to reuse. */
export function validateVariableValues(templateVariables: string[], provided: Record<string, string>): string[] {
  const errors: string[] = [];
  const missing = templateVariables.filter((v) => !(v in provided) || provided[v].trim() === "");
  if (missing.length > 0) errors.push(`Missing a value for: ${missing.join(", ")}`);
  const unknown = Object.keys(provided).filter((k) => !templateVariables.includes(k));
  if (unknown.length > 0) errors.push(`Not a placeholder in this template: ${unknown.join(", ")}`);
  return errors;
}

/**
 * E7.3: substitutes every {{name}} in body with values[name], using the exact same placeholder
 * syntax extractTemplateVariables recognises - never a template engine, never executes anything.
 * Only ever called after every extracted variable already has a resolved value (whatsapp.variable-
 * resolver.ts's job), so a name missing from `values` here would be a caller bug; it is still
 * handled safely by leaving that one placeholder untouched rather than throwing.
 */
export function renderTemplateBody(body: string, values: Record<string, string>): string {
  return body.replace(PLACEHOLDER, (match, rawName: string) => (rawName in values ? values[rawName] : match));
}
