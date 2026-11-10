import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

const adapter = new PrismaPg({
  connectionString: "postgresql://oms_user:oms_password@localhost:5432/ayushwellness_oms?schema=sales_crm_local_test",
});
const prisma = new PrismaClient({ adapter });

async function main() {
  try {
    const r = await prisma.$queryRawUnsafe("SELECT 1 as ok");
    console.log("plain client works:", r);
  } catch (e) {
    console.log("plain client FAILED:", (e as Error).message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
