import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MetaCloudApiProvider, WhatsAppMediaError, isMetaMediaUrl } from "./whatsapp.meta.provider.js";
import { contentDisposition, describeMedia, mediaActivityMetadata, parseMetaMedia, readMediaMetadata, safeFilename, servedContentType } from "./whatsapp.media.js";

const CREDS = { phoneNumberId: "P1", businessAccountId: "B1", accessToken: "EAA-secret-token-9931", appSecret: "app-secret-4410", verifyToken: "verify-7781", graphApiVersion: "v21.0" };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const webhook = (message: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "919999900000", phone_number_id: "P1" }, messages: [{ from: "919811000001", id: "wamid.IMG1", timestamp: "1760000000", ...message }] } }] }],
});

// ------------------------------------------------------------------------------------------- parsing
test("an image message: type MEDIA, media id / MIME / checksum / caption extracted, text stays null", () => {
  const provider = new MetaCloudApiProvider(CREDS);
  const [m] = provider.parseIncomingWebhook(webhook({ type: "image", image: { id: "MEDIA-123", mime_type: "image/jpeg", sha256: "abc123", caption: "Paid via UPI, ref 8841" } }));
  assert.equal(m!.messageType, "MEDIA");
  assert.equal(m!.text, null);
  assert.deepEqual(m!.media, { kind: "image", providerMediaId: "MEDIA-123", mimeType: "image/jpeg", filename: null, sha256: "abc123", caption: "Paid via UPI, ref 8841" });
});

test("a document keeps its file name; audio and sticker are recognised; video too", () => {
  const provider = new MetaCloudApiProvider(CREDS);
  assert.equal(provider.parseIncomingWebhook(webhook({ type: "document", document: { id: "D1", mime_type: "application/pdf", filename: "receipt.pdf" } }))[0]!.media?.filename, "receipt.pdf");
  for (const kind of ["audio", "sticker", "video"]) assert.equal(provider.parseIncomingWebhook(webhook({ type: kind, [kind]: { id: `${kind}-1`, mime_type: "x/y" } }))[0]!.media?.kind, kind);
});

test("missing media metadata: the message is still recorded as MEDIA, with no media details (an honest 'cannot be shown'), never a made-up id", () => {
  const provider = new MetaCloudApiProvider(CREDS);
  for (const message of [{ type: "image" }, { type: "image", image: {} }, { type: "image", image: { mime_type: "image/png" } }, { type: "image", image: { id: "../etc/passwd" } }]) {
    const [m] = provider.parseIncomingWebhook(webhook(message));
    assert.equal(m!.messageType, "MEDIA");
    assert.equal(m!.media, null);
  }
});

test("unsupported types and text are unchanged", () => {
  const provider = new MetaCloudApiProvider(CREDS);
  const [loc] = provider.parseIncomingWebhook(webhook({ type: "location", location: { latitude: 1, longitude: 2 } }));
  assert.equal(loc!.messageType, "OTHER");
  assert.equal(loc!.media ?? null, null);
  const [text] = provider.parseIncomingWebhook(webhook({ type: "text", text: { body: "hello" } }));
  assert.deepEqual([text!.messageType, text!.text, text!.media ?? null], ["TEXT", "hello", null]);
});

test("parseMetaMedia ignores a non-media or malformed object", () => {
  assert.equal(parseMetaMedia({ type: "text", text: { body: "x" } }), null);
  assert.equal(parseMetaMedia({ type: "image", image: "not-an-object" }), null);
});

// ---------------------------------------------------------------------------------- stored metadata
test("the activity metadata round-trips, never carries the caption, and a tampered value is rejected", () => {
  const media = parseMetaMedia({ type: "document", document: { id: "D-9", mime_type: "application/pdf", filename: "slip.pdf", sha256: "ff", caption: "my slip" } })!;
  const stored = mediaActivityMetadata(media);
  assert.ok(!JSON.stringify(stored).includes("my slip"));
  const read = readMediaMetadata(stored)!;
  assert.deepEqual([read.kind, read.providerMediaId, read.mimeType, read.filename], ["document", "D-9", "application/pdf", "slip.pdf"]);
  assert.equal(readMediaMetadata({ inboundMedia: { kind: "exe", mediaId: "x" } }), null);
  assert.equal(readMediaMetadata({ inboundMedia: { kind: "image", mediaId: "a/b" } }), null);
  assert.equal(readMediaMetadata(null), null);
  assert.equal(readMediaMetadata({}), null);
});

