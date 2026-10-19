// Database integration tests for inbound WhatsApp media (a customer's payment screenshot etc). Run with: npm run test:db (guarded isolated DB only)
// Providers are fakes: nothing is downloaded from Meta and nothing is sent.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import WhatsAppService from "./whatsapp.service.js";
import { WhatsAppMediaError, type FetchedMedia } from "./whatsapp.meta.provider.js";
import type { NormalizedIncomingMessage } from "./whatsapp.provider.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    }, { timeout: 60_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());

const uid = () => randomUUID();
const admin = async (tx: Prisma.TransactionClient) => {
  const u = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
  return { id: u.id, username: u.username, role: Role.ADMIN };
};
const image = (providerMessageId: string, from: string, over: Partial<NormalizedIncomingMessage> = {}): NormalizedIncomingMessage => ({
  providerMessageId, from, to: null, messageType: "MEDIA", text: null, timestamp: new Date(),
  media: { kind: "image", providerMediaId: "MEDIA-ABC", mimeType: "image/jpeg", filename: null, sha256: null, caption: "paid, UTR 8841" }, ...over,
});
const source = (result: FetchedMedia | WhatsAppMediaError | Error) => {
  const calls: string[] = [];
  return { calls, get: async () => ({ fetchMedia: async (id: string) => { calls.push(id); if (result instanceof Error) throw result; return result; } }) };
};
const png: FetchedMedia = { buffer: Buffer.from("PNG"), mimeType: "image/png", checksumVerified: true };

describe("inbound media is recorded, once, with details but never bytes or tokens", () => {
  it("records an image: MEDIA message, caption as body, descriptor on its activity; the history shows kind/MIME only", async () => {
    await inRollback(async (tx) => {
      const user = await admin(tx);
      const svc = new WhatsAppService(tx);
      await svc.recordInboundMessage("META", image(`wamid-${uid()}`, "919812400001"));
      const msg = await tx.whatsAppMessage.findFirstOrThrow({ where: { normalizedContact: "+919812400001", direction: "INBOUND" } });
      assert.equal(msg.messageType, "MEDIA");
      assert.equal(msg.body, "paid, UTR 8841");

      const page = await svc.listMessages(user, { page: 1, pageSize: 20 });
      const item = page.items.find((i) => i.id === msg.id)!;
      assert.deepEqual(item.media, { kind: "image", mimeType: "image/jpeg", filename: null });
      assert.ok(!JSON.stringify(page).includes("MEDIA-ABC"), "the provider media id never reaches the API response");
    });
  });

  it("a duplicate webhook delivery records one message and one activity", async () => {
    await inRollback(async (tx) => {
      const svc = new WhatsAppService(tx);
      const id = `wamid-${uid()}`;
      await svc.recordInboundMessage("META", image(id, "919812400002"));
      await svc.recordInboundMessage("META", image(id, "919812400002"));
      const msgs = await tx.whatsAppMessage.findMany({ where: { providerMessageId: id } });
      assert.equal(msgs.length, 1);
      assert.equal(await tx.activity.count({ where: { referenceId: msgs[0]!.id, type: "WHATSAPP_MESSAGE_RECEIVED" } }), 1);
    });
  });

  it("an image whose metadata is missing is still recorded, and reports 'unknown' (no preview) instead of failing", async () => {
    await inRollback(async (tx) => {
      const user = await admin(tx);
      const svc = new WhatsAppService(tx, undefined, source(png).get);
      await svc.recordInboundMessage("META", image(`wamid-${uid()}`, "919812400003", { media: null }));
      const msg = await tx.whatsAppMessage.findFirstOrThrow({ where: { normalizedContact: "+919812400003" } });
      const item = (await svc.getMessage(user, msg.id));
      assert.deepEqual(item.media, { kind: "unknown", mimeType: null, filename: null });
      await assert.rejects(svc.getInboundMedia(user, msg.id), /not recorded/);
    });
  });

  it("text messages carry no media", async () => {
    await inRollback(async (tx) => {
      const user = await admin(tx);
      const svc = new WhatsAppService(tx);
      await svc.recordInboundMessage("META", image(`wamid-${uid()}`, "919812400004", { messageType: "TEXT", text: "hello", media: null }));
      const msg = await tx.whatsAppMessage.findFirstOrThrow({ where: { normalizedContact: "+919812400004" } });
      assert.equal((await svc.getMessage(user, msg.id)).media, null);
      await assert.rejects(svc.getInboundMedia(user, msg.id), /no file/);
    });
  });
});

