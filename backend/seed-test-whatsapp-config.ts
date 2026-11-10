import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";
import { encryptJson } from "./src/utils/crypto.js";

const adapter = new PrismaPg(
  { connectionString: "postgresql://oms_user:oms_password@localhost:5432/ayushwellness_oms" },
  { schema: "sales_crm_local_test" },
);
const prisma = new PrismaClient({ adapter });

export const TEST_META_APP_SECRET = "test-app-secret-local-only-0123456789";
export const TEST_VERIFY_TOKEN = "test-verify-token-local-only";
export const TEST_PHONE_NUMBER_ID = "999999999999999";
export const TEST_BUSINESS_ACCOUNT_ID = "888888888888888";

async function main() {
  const credentials = encryptJson({
    accessToken: "test-access-token-not-real",
    appSecret: TEST_META_APP_SECRET,
    verifyToken: TEST_VERIFY_TOKEN,
  });
  await prisma.whatsAppConfig.deleteMany({});
  const row = await prisma.whatsAppConfig.create({
    data: {
      phoneNumberId: TEST_PHONE_NUMBER_ID,
      businessAccountId: TEST_BUSINESS_ACCOUNT_ID,
      displayPhoneNumber: "+10000000000",
      businessName: "Local Test",
      isActive: true,
      credentials,
    },
  });
  console.log("Seeded WhatsAppConfig row:", row.id);
  await prisma.$disconnect();
}

main();
