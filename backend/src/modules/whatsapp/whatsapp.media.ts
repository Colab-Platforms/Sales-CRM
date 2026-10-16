import type { Prisma } from "../../../generated/prisma/client.js";
import { ActivityType } from "../../../generated/prisma/enums.js";
import { metaCloudApiMessages } from "./whatsapp.meta.envelope.js";

// Inbound WhatsApp media (a customer's payment screenshot, a document, a voice note...).
//
// What is stored: only DESCRIPTORS - the provider's media id, MIME type, file name, checksum - on the Activity row that is written, in the same transaction, with every inbound message
// (so a duplicate webhook skips both together, and no new table or migration is needed). The BYTES are never copied into the CRM: they are fetched from the provider on demand through
// an authenticated route, because the URL Meta hands out expires within minutes and needs the access token. Nothing here is a payment signal: a screenshot never changes an order's
// payment status - that only ever comes from verified payment-provider data.

export const MEDIA_KINDS = ["image", "video", "audio", "document", "sticker"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export interface InboundMedia {
  kind: MediaKind;
  providerMediaId: string;
  mimeType: string | null;
  filename: string | null;
  sha256: string | null;
  /** The text the customer typed with the file, if any. Stored as the message body, not here; kept on the parsed value so the processor can use it. */
  caption: string | null;
}

/** What the API shows the browser: never the provider's media id or any URL - only enough to render a preview or a fallback. */
export interface MessageMediaInfo {
  kind: MediaKind | "unknown";
  mimeType: string | null;
  filename: string | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 255): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null);
/** Meta media ids are opaque but plain tokens; anything else is not an id this CRM will ever send back to the Graph API. */
const SAFE_MEDIA_ID = /^[0-9A-Za-z_-]{1,100}$/;

/** Reads the media object of a Meta Cloud API message (`message.image`, `.document`, ...). Null when the type is not media, or the id the file would be fetched by is missing. */
export function parseMetaMedia(message: Record<string, unknown>): InboundMedia | null {
  const kind = typeof message.type === "string" ? (MEDIA_KINDS as readonly string[]).find((k) => k === message.type) : undefined;
  if (!kind) return null;
  const node = message[kind];
  if (!isObject(node)) return null;
  const id = str(node.id, 100);
  if (!id || !SAFE_MEDIA_ID.test(id)) return null;
  return {
    kind: kind as MediaKind,
    providerMediaId: id,
    mimeType: str(node.mime_type, 100),
    filename: kind === "document" ? str(node.filename) : null,
    sha256: str(node.sha256, 128),
    caption: str(node.caption, 4000),
  };
}

export const MEDIA_METADATA_KEY = "inboundMedia";

/** The JSON stored on the inbound message's activity row. The caption is not repeated here (it is the message body). */
export function mediaActivityMetadata(media: InboundMedia): Prisma.InputJsonValue {
  return { [MEDIA_METADATA_KEY]: { kind: media.kind, mediaId: media.providerMediaId, mimeType: media.mimeType, filename: media.filename, sha256: media.sha256 } };
}

/** Defensive read of that JSON (validated on the way out, like every JSON column here). */
export function readMediaMetadata(metadata: unknown): InboundMedia | null {
  if (!isObject(metadata) || !isObject(metadata[MEDIA_METADATA_KEY])) return null;
  const m = metadata[MEDIA_METADATA_KEY] as Record<string, unknown>;
  const kind = (MEDIA_KINDS as readonly string[]).find((k) => k === m.kind);
  const id = str(m.mediaId, 100);
  if (!kind || !id || !SAFE_MEDIA_ID.test(id)) return null;
  return { kind: kind as MediaKind, providerMediaId: id, mimeType: str(m.mimeType, 100), filename: str(m.filename), sha256: str(m.sha256, 128), caption: null };
}

export function describeMedia(media: InboundMedia | null): MessageMediaInfo {
  return media ? { kind: media.kind, mimeType: media.mimeType, filename: media.filename } : { kind: "unknown", mimeType: null, filename: null };
}

type ActivityDb = Pick<Prisma.TransactionClient, "activity">;

/** Media descriptors for a page of messages in ONE query (never one per message). Keyed by message id. */
export async function loadMediaDescriptors(db: ActivityDb, messages: { id: string; leadId: string | null }[], referenceType: string): Promise<Map<string, InboundMedia>> {
  const out = new Map<string, InboundMedia>();
  if (messages.length === 0) return out;
  const leadIds = [...new Set(messages.map((m) => m.leadId).filter((id): id is string => Boolean(id)))];
  const rows = await db.activity.findMany({
    where: { type: ActivityType.WHATSAPP_MESSAGE_RECEIVED, referenceType, referenceId: { in: messages.map((m) => m.id) }, ...(leadIds.length > 0 ? { leadId: { in: leadIds } } : {}) },
    select: { referenceId: true, metadata: true },
  });
  for (const row of rows) {
    const media = readMediaMetadata(row.metadata);
    if (row.referenceId && media) out.set(row.referenceId, media);
  }
  return out;
}

type WebhookDb = Pick<Prisma.TransactionClient, "webhookEvent">;
const RECOVERY_WINDOW_MS = 10 * 60 * 1000;

/**
 * Messages recorded BEFORE media details were stored: the raw webhook delivery is still in webhook_events, so the media id can be read back from it - within a small window around the
 * time the message arrived (indexed by receive time), never a scan of the table. Null when it is not there.
 */
export async function recoverMediaFromWebhook(db: WebhookDb, providerMessageId: string, arrivedAt: Date): Promise<InboundMedia | null> {
  const rows = await db.webhookEvent.findMany({
    where: { provider: "META", receivedAt: { gte: new Date(arrivedAt.getTime() - RECOVERY_WINDOW_MS), lte: new Date(arrivedAt.getTime() + RECOVERY_WINDOW_MS) } },
    select: { payload: true },
    take: 200,
  });
  for (const row of rows) {
    for (const value of metaCloudApiMessages(row.payload)) {
      if (!isObject(value) || !Array.isArray(value.messages)) continue;
      for (const m of value.messages) {
        if (isObject(m) && m.id === providerMessageId) return parseMetaMedia(m);
      }
    }
  }
  return null;
}

// ---- Serving policy. Whatever the provider says the file is, the browser is only ever told one of these types, so an uploaded file can never run as a page. ----

const INLINE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/aac", "audio/amr", "video/mp4", "video/3gpp"]);

export interface ServedMedia {
  contentType: string;
  /** true = may be shown inside the page (an image/audio/video preview); false = download only. */
  inline: boolean;
}

export function servedContentType(mimeType: string | null | undefined): ServedMedia {
  const type = (mimeType ?? "").split(";")[0]!.trim().toLowerCase();
  return INLINE_TYPES.has(type) ? { contentType: type, inline: true } : { contentType: "application/octet-stream", inline: false };
}

/** A header-safe file name: no path parts, quotes, control characters, or newlines. */
export function safeFilename(name: string | null | undefined, fallback: string): string {
  const cleaned = (name ?? "").replace(/[\u0000-\u001f\u007f"\\/:*?<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
  return cleaned || fallback;
}

export function contentDisposition(inline: boolean, filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
