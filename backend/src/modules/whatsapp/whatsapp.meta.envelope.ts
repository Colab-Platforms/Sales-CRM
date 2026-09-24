// Shared parsing for the Meta WhatsApp Cloud API webhook envelope
// (entry[].changes[].value.{messages[],statuses[]}) - a stable, publicly documented format used
// both by a real Meta Cloud API delivery (whatsapp.meta.provider.ts) and by AiSensy's "Direct API"
// line, which proxies that exact same shape (whatsapp.aisensy.provider.ts). Extracted here so
// neither provider owns a second copy.

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function metaCloudApiMessages(payload: unknown): unknown[] {
  if (!isObject(payload)) return [];
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  const out: unknown[] = [];
  for (const entry of entries) {
    if (!isObject(entry)) continue;
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      if (!isObject(change) || !isObject(change.value)) continue;
      out.push(change.value);
    }
  }
  return out;
}
