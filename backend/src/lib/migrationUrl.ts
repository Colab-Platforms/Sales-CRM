// Which database URL the Prisma CLI (migrate / studio / db ...) uses. Used by prisma.config.ts only - the running application builds its own connection from DATABASE_URL and never reads this.
//
// Neon's pooled endpoint (the "-pooler" host, PgBouncer in transaction mode) is right for the app but wrong for `prisma migrate`: migrate takes a SESSION-level advisory lock, and through the pooler the
// lock call and the unlock call can run on different server connections, which leaves the lock held by a connection the pooler keeps reusing (the next migrate then times out with P1002).
// So an OPTIONAL DIRECT_URL (the same database on the direct, non-pooled host) is preferred for the CLI. Unset or blank = DATABASE_URL, exactly as before.
//
// Safety: a DIRECT_URL is only honoured if it points at the SAME server (the host with any "-pooler" suffix removed) and the SAME database as DATABASE_URL. Otherwise it throws, so a leftover DIRECT_URL
// in .env can never silently send a migration run that was pointed at another database (e.g. an isolated test database set in the shell) to production. Error messages never contain the URLs.

export interface MigrationUrlResult {
  url: string | undefined;
  source: "DIRECT_URL" | "DATABASE_URL" | "none";
  /** True when the URL used is a Neon "-pooler" host (the CLI should warn: migrate may leave its advisory lock behind). */
  pooled: boolean;
}

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

const baseHost = (host: string): string => host.replace(/-pooler(?=\.)/, "");
const isPooled = (host: string): boolean => /-pooler(?=\.)/.test(host);

export function resolveMigrationUrl(env: Record<string, string | undefined>): MigrationUrlResult {
  const database = env.DATABASE_URL?.trim() || undefined;
  const direct = env.DIRECT_URL?.trim() || undefined;
  if (!direct) {
    const parsed = database ? parse(database) : null;
    return { url: database, source: database ? "DATABASE_URL" : "none", pooled: Boolean(parsed && isPooled(parsed.hostname)) };
  }
  const d = parse(direct);
  if (!d) throw new Error("DIRECT_URL is not a valid connection URL.");
  if (database) {
    const a = parse(database);
    if (!a) throw new Error("DATABASE_URL is not a valid connection URL.");
    if (baseHost(a.hostname) !== baseHost(d.hostname) || a.port !== d.port || a.pathname !== d.pathname) {
      throw new Error("DIRECT_URL and DATABASE_URL point at different servers or databases, so the Prisma CLI will not run. Make DIRECT_URL the direct (non-pooled) form of DATABASE_URL, or unset it.");
    }
  }
  return { url: direct, source: "DIRECT_URL", pooled: isPooled(d.hostname) };
}
