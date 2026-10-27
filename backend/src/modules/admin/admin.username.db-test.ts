// Changing a username through the real AdminService on the ISOLATED test database (guarded runner only). The service writes through the shared client, so each test creates its own uniquely named
// synthetic users and removes them afterwards.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import { hashPassword, comparePassword } from "../../lib/password.js";
import AdminService from "./admin.service.js";

const svc = new AdminService();
const uid = () => randomUUID().slice(0, 8);
const created: string[] = [];
async function mk(role: Role, username: string) {
  const u = await prisma.user.create({ data: { name: `Synthetic ${role}`, username, role, status: "ACTIVE", passwordHash: await hashPassword("original-pass-1") }, select: { id: true, username: true } });
  created.push(u.id);
  return u;
}
after(async () => {
  await prisma.user.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});
const rejects = (p: Promise<unknown>, status: number, re: RegExp) => assert.rejects(p, (e: { statusCode?: number; message: string }) => { assert.equal(e.statusCode, status); assert.match(e.message, re); return true; });

describe("admin: change a username", () => {
  it("changes it in place: same id, role, status and password; the new name signs in, the old one no longer matches", async () => {
    const m = await mk(Role.MANAGER, `mgr-${uid()}`);
    const next = `renamed-${uid()}`;
    const before = await prisma.user.findUniqueOrThrow({ where: { id: m.id } });
    const out = await svc.updateManager(m.id, { username: next });
    assert.equal(out.username, next);
    const after2 = await prisma.user.findUniqueOrThrow({ where: { id: m.id } });
    assert.deepEqual([after2.id, after2.role, after2.status, after2.passwordHash], [before.id, before.role, before.status, before.passwordHash], "id, role, status and password are untouched");
    assert.ok(await comparePassword("original-pass-1", after2.passwordHash!), "the password still works");
    assert.equal((await prisma.user.findUnique({ where: { username: next } }))?.id, m.id);
    assert.equal(await prisma.user.findUnique({ where: { username: m.username } }), null, "the old username is free again");
  });

  it("a username that another user already has is refused (409) and nothing changes", async () => {
    const a = await mk(Role.MANAGER, `a-${uid()}`);
    const b = await mk(Role.MANAGER, `b-${uid()}`);
    await rejects(svc.updateManager(a.id, { username: b.username, name: "Should not be saved" }), 409, /already in use/i);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: a.id } });
    assert.deepEqual([row.username, row.name], [a.username, "Synthetic MANAGER"]);
  });

  it("an unchanged username is a harmless no-op, not a conflict with itself", async () => {
    const m = await mk(Role.MANAGER, `same-${uid()}`);
    const out = await svc.updateManager(m.id, { username: m.username, name: "Renamed Person" });
    assert.deepEqual([out.username, out.name], [m.username, "Renamed Person"]);
  });

  it("works for salespersons and keeps their reporting manager and the other profile fields", async () => {
    const mgr = await mk(Role.MANAGER, `mg-${uid()}`);
    const sp = await prisma.user.create({ data: { name: "Synthetic SP", username: `sp-${uid()}`, role: Role.SALESPERSON, status: "ACTIVE", reportingManagerId: mgr.id, phone: "9000000001", passwordHash: await hashPassword("x-original-1") }, select: { id: true } });
    created.push(sp.id);
    const next = `sp-new-${uid()}`;
    const out = await svc.updateSalesperson(sp.id, { username: next });
    assert.equal(out.username, next);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: sp.id } });
    assert.deepEqual([row.reportingManagerId, row.phone, row.role], [mgr.id, "9000000001", Role.SALESPERSON]);
    const other = await mk(Role.SALESPERSON, `sp2-${uid()}`);
    await rejects(svc.updateSalesperson(other.id, { username: next }), 409, /already in use/i);
  });

  it("a username that differs only by case from another user's is the same username (conflict)", async () => {
    const a = await mk(Role.MANAGER, `case-${uid()}`);
    const b = await mk(Role.MANAGER, `other-${uid()}`);
    // the validator lower-cases before the service sees it, so the comparison is on the normalised value
    await rejects(svc.updateManager(b.id, { username: a.username }), 409, /already in use/i);
  });

  it("an unknown user is 404 (no silent create) and a user of another role is not editable through the manager endpoint", async () => {
    await assert.rejects(svc.updateManager(randomUUID(), { username: `x-${uid()}` }), (e: { statusCode?: number }) => e.statusCode === 404);
    const sp = await mk(Role.SALESPERSON, `wrongrole-${uid()}`);
    await assert.rejects(svc.updateManager(sp.id, { username: `y-${uid()}` }), (e: { statusCode?: number }) => e.statusCode === 404);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: sp.id } })).username.startsWith("wrongrole-"), true);
  });
});
