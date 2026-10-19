import "dotenv/config";
import { prisma } from "@/lib/prisma.js";
const [msgs, runs, orders, shopify] = await Promise.all([
  prisma.whatsAppMessage.count(), prisma.whatsAppAutomationRun.count(), prisma.order.count(),
  prisma.order.count({ where: { source: "SHOPIFY", createdAt: { gte: new Date("2026-10-07T18:30:00Z") } } }),
]);
console.log(JSON.stringify({ whatsappMessages: msgs, automationRuns: runs, orders, shopifyOrdersSinceOct8: shopify }));
await prisma.$disconnect();
