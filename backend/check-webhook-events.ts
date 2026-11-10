import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

const adapter = new PrismaPg(
  { connectionString: "postgresql://oms_user:oms_password@localhost:5432/ayushwellness_oms" },
  { schema: "sales_crm_local_test" },
);
const prisma = new PrismaClient({ adapter });

async function main() {
  const rows = await prisma.webhookEvent.findMany({
    where: { provider: "META" },
    orderBy: { receivedAt: "desc" },
    take: 10,
    select: {
      id: true,
      status: true,
      attempts: true,
      omsForwardStatus: true,
      omsForwardAttempts: true,
      omsForwardErrorMessage: true,
      omsForwardedAt: true,
      externalEventId: true,
    },
  });
  console.log(JSON.stringify(rows, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
