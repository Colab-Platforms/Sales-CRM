import "dotenv/config";
import { PrismaNeon}  from "@prisma/adapter-neon"
import { PrismaClient } from "../../generated/prisma/client.js";

const connectionString = `${process.env.DATABASE_URL}`;

// Bounded wait for a connection: a suspended Neon compute wakes in a few seconds, so 15 s is generous, and a database that stays unreachable fails (webhook senders then get a 5xx and
// retry) instead of every request hanging with no timeout, which is the pg Pool default.
const adapter = new PrismaNeon({ connectionString, connectionTimeoutMillis: 15_000 });
const prisma = new PrismaClient({ adapter });

export { prisma };
