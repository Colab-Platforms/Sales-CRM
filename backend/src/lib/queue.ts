import { PgBoss } from "pg-boss";
import { logger } from "@/utils/logger.js";

// Real job queue (retries/backoff/concurrency), not another setInterval-over-a-table poller like the
// webhook processors use - runs on the same Postgres this app already talks to (its own "pgboss"
// schema, created automatically on first start), so nothing new to host.
//
// Caveat: pg-boss holds a persistent pool and uses LISTEN/NOTIFY + advisory locks, which needs a
// direct Postgres connection - not a transaction-pooling endpoint (e.g. Neon's "-pooler" host, or
// PgBouncer in transaction mode). Point QUEUE_DATABASE_URL at a direct connection if DATABASE_URL is
// pooled; it falls back to DATABASE_URL when unset.
let startPromise: Promise<PgBoss> | null = null;

export function getQueue(): Promise<PgBoss> {
  if (startPromise) return startPromise;

  const connectionString = process.env.QUEUE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL (or QUEUE_DATABASE_URL) is required for the job queue");

  const boss = new PgBoss({ connectionString });
  boss.on("error", (error: Error) => logger.error(`[queue] ${error.message}`));

  startPromise = boss.start().then((started: PgBoss) => {
    logger.info("[queue] pg-boss started");
    return started;
  });
  return startPromise;
}
