// Telecaller Performance vs Reports on real rows: for the same data, range and filters the dashboard's figures equal the Reports' overview (both read the same soldOrders). The services use the global client, so this
// runs ONLY on the isolated database (guarded launcher) and removes everything it creates.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role, UserStatus } from "../../../generated/prisma/enums.js";
import { managerAnalyticsService } from "../manager/manager.analytics.js";
import { summarizeTelecaller } from "./orders.dashboard.telecaller.js";

const uid = () => randomUUID().slice(0, 8);
const made = { users: [] as string[], leads: [] as string[], orders: [] as string[] };
after(async () => {
  await prisma.payment.deleteMany({ where: { orderId: { in: made.orders } } });
  await prisma.order.deleteMany({ where: { id: { in: made.orders } } });
  await prisma.activity.deleteMany({ where: { leadId: { in: made.leads } } });
  await prisma.lead.deleteMany({ where: { id: { in: made.leads } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

describe("Telecaller Performance equals Reports for identical inputs", () => {
  it("credited orders, COD / prepaid split, revenue and collected match the Reports overview; the payment filter applies the same way", async () => {
    const admin = await prisma.user.create({ data: { name: "Admin", username: `adm-${uid()}`, role: Role.ADMIN } });
    const tele = await prisma.user.create({ data: { name: "Tele", username: `tele-${uid()}`, role: Role.SALESPERSON, status: UserStatus.ACTIVE } });
    made.users.push(admin.id, tele.id);
    const lead = await prisma.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Asha", mobile: "9876511111", normalizedMobile: "+919876511111", ownerId: tele.id } });
    made.leads.push(lead.id);
    const at = new Date("2031-03-10T06:00:00Z"); // far from any real data in the isolated database
    const mk = async (n: string, amount: string, over: Record<string, unknown>) => {
      const o = await prisma.order.create({ data: { orderNumber: `T-${uid()}-${n}`, leadId: lead.id, source: "SALESPERSON", status: "CONFIRMED", totalAmount: amount, confirmedByUserId: tele.id, confirmedAt: at, createdAt: at, ...over } as never });
      made.orders.push(o.id);
      return o;
    };
    const cod = await mk("cod", "699.00", {});
    const pre = await mk("pre", "778.00", {});
    await prisma.payment.create({ data: { orderId: cod.id, amount: "699.00", method: "COD", status: "PENDING" } as never });
    await prisma.payment.create({ data: { orderId: pre.id, amount: "778.00", method: "UPI", status: "SUCCESS" } as never });

    const filters = { from: "2031-03-10", to: "2031-03-10", tzOffsetMinutes: 330, paymentMode: "ALL", orderStatus: "ALL", callStatus: "ALL", leadStatus: "ALL" } as const;
    for (const paymentMode of ["ALL", "COD", "PREPAID"] as const) {
      const f = { ...filters, paymentMode, salespersonId: tele.id };
      const { orders } = await managerAnalyticsService.creditedOrders({ id: admin.id, role: Role.ADMIN }, f);
      const dash = summarizeTelecaller(orders).summary;
      const rep = (await managerAnalyticsService.overview({ id: admin.id, role: Role.ADMIN }, f)).kpis as unknown as Record<string, number>;
      assert.deepEqual(
        [dash.totalOrders, dash.cod, dash.prepaid, dash.totalRevenue, dash.codRevenue, dash.prepaidRevenue, dash.collected],
        [rep.orders, rep.codOrders, rep.prepaidOrders, rep.revenue, rep.codRevenue, rep.prepaidRevenue, rep.collected],
        paymentMode,
      );
      if (paymentMode === "ALL") assert.deepEqual([dash.totalOrders, dash.cod, dash.prepaid, dash.collected, dash.paid, dash.pendingPayment], [2, 1, 1, 778, 1, 1]);
      if (paymentMode === "COD") assert.deepEqual([dash.totalOrders, dash.prepaid], [1, 0]);
    }
  });
});
