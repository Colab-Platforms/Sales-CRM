import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

const adapter = new PrismaPg(
  { connectionString: "postgresql://oms_user:oms_password@localhost:5432/ayushwellness_oms" },
  { schema: "sales_crm_local_test" },
);
const prisma = new PrismaClient({ adapter });

async function main() {
  const cols = await prisma.$queryRawUnsafe(`
    SELECT column_name, data_type, column_default
    FROM information_schema.columns
    WHERE table_schema='sales_crm_local_test' AND table_name='webhook_events'
    AND column_name LIKE 'oms_forward%'
    ORDER BY column_name
  `);
  console.log("columns:", cols);

  const idx = await prisma.$queryRawUnsafe(`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname='sales_crm_local_test' AND tablename='webhook_events'
    AND indexname LIKE '%oms_forward%'
  `);
  console.log("indexes:", idx);

  const enumVals = await prisma.$queryRawUnsafe(`
    SELECT enumlabel FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname='oms_forward_status' AND n.nspname='sales_crm_local_test'
    ORDER BY e.enumsortorder
  `);
  console.log("enum values:", enumVals);

  await prisma.$disconnect();
}

main();