test("what the API shows: kind, MIME and name only - never the provider media id", () => {
  const media = parseMetaMedia({ type: "image", image: { id: "SECRET-MEDIA-ID", mime_type: "image/png" } })!;
  const shown = describeMedia(media);
  assert.deepEqual(shown, { kind: "image", mimeType: "image/png", filename: null });
  assert.ok(!JSON.stringify(shown).includes("SECRET-MEDIA-ID"));
  assert.deepEqual(describeMedia(null), { kind: "unknown", mimeType: null, filename: null });
});

// -------------------------------------------------------------------------------------- serving policy
test("only a fixed set of types is shown inline; anything else (html, svg, pdf, unknown) is a download as octet-stream", () => {
  for (const ok of ["image/jpeg", "image/png", "image/webp", "audio/ogg", "video/mp4"]) assert.deepEqual(servedContentType(ok), { contentType: ok, inline: true });
  assert.deepEqual(servedContentType("image/jpeg; charset=binary"), { contentType: "image/jpeg", inline: true });
  for (const risky of ["text/html", "image/svg+xml", "application/pdf", "application/x-msdownload", "", null, undefined]) assert.deepEqual(servedContentType(risky as never), { contentType: "application/octet-stream", inline: false });
});

test("file names are header-safe", () => {
  assert.equal(safeFilename('..\\..\\evil"\r\n.pdf', "file"), ".._.._evil___.pdf");
  assert.equal(safeFilename(null, "image-ab12"), "image-ab12");
  const header = contentDisposition(false, "reçu pay.pdf");
  assert.match(header, /^attachment; filename="re_u pay\.pdf"; filename\*=UTF-8''re%C3%A7u%20pay\.pdf$/);
  assert.match(contentDisposition(true, "a.png"), /^inline;/);
});

// ------------------------------------------------------------------------------------------ the download
test("isMetaMediaUrl: only https Meta hosts; look-alikes, http and embedded credentials are refused", () => {
  for (const ok of ["https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1", "https://graph.facebook.com/v21.0/1", "https://scontent.xx.fbcdn.net/x", "https://mmg.whatsapp.net/d/f"]) assert.equal(isMetaMediaUrl(ok), true, ok);
  for (const bad of ["http://lookaside.fbsbx.com/x", "https://evil.example/x", "https://lookaside.fbsbx.com.evil.example/x", "https://user:pw@lookaside.fbsbx.com/x", "not a url", "https://facebook.com.evil.io/"]) assert.equal(isMetaMediaUrl(bad), false, bad);
});

function mediaFetch(opts: { info?: Record<string, unknown> | number; body?: Buffer; downloadStatus?: number; redirectTo?: string; contentLength?: string; failLookup?: boolean } = {}) {
  const calls: { url: string; auth: string | null }[] = [];
  const body = opts.body ?? Buffer.from("PNGDATA");
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init.headers).get("authorization") });
    if (String(url).startsWith("https://graph.facebook.com/")) {
      if (opts.failLookup) throw new Error(`socket hang up (Bearer ${CREDS.accessToken})`);
      if (typeof opts.info === "number") return new Response("{}", { status: opts.info });
      return new Response(JSON.stringify(opts.info ?? { url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1", mime_type: "image/png", sha256: sha(body), file_size: body.length }), { status: 200 });
    }
    if (opts.redirectTo && String(url).startsWith("https://lookaside")) return new Response(null, { status: 302, headers: { location: opts.redirectTo } });
    return new Response(body, { status: opts.downloadStatus ?? 200, headers: opts.contentLength ? { "content-length": opts.contentLength } : {} });
  }) as unknown as typeof fetch;
  return { provider: new MetaCloudApiProvider(CREDS, { fetchImpl }), calls };
}
const fails = async (p: Promise<unknown>, kind: string) => {
  await assert.rejects(p, (e: unknown) => e instanceof WhatsAppMediaError && e.kind === kind, `expected ${kind}`);
};

