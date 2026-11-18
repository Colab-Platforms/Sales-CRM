import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ReportMessagePart, ReportRecipientResult } from "@/lib/api-client/types/report-automation.types";
import { messageState, partsOf, shortTime, trackingCounts } from "./report-tracking";

const part = (status: ReportMessagePart["status"], over: Partial<ReportMessagePart> = {}): ReportMessagePart => ({ status, attempts: 1, lastAttemptAt: null, error: null, providerMessageId: null, sentAt: null, deliveredAt: null, readAt: null, canRetry: false, ...over });
const rec = (summary: ReportMessagePart["status"], over: Partial<ReportRecipientResult> & { detail?: ReportMessagePart; document?: ReportMessagePart } = {}): ReportRecipientResult => ({
  id: "r", name: "N", phone: "+91•••••••••10", status: summary, attempts: 1, lastAttemptAt: null, nextAttemptAt: null, error: null, providerMessageId: null, sentAt: null, deliveredAt: null, readAt: null, repliedAt: null, canRetry: false,
  detail: part("SKIPPED"), document: part("SKIPPED"), ...over,
});

describe("message status: single tick -> double grey -> double blue", () => {
  it("accepted only = Sent; delivered = Delivered; read = Read", () => {
    assert.equal(messageState(rec("SENT")).tick, "SENT");
    assert.equal(messageState(rec("DELIVERED")).tick, "DELIVERED");
    assert.equal(messageState(rec("READ")).tick, "READ");
  });
  it("the furthest of the three messages wins (the Excel was read although the summary was only delivered)", () => {
    assert.equal(messageState(rec("DELIVERED", { document: part("READ") })).tick, "READ");
  });
  it("a skipped message (not needed / turned off) is ignored", () => {
    assert.equal(partsOf(rec("SKIPPED", { detail: part("DELIVERED") })).length, 1);
    assert.equal(messageState(rec("SKIPPED", { detail: part("DELIVERED") })).tick, "DELIVERED");
  });
});

describe("failure, pending and unknown", () => {
  it("failed with nothing accepted = Failed; nothing tried yet = Pending; no answer from the provider = Outcome unknown (never shown as sent)", () => {
    assert.equal(messageState(rec("FAILED")).tick, "FAILED");
    assert.equal(messageState(rec("PENDING")).tick, "PENDING");
    assert.equal(messageState(rec("SENDING")).tick, "PENDING");
    assert.equal(messageState(rec("UNCERTAIN")).tick, "UNKNOWN");
  });
  it("held for the recipient's reply = Waiting for reply", () => {
    assert.equal(messageState(rec("SKIPPED", { detail: part("WAITING_FOR_REPLY"), document: part("WAITING_FOR_REPLY") })).tick, "WAITING");
  });
  it("a tick plus a definitely failed message keeps the tick but flags the partial failure (so it is not hidden)", () => {
    const s = messageState(rec("DELIVERED", { document: part("FAILED", { error: "Meta refused the file" }) }));
    assert.deepEqual([s.tick, s.partialFailure, s.hasFailure], ["DELIVERED", true, true]);
  });
});

describe("replied is separate from delivery", () => {
  it("a recipient can read without replying, and a reply does not change the tick", () => {
    const read = rec("READ");
    assert.equal(read.repliedAt, null);
    assert.equal(messageState(read).tick, "READ");
    assert.equal(messageState({ ...read, repliedAt: "2026-11-19T04:00:00Z" }).tick, "READ");
  });
  it("last updated is the newest time across messages and the reply", () => {
    const r = rec("READ", { sentAt: "2026-11-19T03:30:00Z", readAt: "2026-11-19T03:45:00Z", repliedAt: "2026-11-19T04:00:00Z" });
    assert.equal(messageState(r).updatedAt, "2026-11-19T04:00:00Z");
    assert.equal(messageState(rec("PENDING")).updatedAt, null);
  });
});

describe("the run's cards", () => {
  it("counts are cumulative like WhatsApp's ticks, and Replied / Failed are their own counts", () => {
    const rows = [rec("READ", { repliedAt: "2026-11-19T04:00:00Z" }), rec("DELIVERED"), rec("SENT"), rec("FAILED"), rec("PENDING")];
    assert.deepEqual(trackingCounts(rows), { total: 5, sent: 3, delivered: 2, read: 1, replied: 1, failed: 1 });
  });
  it("an empty run has all zeros (no division, no invented numbers)", () => {
    assert.deepEqual(trackingCounts([]), { total: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0 });
  });
  it("a recipient with one accepted and one failed message counts as Sent AND Failed", () => {
    assert.deepEqual(trackingCounts([rec("SENT", { document: part("FAILED") })]), { total: 1, sent: 1, delivered: 0, read: 0, replied: 0, failed: 1 });
  });
});

describe("shortTime", () => {
  const now = new Date("2026-11-19T05:00:00Z"); // 10:30 IST on 19 Nov
  it("today shows the time only, another day shows the date too, in the report's timezone", () => {
    assert.equal(shortTime("2026-11-19T03:45:00Z", "Asia/Kolkata", now), "9:15 AM");
    assert.equal(shortTime("2026-11-18T03:45:00Z", "Asia/Kolkata", now), "18 Nov, 9:15 AM");
    assert.equal(shortTime(null, "Asia/Kolkata", now), "-");
  });
});