describe("serving the file", () => {
  const record = async (tx: Prisma.TransactionClient, phone: string, over: Partial<NormalizedIncomingMessage> = {}, src = source(png)) => {
    const svc = new WhatsAppService(tx, undefined, src.get as never);
    await svc.recordInboundMessage("META", image(`wamid-${uid()}`, phone, over));
    const msg = await tx.whatsAppMessage.findFirstOrThrow({ where: { normalizedContact: `+${phone}` } });
    return { svc, msg, src };
  };

  it("returns the bytes with an allow-listed content type, inline for images", async () => {
    await inRollback(async (tx) => {
      const user = await admin(tx);
      const { svc, msg, src } = await record(tx, "919812400010");
      const out = await svc.getInboundMedia(user, msg.id);
      assert.equal(out.buffer.toString(), "PNG");
      assert.equal(out.contentType, "image/png");
      assert.match(out.contentDisposition, /^inline;/);
      assert.deepEqual(src.calls, ["MEDIA-ABC"]);
    });
  });

  it("an html / svg / unknown type is forced to a download as octet-stream", async () => {
    await inRollback(async (tx) => {
      const user = await admin(tx);
      for (const mime of ["text/html", "image/svg+xml", null]) {
        const { svc, msg } = await record(tx, `91981240${Math.floor(1000 + Math.random() * 8999)}`, { media: { kind: "image", providerMediaId: "MEDIA-ABC", mimeType: null, filename: null, sha256: null, caption: null } }, source({ buffer: Buffer.from("<script>"), mimeType: mime, checksumVerified: null }));
        const out = await svc.getInboundMedia(user, msg.id);
        assert.equal(out.contentType, "application/octet-stream");
        assert.match(out.contentDisposition, /^attachment;/);
      }
    });
  });

  it("expired media -> 404, provider trouble -> 502, no WhatsApp config -> 503, too large -> 413", async () => {
    await inRollback(async (tx) => {
      const user = await admin(tx);
      const cases: [FetchedMedia | Error, number][] = [
        [new WhatsAppMediaError("gone", "NOT_FOUND"), 404],
        [new WhatsAppMediaError("down", "UNAVAILABLE"), 502],
        [new WhatsAppMediaError("bad checksum", "INTEGRITY"), 502],
        [new WhatsAppMediaError("big", "TOO_LARGE"), 413],
        [new Error("boom"), 502],
      ];
      for (const [result, status] of cases) {
        const { svc, msg } = await record(tx, `91981241${Math.floor(1000 + Math.random() * 8999)}`, {}, source(result));
        await assert.rejects(svc.getInboundMedia(user, msg.id), (e: { statusCode?: number }) => e.statusCode === status, String(status));
      }
      const svc = new WhatsAppService(tx, undefined, async () => null);
      await svc.recordInboundMessage("META", image(`wamid-${uid()}`, "919812400020"));
      const msg = await tx.whatsAppMessage.findFirstOrThrow({ where: { normalizedContact: "+919812400020" } });
      await assert.rejects(svc.getInboundMedia(user, msg.id), (e: { statusCode?: number }) => e.statusCode === 503);
    });
  });

  it("outbound messages, other providers and out-of-scope users get 404 and nothing is downloaded", async () => {
    await inRollback(async (tx) => {
      const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "X", mobile: "9812400030", normalizedMobile: "+919812400030" } });
      const outbound = await tx.whatsAppMessage.create({ data: { provider: "META", providerMessageId: `o-${uid()}`, direction: "OUTBOUND", messageType: "MEDIA", status: "SENT", leadId: lead.id, normalizedContact: "+919812400030" } });
      const src = source(png);
      const svc = new WhatsAppService(tx, undefined, src.get as never);
      const user = await admin(tx);
      await assert.rejects(svc.getInboundMedia(user, outbound.id), (e: { statusCode?: number }) => e.statusCode === 404);
      await assert.rejects(svc.getInboundMedia(user, randomUUID()), (e: { statusCode?: number }) => e.statusCode === 404);
      assert.equal(src.calls.length, 0);
    });
  });

  it("a screenshot never changes order or payment status", async () => {
    await inRollback(async (tx) => {
      const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Pay", mobile: "9812400040", normalizedMobile: "+919812400040" } });
      const before = await tx.order.count({ where: { leadId: lead.id } });
      const svc = new WhatsAppService(tx);
      await svc.recordInboundMessage("META", image(`wamid-${uid()}`, "919812400040"));
      assert.equal(await tx.order.count({ where: { leadId: lead.id } }), before);
      assert.equal(await tx.payment.count({ where: { order: { leadId: lead.id } } }), 0);
    });
  });
});

