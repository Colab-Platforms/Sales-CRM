import "dotenv/config";
import { PrismaNeon}  from "@prisma/adapter-neon"
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";

const connectionString = `${process.env.DATABASE_URL}`;

// TEMPORARY, local-integration-testing-only branch -- revert before any real work continues.
// LOCAL_TEST_DB=1 selects a plain pg adapter against an isolated local Postgres schema instead
// of Neon's websocket adapter, since @prisma/adapter-neon cannot reach a non-Neon Postgres.
// Bounded wait for a connection: a suspended Neon compute wakes in a few seconds, so 15 s is generous, and a database that stays unreachable fails (webhook senders then get a 5xx and
// retry) instead of every request hanging with no timeout, which is the pg Pool default.
const adapter = process.env.LOCAL_TEST_DB === "1"
  ? new PrismaPg(
      { connectionString: connectionString.split("?")[0] },
      { schema: process.env.LOCAL_TEST_SCHEMA ?? "public" },
    )
  : new PrismaNeon({ connectionString, connectionTimeoutMillis: 15_000 });
const prisma = new PrismaClient({ adapter });

export { prisma };
