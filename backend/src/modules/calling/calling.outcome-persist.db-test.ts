// A saved disposition (Call back requested / Follow-up needed / Interested ...) changes nothing about what the telecaller may do next: it is stored against the right call and lead, can be changed later, never
// creates an order by itself, and never touches orders. The CallingService uses the global client, so this runs ONLY on the isolated database (guarded launcher) and removes everything it creates.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { CallDirection, CallStatus, Role } from "../../../generated/prisma/enums.js";
import CallingService from "./calling.service.js";

const uid = () => randomUUID().slice(0, 8);
const made = { users: [] as string[], leads: [] as string[], calls: [] as string[], outcomes: [] as string[] };
after(async () => {
  await prisma.task.deleteMany({ where: { leadId: { in: made.leads } } });
  await prisma.activity.deleteMany({ where: { leadId: { in: made.leads } } });
  await prisma.call.deleteMany({ where: { id: { in: made.calls } } });
  await prisma.lead.deleteMany({ where: { id: { in: made.leads } } });
  await prisma.callOutcome.deleteMany({ where: { id: { in: made.outcomes } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

async function world() {
  const tele = await prisma.user.create({ data: { name: "Tele", username: `tele-${uid()}`, role: Role.SALESPERSON } });
  const other = await prisma.user.create({ data: { name: "Other", username: `other-${uid()}`, role: Role.SALESPERSON } });
  made.users.push(tele.id, other.id);
  const lead = await prisma.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Asha", mobile: "9876500000", normalizedMobile: "+919876500000", ownerId: tele.id } });
  made.leads.push(lead.id);
  const call = await prisma.call.create({ data: { leadId: lead.id, agentId: tele.id, provider: "test", direction: CallDirection.OUTBOUND, status: CallStatus.COMPLETED, customerNumber: "+919876500000" } });
  made.calls.push(call.id);
  const mk = async (code: string, name: string, over: { requiresFollowup?: boolean; requiresNote?: boolean; category: "FOLLOW_UP" | "INTERESTED" | "NOT_INTERESTED" }) => {
    const o = await prisma.callOutcome.create({ data: { code: `${code}_${uid()}`, name, ...over } });
    made.outcomes.push(o.id);
    return o;
  };
  return { tele, other, lead, call, mk, as: (u: { id: string }) => ({ id: u.id, role: Role.SALESPERSON, username: "x" }) as never };
}

describe("a saved callback / follow-up leaves everything else available", () => {
  it("stores the disposition + reminder on the right call and lead, creates no order, and the disposition and notes can be changed on the same call later", async () => {
    const w = await world();
    const svc = new CallingService();
    const cb = await w.mk("CALL_BACK_REQUESTED", "Call back requested", { requiresFollowup: true, category: "FOLLOW_UP" });
    const interested = await w.mk("INTERESTED", "Interested", { category: "INTERESTED" });
    const when = new Date(Date.now() + 86_400_000).toISOString();
    const orders = () => prisma.order.count({ where: { leadId: w.lead.id } });

    const saved = await svc.submitCallOutcome(w.as(w.tele), w.call.id, { outcomeId: cb.id, notes: "call after lunch", followUpAt: when });
    assert.equal(saved?.outcome?.id, cb.id);
    assert.equal((await prisma.task.count({ where: { leadId: w.lead.id, status: "PENDING" } })), 1, "the reminder exists");
    assert.equal(await orders(), 0, "saving a disposition never creates an order");

    // the customer calls back and is ready: the SAME call/lead takes a new disposition and note - nothing is locked
    const later = await svc.submitCallOutcome(w.as(w.tele), w.call.id, { outcomeId: interested.id, notes: "ready to order" });
    assert.equal(later?.outcome?.id, interested.id);
    assert.equal(later?.notes, "ready to order");
    assert.equal(await prisma.task.count({ where: { leadId: w.lead.id, status: "PENDING" } }), 0, "the answered reminder is closed");
    const reread = await prisma.call.findUniqueOrThrow({ where: { id: w.call.id }, select: { leadId: true, outcomeId: true, notes: true } });
    assert.deepEqual([reread.leadId, reread.outcomeId, reread.notes], [w.lead.id, interested.id, "ready to order"]);
    assert.equal(await orders(), 0);
    assert.equal(await prisma.activity.count({ where: { leadId: w.lead.id, referenceId: w.call.id } }), 2, "both saves are in the audit trail");
  });

  it("another telecaller cannot save onto this lead's call; a follow-up outcome without a time is rejected", async () => {
    const w = await world();
    const svc = new CallingService();
    const cb = await w.mk("FOLLOW_UP_NEEDED", "Follow-up needed", { requiresFollowup: true, category: "FOLLOW_UP" });
    await assert.rejects(svc.submitCallOutcome(w.as(w.other), w.call.id, { outcomeId: cb.id, followUpAt: new Date(Date.now() + 3_600_000).toISOString() }), /not found/i);
    await assert.rejects(svc.submitCallOutcome(w.as(w.tele), w.call.id, { outcomeId: cb.id }));
    assert.equal((await prisma.call.findUniqueOrThrow({ where: { id: w.call.id } })).outcomeId, null);
  });
});
