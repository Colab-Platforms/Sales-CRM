import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DbClient } from "@/lib/leadScope.js";
import { normalizeMobile } from "@/lib/leadIdentity.js";
import { customerWindowOpen } from "./report-automation.service.js";
import { isValidRecipient } from "./report-automation.validators.js";
import WhatsAppService from "../whatsapp/whatsapp.service.js";

type Msg = { provider: string; direction: string; normalizedContact: string; receivedAt: Date | null; createdAt: Date; providerMessageId: string; id: string };
/** In-memory whatsapp_messages: only the query customerWindowOpen runs. */
function fakeDb(rows: Msg[]) {
  return {
    whatsAppMessage: {
      findFirst: async ({ where }: any) => rows.filter((r) => r.normalizedContact === where.normalizedContact && r.provider === where.provider && r.direction === where.direction).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null,
      findUnique: async ({ where }: any) => rows.find((r) => r.provider === where.provider_providerMessageId.provider && r.providerMessageId === where.provider_providerMessageId.providerMessageId) ?? null,
    },
  } as unknown as DbClient;
}
const now = new Date("2026-10-27T10:30:00.000Z");
const hii = (over: Partial<Msg> = {}): Msg => ({ id: "m1", provider: "META", direction: "INBOUND", normalizedContact: "+919321614025", providerMessageId: "wamid.HII", receivedAt: new Date("2026-10-27T10:17:52.000Z"), createdAt: new Date("2026-10-27T10:17:56.000Z"), ...over });

describe("incoming 'Hii' opens the recipient's 24-hour window", () => {
  it("Meta's sender format (digits, no +) normalises to the recipient's saved number", () => {
    assert.equal(normalizeMobile("919321614025"), "+919321614025"); // what Meta sends in messages[].from
    assert.equal(normalizeMobile("+91 93216 14025"), "+919321614025");
  });

  it("closed before the message, open after it (the transition), for the correctly saved number", async () => {
    const rows: Msg[] = [];
    const db = fakeDb(rows);
    assert.equal(await customerWindowOpen(db, "+919321614025", now), false);
    rows.push(hii());
    assert.equal(await customerWindowOpen(db, "+919321614025", now), true);
    assert.equal(await customerWindowOpen(db, "919321614025", now), true); // any written form of the same number
  });

  it("the window is judged from the message's own timestamp, and expires after 24 hours", async () => {
    const db = fakeDb([hii()]);
    assert.equal(await customerWindowOpen(db, "+919321614025", new Date("2026-10-28T10:17:51.000Z")), true);
    assert.equal(await customerWindowOpen(db, "+919321614025", new Date("2026-10-28T10:17:53.000Z")), false);
  });

  it("a message from another number, provider or direction does not open it", async () => {
    const db = fakeDb([hii({ normalizedContact: "+919811515909" }), hii({ id: "m2", provider: "AISENSY" }), hii({ id: "m3", direction: "OUTBOUND" })]);
    assert.equal(await customerWindowOpen(db, "+919321614025", now), false);
  });

  it("THE FIELD CASE: a saved number one digit short (+91932614025) never matches the sender, so the window stays closed", async () => {
    const db = fakeDb([hii()]);
    assert.equal(await customerWindowOpen(db, "+91932614025", now), false);
    assert.equal(isValidRecipient("+91932614025"), false); // ...and it can no longer be saved
    assert.equal(isValidRecipient("+919321614025"), true);
  });

  it("recipient validation: +91 needs 10 digits starting 6-9; other countries keep E.164", () => {
    for (const bad of ["+91932614025", "+9193216140251", "+915321614025", "9321614025", "+0919321614025"]) assert.equal(isValidRecipient(bad), false, bad);
    for (const ok of ["+919321614025", "+14155550123", "+447911123456"]) assert.equal(isValidRecipient(ok), true, ok);
  });

  it("a duplicate webhook delivery of the same message id is ignored before any processing", async () => {
    const db = fakeDb([hii()]); // no $transaction on the fake: reaching it would throw
    await new WhatsAppService(db as any).recordInboundMessage("META", { providerMessageId: "wamid.HII", from: "919321614025", to: "x", messageType: "TEXT", text: "Hii", timestamp: new Date() } as any);
  });
});
