// Creates, lists and revokes the API keys of the external AI calling agency.
//   npm run agency:key -- create "Agency name" [--rate 30]
//   npm run agency:key -- list
//   npm run agency:key -- revoke <id>
//
// A new key is printed ONCE and only its SHA-256 hash is stored, so it cannot be shown again - create a new one if it is lost. Needs the agency_api_keys table (migration 20261110000000).
// It writes to whichever database DATABASE_URL points to - check that first.
import "dotenv/config";
import { generateApiKey } from "../modules/agency/agency.keys.js";

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i > -1 ? rest[i + 1] : undefined;
};

const { prisma } = await import("../lib/prisma.js");
try {
  if (command === "create") {
    const name = rest.find((a) => !a.startsWith("--") && a !== flag("rate"))?.trim();
    if (!name) throw new Error('Usage: npm run agency:key -- create "Agency name" [--rate 30]');
    const rate = flag("rate") ? Number(flag("rate")) : 30;
    if (!Number.isInteger(rate) || rate < 1 || rate > 600) throw new Error("--rate must be a whole number of requests per minute (1 to 600)");
    const { key, prefix, hash } = generateApiKey();
    const row = await prisma.agencyApiKey.create({ data: { name: name.slice(0, 120), keyPrefix: prefix, keyHash: hash, rateLimitPerMinute: rate }, select: { id: true } });
    console.log(`Key id:   ${row.id}\nName:     ${name}\nRate:     ${rate} requests/minute\n\nAPI key (shown once, store it safely and share it only with the agency):\n\n${key}\n`);
  } else if (command === "list") {
    const rows = await prisma.agencyApiKey.findMany({ orderBy: { createdAt: "desc" }, select: { id: true, name: true, keyPrefix: true, isActive: true, rateLimitPerMinute: true, createdAt: true, lastUsedAt: true, revokedAt: true } });
    for (const r of rows) console.log(`${r.id}  ${r.keyPrefix}...  ${r.isActive && !r.revokedAt ? "active " : "REVOKED"}  ${r.rateLimitPerMinute}/min  last used ${r.lastUsedAt?.toISOString() ?? "never"}  ${r.name}`);
    if (rows.length === 0) console.log("No keys yet.");
  } else if (command === "revoke") {
    const id = rest[0];
    if (!id) throw new Error("Usage: npm run agency:key -- revoke <key id>");
    const { count } = await prisma.agencyApiKey.updateMany({ where: { id, revokedAt: null }, data: { isActive: false, revokedAt: new Date() } });
    console.log(count === 1 ? "Revoked. The key stops working immediately." : "No active key with that id.");
  } else {
    console.log('Commands: create "<name>" [--rate N] | list | revoke <id>');
  }
} finally {
  await prisma.$disconnect();
}