describe("screenshots received before details were stored (older server version)", () => {
  const legacy = async (tx: Prisma.TransactionClient, phone: string, withWebhook: boolean) => {
    const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Old", mobile: phone.slice(3), normalizedMobile: phone } });
    const wamid = `wamid.LEGACY${uid()}`;
    const msg = await tx.whatsAppMessage.create({ data: { provider: "META", providerMessageId: wamid, direction: "INBOUND", messageType: "MEDIA", status: "RECEIVED", leadId: lead.id, normalizedContact: phone, receivedAt: new Date() } });
    await tx.activity.create({ data: { leadId: lead.id, type: "WHATSAPP_MESSAGE_RECEIVED", referenceType: "WhatsAppMessage", referenceId: msg.id, title: "WhatsApp message received" } });
    if (withWebhook) {
      await tx.webhookEvent.create({
        data: { provider: "META", eventType: "messages", externalEventId: `ev-${uid()}`, receivedAt: new Date(), status: "PROCESSED",
          payload: { entry: [{ changes: [{ value: { messages: [{ id: wamid, from: phone.slice(1), type: "image", timestamp: "1", image: { id: "LEGACY-MEDIA-1", mime_type: "image/jpeg", sha256: "ab", url: "https://lookaside.fbsbx.com/x" } }] } }] }] } },
      });
    }
    return msg;
  };

  it("the media details are recovered from the stored webhook delivery, so the history shows an image (not 'details not recorded') and it can be fetched", async () => {
    await inRollback(async (tx) => {
      const user = await admin(tx);
      const src = source(png);
      const svc = new WhatsAppService(tx, undefined, src.get as never);
      const msg = await legacy(tx, "+919812400050", true);
      const item = await svc.getMessage(user, msg.id);
      assert.deepEqual(item.media, { kind: "image", mimeType: "image/jpeg", filename: null });
      assert.ok(!JSON.stringify(item).includes("LEGACY-MEDIA-1") && !JSON.stringify(item).includes("lookaside"), "no provider id or URL is exposed");
      const out = await svc.getInboundMedia(user, msg.id);
      assert.equal(out.contentType, "image/png");
      assert.deepEqual(src.calls, ["LEGACY-MEDIA-1"]);
    });
  });

  it("when the webhook delivery is gone too, it is an honest 'unknown', not an error", async () => {
    await inRollback(async (tx) => {
      const user = await admin(tx);
      const svc = new WhatsAppService(tx, undefined, source(png).get as never);
      const msg = await legacy(tx, "+919812400051", false);
      assert.equal((await svc.getMessage(user, msg.id)).media?.kind, "unknown");
    });
  });

  it("two separate screenshots from one customer are two messages, each with its own details; re-processing the same delivery does not add a third", async () => {
    await inRollback(async (tx) => {
      const user = await admin(tx);
      const svc = new WhatsAppService(tx);
      await svc.recordInboundMessage("META", image(`wamid-${uid()}`, "919812400052", { media: { kind: "image", providerMediaId: "M-A", mimeType: "image/jpeg", filename: null, sha256: null, caption: null } }));
      const second = `wamid-${uid()}`;
      const b = image(second, "919812400052", { media: { kind: "image", providerMediaId: "M-B", mimeType: "image/png", filename: null, sha256: null, caption: null } });
      await svc.recordInboundMessage("META", b);
      await svc.recordInboundMessage("META", b);
      const list = await svc.listMessages(user, { page: 1, pageSize: 20 });
      const mine = list.items.filter((i) => i.messageType === "MEDIA" && i.customer?.name);
      assert.equal(mine.filter((i) => i.media?.mimeType === "image/png").length, 1);
      assert.equal(await tx.whatsAppMessage.count({ where: { normalizedContact: "+919812400052", direction: "INBOUND" } }), 2);
    });
  });
});
