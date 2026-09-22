// Baseline accounts for local development: one ADMIN, one MANAGER (with a group), and one
// SALESPERSON in that group. This is the file `prisma.config.ts` and `npx prisma db seed` /
// `prisma migrate dev` run automatically.
//
//   npx prisma db seed      seed (or re-seed — every write below is an upsert, safe to re-run)
//   npm run db:seed         same, via the script below
//
// Every user is matched and updated by email, so running this again never creates duplicates; it
// only creates what's missing and refreshes role/status/password on what already exists. It
// refuses to run with NODE_ENV=production, since the password below is fixed and well-known.
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/lib/password.js";
import type { DbClient } from "../src/lib/leadScope.js";
import { GroupStatus, Role, UserStatus } from "../generated/prisma/enums.js";

// Dev-only, intentionally fixed and documented — never used when NODE_ENV=production (guarded below).
const DEV_PASSWORD = "ChangeMe123!";

const GROUP_NAME = "Seed Sales Team";

const SEED_USERS = [
  { role: Role.ADMIN, name: "Seed Admin", email: "admin@avatarindia.test", phone: "9000000001" },
  { role: Role.MANAGER, name: "Seed Manager", email: "manager@avatarindia.test", phone: "9000000002" },
  { role: Role.SALESPERSON, name: "Seed Salesperson", email: "salesperson@avatarindia.test", phone: "9000000003" },
] as const;

export interface SeedCoreResult {
  admin: { id: string; email: string };
  manager: { id: string; email: string };
  salesperson: { id: string; email: string };
  groupId: string;
}

export async function seedCoreUsers(db: DbClient): Promise<SeedCoreResult> {
  const passwordHash = await hashPassword(DEV_PASSWORD);

  const created: Record<string, { id: string; email: string }> = {};
  for (const def of SEED_USERS) {
    const user = await db.user.upsert({
      where: { email: def.email },
      update: { name: def.name, phone: def.phone, role: def.role, status: UserStatus.ACTIVE, passwordHash },
      create: { name: def.name, email: def.email, phone: def.phone, role: def.role, status: UserStatus.ACTIVE, passwordHash },
      select: { id: true, email: true },
    });
    created[def.role] = user;
  }

  const admin = created[Role.ADMIN]!;
  const manager = created[Role.MANAGER]!;
  const salesperson = created[Role.SALESPERSON]!;

  // One group owned by the seeded manager, with the seeded salesperson as an active member —
  // mirrors exactly what ManagerService.createGroup + addNewSalesperson would produce, so the
  // seeded accounts are immediately useful together (a manager with no team/leads to see is not).
  // Group has no unique constraint to upsert on (only non-unique indexes), so this is a plain
  // find-then-create, matched on (managerId, name).
  const existingGroup = await db.group.findFirst({ where: { managerId: manager.id, name: GROUP_NAME }, select: { id: true } });
  const groupId =
    existingGroup?.id ??
    (await db.group.create({ data: { name: GROUP_NAME, managerId: manager.id, status: GroupStatus.ACTIVE }, select: { id: true } })).id;

  await db.groupMember.upsert({
    where: { groupId_userId: { groupId, userId: salesperson.id } },
    update: { isActive: true },
    create: { groupId, userId: salesperson.id, joinedAt: new Date(), isActive: true },
  });

  return { admin, manager, salesperson, groupId };
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run: NODE_ENV is production (this seed uses a fixed, well-known password).");
  }

  const host = new URL(process.env.DATABASE_URL ?? "postgresql://unset").host;
  console.log(`Database host: ${host}`);

  const result = await prisma.$transaction((tx) => seedCoreUsers(tx));

  console.log("\nSeeded core accounts (idempotent — safe to run again):");
  console.log(`  ADMIN        ${result.admin.email}`);
  console.log(`  MANAGER      ${result.manager.email}`);
  console.log(`  SALESPERSON  ${result.salesperson.email}  (member of group ${result.groupId})`);
  console.log(`  Password (all three, dev only): ${DEV_PASSWORD}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