test("fetchMedia: resolves the id, downloads with the token on Meta hosts only, and verifies Meta's checksum", async () => {
  const { provider, calls } = mediaFetch();
  const out = await provider.fetchMedia("MEDIA-123");
  assert.equal(out.buffer.toString(), "PNGDATA");
  assert.equal(out.mimeType, "image/png");
  assert.equal(out.checksumVerified, true);
  assert.deepEqual(calls.map((c) => c.url.split("?")[0]), ["https://graph.facebook.com/v21.0/MEDIA-123", "https://lookaside.fbsbx.com/whatsapp_business/attachments/"]);
  assert.ok(calls.every((c) => c.auth === `Bearer ${CREDS.accessToken}`));
});

test("fetchMedia: a checksum that does not match is refused, not shown", async () => {
  const { provider } = mediaFetch({ info: { url: "https://lookaside.fbsbx.com/x", mime_type: "image/png", sha256: "0".repeat(64) } });
  await fails(provider.fetchMedia("M1"), "INTEGRITY");
});

test("fetchMedia: expired / unknown media is NOT_FOUND; other failures are UNAVAILABLE", async () => {
  await fails(mediaFetch({ info: 404 }).provider.fetchMedia("M1"), "NOT_FOUND");
  await fails(mediaFetch({ downloadStatus: 404 }).provider.fetchMedia("M1"), "NOT_FOUND");
  await fails(mediaFetch({ downloadStatus: 410 }).provider.fetchMedia("M1"), "NOT_FOUND");
  await fails(mediaFetch({ info: 401 }).provider.fetchMedia("M1"), "UNAVAILABLE");
  await fails(mediaFetch({ downloadStatus: 500 }).provider.fetchMedia("M1"), "UNAVAILABLE");
  await fails(mediaFetch().provider.fetchMedia("../etc/passwd"), "NOT_FOUND");
});

test("fetchMedia: a network failure is UNAVAILABLE and the message never contains the token", async () => {
  await assert.rejects(mediaFetch({ failLookup: true }).provider.fetchMedia("M1"), (e: unknown) => e instanceof WhatsAppMediaError && e.kind === "UNAVAILABLE" && !e.message.includes(CREDS.accessToken));
});

test("fetchMedia: a media address on a non-Meta host is never fetched, and a redirect to one is refused before the token is sent", async () => {
  const lookalike = mediaFetch({ info: { url: "https://evil.example/steal", mime_type: "image/png" } });
  await fails(lookalike.provider.fetchMedia("M1"), "UNAVAILABLE");
  assert.ok(lookalike.calls.every((c) => !c.url.includes("evil.example")), "the evil host was never contacted");

  const redirected = mediaFetch({ redirectTo: "https://evil.example/collect" });
  await fails(redirected.provider.fetchMedia("M1"), "UNAVAILABLE");
  assert.ok(redirected.calls.every((c) => !c.url.includes("evil.example")), "the token was not sent to the redirect target");
});

test("fetchMedia: a redirect to another Meta host is followed", async () => {
  const { provider, calls } = mediaFetch({ redirectTo: "https://scontent.xx.fbcdn.net/final" });
  const out = await provider.fetchMedia("M1");
  assert.equal(out.buffer.toString(), "PNGDATA");
  assert.ok(calls.some((c) => c.url.startsWith("https://scontent.xx.fbcdn.net/")));
});

test("fetchMedia: oversized files are refused, by declared length or by actual size", async () => {
  await fails(mediaFetch({ contentLength: String(50 * 1024 * 1024) }).provider.fetchMedia("M1", { maxBytes: 1024 }), "TOO_LARGE");
  await fails(mediaFetch({ body: Buffer.alloc(5000), info: { url: "https://lookaside.fbsbx.com/x", mime_type: "image/png" } }).provider.fetchMedia("M1", { maxBytes: 1024 }), "TOO_LARGE");
});
