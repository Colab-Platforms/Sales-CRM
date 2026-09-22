// Config for AiSensy's "Project Webhook" feature (contact.created, message.created,
// message.status.updated, campaign/chat/payment/order/lead-form topics - see
// whatsapp.aisensy.webhook.events.ts). This is a DIFFERENT AiSensy product surface from the
// Direct/Campaign webhook whatsapp.config.ts's AiSensyConfig already covers (that one signs
// deliveries with X-AiSensy-Signature + AISENSY_WEBHOOK_SECRET, confirmed in whatsapp.hmac.ts) -
// the Project Webhook is tied to the Project API credentials already in .env
// (WHATSAPP_AI_SENSY_PROJECT_ID / WHATSAPP_AI_SENSY_PROJECT_API_KEY), not to WHATSAPP_PROVIDER, so
// this module never reads or gates on that.
//
// AiSensy's own Project API docs (https://aisensy.stoplight.io/docs/project-api/...) document the
// shape of a webhook SUBSCRIPTION record (id/app_id/project_id/topics/webhook_url/shared_secret/...)
// but - as far as could be retrieved for this task - do not document how an individual DELIVERY to
// webhook_url is authenticated (no header name/algorithm is specified anywhere reachable). This
// module therefore does NOT implement a fabricated "AiSensy signature" check. AISENSY_PROJECT_WEBHOOK_TOKEN
// is a plain, CRM-chosen safeguard, never claimed to be an AiSensy mechanism: append
// `?token=<same value>` to the Endpoint URL you register in the AiSensy dashboard, and this endpoint
// requires the query param to match. Leave it unset to accept every delivery unauthenticated (still
// safer than nothing, since no CRM data is written from an unmapped topic - see the handler).

type Env = Record<string, string | undefined>;

export interface AiSensyProjectWebhookConfig {
  /** null = no token configured; every delivery is accepted without any request-origin check. */
  readonly token: string | null;
}

export function loadAiSensyProjectWebhookConfig(env: Env = process.env): AiSensyProjectWebhookConfig {
  const token = (env.AISENSY_PROJECT_WEBHOOK_TOKEN ?? "").trim();
  return { token: token || null };
}
