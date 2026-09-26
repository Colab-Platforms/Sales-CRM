// Database integration tests for E7.2 Template Management. Run with: npm run test:db
//
// Every test runs inside ONE transaction that is always rolled back - mirrors whatsapp.db-test.ts.
// Lead queries are not needed here (templates have no lead), so the pending lead-import migration
// gap documented in whatsapp.db-test.ts and the E7.1/E7.2 final reports does not affect this file.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { prisma } from "../../lib/prisma.js";
import { ActivitySource, ActivityType, Role, WhatsAppTemplateStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import AuditService from "../audit/audit.service.js";
import type { NormalizedTemplate, TemplateSyncResult, WhatsAppProvider } from "./whatsapp.provider.js";
import WhatsAppTemplateService from "./whatsapp.template.service.js";

class Rollback extends Error {}

async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    }, { timeout: 60_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

after(() => prisma.$disconnect());

const uid = () => randomUUID();
const as = (u: { id: string; email: string }, role: Role) => ({ id: u.id, email: u.email, role });

function fakeProvider(overrides: Partial<WhatsAppProvider> = {}): WhatsAppProvider {
  return {
    id: "AISENSY",
    sendTemplateMessage: async () => ({ providerMessageId: null, raw: null }),
    verifyWebhook: () => true,
    parseIncomingWebhook: () => [],
    parseDeliveryStatusWebhook: () => [],
    listTemplates: async () => ({ supported: false, reason: "not configured" }),
    ...overrides,
  };
}

describe("creating a local template", () => {
  it("extracts variables, defaults to DRAFT, and records WHATSAPP_TEMPLATE_CREATED with no lead", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const svc = new WhatsAppTemplateService(tx);

      const result = await svc.createTemplate(as(admin, Role.ADMIN), {
        name: `order_update_${uid()}`,
        provider: "AISENSY",
        language: "en",
        body: "Hi {{customer_name}}, your order {{order_number}} has shipped.",
      });

      assert.equal(result.status, "DRAFT");
      assert.deepEqual(result.variables, ["customer_name", "order_number"]);
      assert.equal(result.providerTemplateId, null);
      assert.equal(result.createdBy?.id, admin.id);

      const activity = await tx.activity.findFirst({ where: { type: ActivityType.WHATSAPP_TEMPLATE_CREATED, referenceId: result.id } });
      assert.ok(activity);
      assert.equal(activity!.leadId, null);
      assert.equal(activity!.actorId, admin.id);
      assert.equal(activity!.source, ActivitySource.USER);
    });
  });

  it("rejects a malformed body before ever writing a row", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const svc = new WhatsAppTemplateService(tx);
      await assert.rejects(
        () => svc.createTemplate(as(admin, Role.ADMIN), { name: `bad_${uid()}`, provider: "AISENSY", language: "en", body: "Hi {{}}" }),
        (e: any) => e.statusCode === 400,
      );
      assert.equal(await tx.whatsAppTemplate.count({ where: { name: { contains: "bad_" } } }), 0);
    });
  });

  it("rejects a duplicate (provider, name, language) with 409", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const svc = new WhatsAppTemplateService(tx);
      const name = `dup_${uid()}`;
      await svc.createTemplate(as(admin, Role.ADMIN), { name, provider: "AISENSY", language: "en", body: "Hello" });
      await assert.rejects(
        () => svc.createTemplate(as(admin, Role.ADMIN), { name, provider: "AISENSY", language: "en", body: "Hello again" }),
        (e: any) => e.statusCode === 409,
      );
    });
  });

  it("allows the same name for two different languages", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const svc = new WhatsAppTemplateService(tx);
      const name = `multilang_${uid()}`;
      await svc.createTemplate(as(admin, Role.ADMIN), { name, provider: "AISENSY", language: "en", body: "Hello" });
      const hi = await svc.createTemplate(as(admin, Role.ADMIN), { name, provider: "AISENSY", language: "hi", body: "Namaste" });
      assert.equal(hi.language, "hi");
    });
  });
});

describe("updating a template", () => {
  it("updates body/variables and records WHATSAPP_TEMPLATE_UPDATED", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const svc = new WhatsAppTemplateService(tx);
      const created = await svc.createTemplate(as(admin, Role.ADMIN), { name: `t_${uid()}`, provider: "AISENSY", language: "en", body: "Hi {{a}}" });

      const updated = await svc.updateTemplate(as(admin, Role.ADMIN), created.id, { body: "Hi {{a}} and {{b}}" });
      assert.deepEqual(updated.variables, ["a", "b"]);
      assert.equal(await tx.activity.count({ where: { type: ActivityType.WHATSAPP_TEMPLATE_UPDATED, referenceId: created.id } }), 1);
    });
  });

  it("allows DRAFT -> DISABLED and records a status-changed event too", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const svc = new WhatsAppTemplateService(tx);
      const created = await svc.createTemplate(as(admin, Role.ADMIN), { name: `t_${uid()}`, provider: "AISENSY", language: "en", body: "Hi" });

      const disabled = await svc.updateTemplate(as(admin, Role.ADMIN), created.id, { status: "DISABLED" });
      assert.equal(disabled.status, "DISABLED");
      assert.equal(await tx.activity.count({ where: { type: ActivityType.WHATSAPP_TEMPLATE_STATUS_CHANGED, referenceId: created.id } }), 1);
    });
  });

  it("404s for a template that does not exist", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const svc = new WhatsAppTemplateService(tx);
      await assert.rejects(() => svc.updateTemplate(as(admin, Role.ADMIN), randomUUID(), { body: "x" }), (e: any) => e.statusCode === 404);
    });
  });
});

describe("RBAC: a salesperson only sees approved templates", () => {
  async function seedTemplates(tx: Prisma.TransactionClient) {
    const provider = "AISENSY" as const;
    const base = { provider, language: "en", body: "Hi", variables: [] as string[] };
    const draft = await tx.whatsAppTemplate.create({ data: { ...base, name: `draft_${uid()}`, status: WhatsAppTemplateStatus.DRAFT } });
    const pending = await tx.whatsAppTemplate.create({ data: { ...base, name: `pending_${uid()}`, status: WhatsAppTemplateStatus.PENDING } });
    const approved = await tx.whatsAppTemplate.create({ data: { ...base, name: `approved_${uid()}`, status: WhatsAppTemplateStatus.APPROVED } });
    const rejected = await tx.whatsAppTemplate.create({ data: { ...base, name: `rejected_${uid()}`, status: WhatsAppTemplateStatus.REJECTED } });
    return { draft, pending, approved, rejected };
  }

  it("ADMIN sees every status; SALESPERSON only sees APPROVED", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const seeded = await seedTemplates(tx);
      const svc = new WhatsAppTemplateService(tx);

      const adminList = await svc.listTemplates(as(admin, Role.ADMIN), { page: 1, pageSize: 50 });
      const adminIds = adminList.items.map((t) => t.id);
      assert.ok([seeded.draft.id, seeded.pending.id, seeded.approved.id, seeded.rejected.id].every((id) => adminIds.includes(id)));

      // Unscoped, a SALESPERSON legitimately sees every real APPROVED template too (this task's own live test added
      // several) - not just this test's seeded one - so what is actually being asserted (APPROVED-only visibility)
      // is checked by containment/exclusion, and the "exactly this one" claim is scoped with `search` on its unique name.
      const repList = await svc.listTemplates(as(rep, Role.SALESPERSON), { page: 1, pageSize: 50 });
      const repIds = repList.items.map((t) => t.id);
      assert.ok(repIds.includes(seeded.approved.id));
      assert.ok(![seeded.draft.id, seeded.pending.id, seeded.rejected.id].some((id) => repIds.includes(id)));

      const repScoped = await svc.listTemplates(as(rep, Role.SALESPERSON), { page: 1, pageSize: 50, search: seeded.approved.name });
      assert.deepEqual(repScoped.items.map((t) => t.id), [seeded.approved.id]);
    });
  });

  it("SALESPERSON gets 404 fetching a non-approved template by id", async () => {
    await inRollback(async (tx) => {
      const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const seeded = await seedTemplates(tx);
      const svc = new WhatsAppTemplateService(tx);
      await assert.rejects(() => svc.getTemplate(as(rep, Role.SALESPERSON), seeded.draft.id), (e: any) => e.statusCode === 404);
      const ok = await svc.getTemplate(as(rep, Role.SALESPERSON), seeded.approved.id);
      assert.equal(ok.id, seeded.approved.id);
    });
  });

  it("SALESPERSON filtering by a status they cannot see gets an empty page, not an error", async () => {
    await inRollback(async (tx) => {
      const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      await seedTemplates(tx);
      const svc = new WhatsAppTemplateService(tx);
      const result = await svc.listTemplates(as(rep, Role.SALESPERSON), { page: 1, pageSize: 50, status: WhatsAppTemplateStatus.REJECTED });
      assert.deepEqual(result.items, []);
    });
  });
});

describe("listing and filtering", () => {
  it("filters by search, provider, category and language", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const svc = new WhatsAppTemplateService(tx);
      await svc.createTemplate(as(admin, Role.ADMIN), { name: `shipping_update_${uid()}`, provider: "AISENSY", category: "UTILITY", language: "en", body: "Shipped" });
      await svc.createTemplate(as(admin, Role.ADMIN), { name: `promo_${uid()}`, provider: "GUPSHUP", category: "MARKETING", language: "en", body: "Sale" });

      const byProvider = await svc.listTemplates(as(admin, Role.ADMIN), { page: 1, pageSize: 50, provider: "GUPSHUP" });
      assert.ok(byProvider.items.every((t) => t.provider === "GUPSHUP"));

      const byCategory = await svc.listTemplates(as(admin, Role.ADMIN), { page: 1, pageSize: 50, category: "UTILITY" });
      assert.ok(byCategory.items.every((t) => t.category === "UTILITY"));

      const bySearch = await svc.listTemplates(as(admin, Role.ADMIN), { page: 1, pageSize: 50, search: "shipping_update" });
      assert.ok(bySearch.items.length >= 1 && bySearch.items.every((t) => t.name.includes("shipping_update")));
    });
  });
});

describe("template sync", () => {
  it("creates new templates, is idempotent on a second identical sync, and records WHATSAPP_TEMPLATE_SYNCED", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const providerTemplateId = `gs-${uid()}`;
      const template: NormalizedTemplate = { providerTemplateId, externalId: "meta-1", name: `synced_${uid()}`, category: "UTILITY", language: "en", body: "Your order {{1}} shipped", status: "APPROVED", quality: "HIGH" };
      const listTemplates = async (): Promise<TemplateSyncResult> => ({ supported: true, templates: [template] });
      const svc = new WhatsAppTemplateService(tx, () => fakeProvider({ id: "GUPSHUP", listTemplates }));

      const first = await svc.syncTemplates(as(admin, Role.ADMIN));
      assert.deepEqual(first, { provider: "GUPSHUP", supported: true, created: 1, updated: 0, unchanged: 0, disabledMissing: 0, total: 1 });

      const second = await svc.syncTemplates(as(admin, Role.ADMIN));
      assert.deepEqual(second, { provider: "GUPSHUP", supported: true, created: 0, updated: 0, unchanged: 1, disabledMissing: 0, total: 1 });

      assert.equal(await tx.whatsAppTemplate.count({ where: { provider: "GUPSHUP", providerTemplateId } }), 1, "no duplicate row from the second sync");
      // Scoped to this freshly-created admin's own actorId, not a global count - real syncs run by other
      // users (this task's own live Meta sync included) also write WHATSAPP_TEMPLATE_SYNCED activities.
      assert.equal(await tx.activity.count({ where: { type: ActivityType.WHATSAPP_TEMPLATE_SYNCED, leadId: null, actorId: admin.id } }), 2);
    });
  });

  it("marks a synced row updated when the provider's content actually changed", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const providerTemplateId = `gs-${uid()}`;
      let status: NormalizedTemplate["status"] = "PENDING";
      const listTemplates = async (): Promise<TemplateSyncResult> => ({
        supported: true,
        templates: [{ providerTemplateId, externalId: null, name: "t", category: "UTILITY", language: "en", body: "Body", status, quality: null }],
      });
      const svc = new WhatsAppTemplateService(tx, () => fakeProvider({ id: "GUPSHUP", listTemplates }));

      await svc.syncTemplates(as(admin, Role.ADMIN));
      status = "APPROVED"; // Meta approved it since the last sync
      const second = await svc.syncTemplates(as(admin, Role.ADMIN));
      assert.equal(second.updated, 1);
      const row = await tx.whatsAppTemplate.findFirst({ where: { providerTemplateId } });
      assert.equal(row?.status, "APPROVED");
    });
  });

  it("never overwrites a real local category/quality/externalId with a blank one the provider happens to report", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const providerTemplateId = `gs-${uid()}`;
      const listTemplates = async (): Promise<TemplateSyncResult> => ({
        supported: true,
        templates: [{ providerTemplateId, externalId: "meta-123", name: "t", category: "UTILITY", language: "en", body: "Body", status: "APPROVED", quality: "HIGH" }],
      });
      const svc = new WhatsAppTemplateService(tx, () => fakeProvider({ id: "GUPSHUP", listTemplates }));
      await svc.syncTemplates(as(admin, Role.ADMIN));

      // A second sync where the provider now reports blanks for category/quality/externalId (a partial/degraded
      // response) - the real values already recorded must survive, only the always-authoritative fields (name,
      // body, language, status) actually change.
      const listTemplatesBlank = async (): Promise<TemplateSyncResult> => ({
        supported: true,
        templates: [{ providerTemplateId, externalId: null, name: "t", category: null, language: "en", body: "Body changed", status: "APPROVED", quality: null }],
      });
      const svc2 = new WhatsAppTemplateService(tx, () => fakeProvider({ id: "GUPSHUP", listTemplates: listTemplatesBlank }));
      const outcome = await svc2.syncTemplates(as(admin, Role.ADMIN));
      assert.equal(outcome.updated, 1, "the body DID actually change, so it is reported updated");

      const row = await tx.whatsAppTemplate.findFirstOrThrow({ where: { providerTemplateId }, select: { category: true, quality: true, externalId: true, body: true } });
      assert.equal(row.category, "UTILITY", "category survives a blank provider response");
      assert.equal(row.quality, "HIGH", "quality survives a blank provider response");
      assert.equal(row.externalId, "meta-123", "externalId survives a blank provider response");
      assert.equal(row.body, "Body changed", "the body itself is still always the provider's own");
    });
  });

  it("never touches a template's local components (header/footer/buttons) on sync - no provider integration returns that shape", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const providerTemplateId = `gs-${uid()}`;
      const listTemplates = async (): Promise<TemplateSyncResult> => ({ supported: true, templates: [{ providerTemplateId, externalId: null, name: "t", category: "UTILITY", language: "en", body: "Body", status: "APPROVED", quality: null }] });
      const svc = new WhatsAppTemplateService(tx, () => fakeProvider({ id: "GUPSHUP", listTemplates }));
      await svc.syncTemplates(as(admin, Role.ADMIN));
      await tx.whatsAppTemplate.updateMany({ where: { providerTemplateId }, data: { components: { footer: "Local footer" } } });

      await svc.syncTemplates(as(admin, Role.ADMIN));
      const row = await tx.whatsAppTemplate.findFirstOrThrow({ where: { providerTemplateId }, select: { components: true } });
      assert.deepEqual(row.components, { footer: "Local footer" });
    });
  });

  it("disables (never silently leaves APPROVED) a previously-synced template the provider no longer reports at all - a real remote deletion", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const gone = `gs-gone-${uid()}`;
      const stays = `gs-stays-${uid()}`;
      let templates: NormalizedTemplate[] = [
        { providerTemplateId: gone, externalId: null, name: "gone", category: "UTILITY", language: "en", body: "Body", status: "APPROVED", quality: null },
        { providerTemplateId: stays, externalId: null, name: "stays", category: "UTILITY", language: "en", body: "Body", status: "APPROVED", quality: null },
      ];
      const svc = new WhatsAppTemplateService(tx, () => fakeProvider({ id: "GUPSHUP", listTemplates: async () => ({ supported: true, templates }) }));
      const first = await svc.syncTemplates(as(admin, Role.ADMIN));
      assert.equal(first.disabledMissing, 0);

      // The provider now reports only "stays" - "gone" was deleted at the provider entirely.
      templates = [templates[1]!];
      const second = await svc.syncTemplates(as(admin, Role.ADMIN));
      assert.equal(second.disabledMissing, 1);

      const goneRow = await tx.whatsAppTemplate.findFirstOrThrow({ where: { providerTemplateId: gone }, select: { status: true } });
      assert.equal(goneRow.status, "DISABLED", "no longer silently APPROVED/sendable once the provider stops reporting it");
      const staysRow = await tx.whatsAppTemplate.findFirstOrThrow({ where: { providerTemplateId: stays }, select: { status: true } });
      assert.equal(staysRow.status, "APPROVED", "a template the provider still reports is never touched by the disappearance check");

      // Idempotent: a third sync that still doesn't report "gone" does not re-disable it (it already is) or
      // re-count it - the count only reflects a real transition just made.
      const third = await svc.syncTemplates(as(admin, Role.ADMIN));
      assert.equal(third.disabledMissing, 0);
    });
  });

  it("reports unsupported cleanly for AiSensy-style providers, creating nothing", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const svc = new WhatsAppTemplateService(tx, () => fakeProvider());
      // A before/after count, not an absolute 0 - real templates (AiSensy/Gupshup/Meta) already exist in the
      // (shared) database; "creating nothing" means this call adds none, not that the table is empty.
      const before = await tx.whatsAppTemplate.count();
      const result = await svc.syncTemplates(as(admin, Role.ADMIN));
      assert.deepEqual(result, { provider: "AISENSY", supported: false, reason: "not configured", created: 0, updated: 0, unchanged: 0, disabledMissing: 0, total: 0 });
      assert.equal(await tx.whatsAppTemplate.count(), before);
    });
  });

  it("reports 503 when WhatsApp is not configured at all", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const svc = new WhatsAppTemplateService(tx, () => null);
      await assert.rejects(() => svc.syncTemplates(as(admin, Role.ADMIN)), (e: any) => e.statusCode === 503);
    });
  });
});

describe("template events reach the Audit Trail with no lead, and stay out of a customer's own audit view", () => {
  it("shows a create+sync event for ADMIN with leadId/customer null", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const templateSvc = new WhatsAppTemplateService(tx);
      const created = await templateSvc.createTemplate(as(admin, Role.ADMIN), { name: `audit_${uid()}`, provider: "AISENSY", language: "en", body: "Hi" });

      const audit = new AuditService(tx);
      const result = await audit.listAudit(as(admin, Role.ADMIN), { page: 1, pageSize: 20, referenceType: "WhatsAppTemplate" });
      const entry = result.items.find((i) => i.entityId === created.id);
      assert.ok(entry);
      assert.equal(entry!.leadId, null);
      assert.equal(entry!.customer, null);
      assert.equal(entry!.type, "WHATSAPP_TEMPLATE_CREATED");
    });
  });

  it("never appears in a salesperson's lead-scoped audit list (their scope is non-empty and never matches a null lead)", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const templateSvc = new WhatsAppTemplateService(tx);
      const created = await templateSvc.createTemplate(as(admin, Role.ADMIN), { name: `audit_${uid()}`, provider: "AISENSY", language: "en", body: "Hi" });

      const audit = new AuditService(tx);
      const repResult = await audit.listAudit(as(rep, Role.SALESPERSON), { page: 1, pageSize: 50 });
      assert.equal(repResult.items.some((i) => i.entityId === created.id), false);
    });
  });
});

describe("template components (header/footer/buttons)", () => {
  it("persists and round-trips a structured header/footer/buttons payload", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const svc = new WhatsAppTemplateService(tx);
      const components = {
        header: { type: "TEXT" as const, text: "Order update" },
        footer: "Reply STOP to unsubscribe",
        buttons: [{ type: "URL" as const, text: "Track order", url: "https://example.invalid/track" }],
        bodyExamples: { customer_name: "Priya" },
      };
      const created = await svc.createTemplate(as(admin, Role.ADMIN), { name: `comp_${uid()}`, provider: "AISENSY", language: "en", body: "Hi {{customer_name}}", components });
      assert.deepEqual(created.components, components);

      const fetched = await svc.getTemplate(as(admin, Role.ADMIN), created.id);
      assert.deepEqual(fetched.components, components);

      const cleared = await svc.updateTemplate(as(admin, Role.ADMIN), created.id, { components: null });
      assert.equal(cleared.components, null);
    });
  });

  it("a template created before this field existed reads back with components: null", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const svc = new WhatsAppTemplateService(tx);
      const created = await svc.createTemplate(as(admin, Role.ADMIN), { name: `nocomp_${uid()}`, provider: "AISENSY", language: "en", body: "Plain" });
      assert.equal(created.components, null);
    });
  });
});

describe("deleting a template (local CRM record only - no provider delete API exists anywhere)", () => {
  it("ADMIN can delete a local draft; it is gone from the list and Activity records it with no lead", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const svc = new WhatsAppTemplateService(tx);
      const created = await svc.createTemplate(as(admin, Role.ADMIN), { name: `del_${uid()}`, provider: "AISENSY", language: "en", body: "Bye" });

      const result = await svc.deleteTemplate(as(admin, Role.ADMIN), created.id);
      assert.deepEqual(result, { id: created.id, deleted: true });

      await assert.rejects(() => svc.getTemplate(as(admin, Role.ADMIN), created.id), (e: any) => e.statusCode === 404);
      assert.equal(await tx.whatsAppTemplate.findUnique({ where: { id: created.id } }), null);

      // Filtered by this test's own actor - the shared dev DB may already hold other WHATSAPP_TEMPLATE_DELETED
      // activity rows from unrelated work, and referenceId is null (the template itself is gone), so this is the
      // only reliable way to find the row this test just created.
      const activity = await tx.activity.findFirst({ where: { referenceType: "WhatsAppTemplate", type: ActivityType.WHATSAPP_TEMPLATE_DELETED, actorId: admin.id }, select: { leadId: true, description: true, source: true } });
      assert.ok(activity);
      assert.equal(activity!.leadId, null);
      assert.equal(activity!.source, ActivitySource.USER);
      assert.match(activity!.description ?? "", /del_.*AISENSY/);
    });
  });

  it("the DELETE route is gated to ADMIN only, exactly like create/update/sync (RBAC lives at the route, not the service, for every template-admin action)", async () => {
    const routesSource = await readFile(new URL("./whatsapp.routes.ts", import.meta.url), "utf8");
    const deleteLine = routesSource.split("\n").find((l) => l.includes('router.delete("/templates/:id"'));
    assert.ok(deleteLine, "DELETE /templates/:id route must exist");
    assert.match(deleteLine!, /requireAuth/);
    assert.match(deleteLine!, /requireRole\(Role\.ADMIN\)/);
  });

  it("404s deleting a template that does not exist or was already deleted", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const svc = new WhatsAppTemplateService(tx);
      await assert.rejects(() => svc.deleteTemplate(as(admin, Role.ADMIN), randomUUID()), (e: any) => e.statusCode === 404);

      const created = await svc.createTemplate(as(admin, Role.ADMIN), { name: `twice_${uid()}`, provider: "AISENSY", language: "en", body: "Hi" });
      await svc.deleteTemplate(as(admin, Role.ADMIN), created.id);
      await assert.rejects(() => svc.deleteTemplate(as(admin, Role.ADMIN), created.id), (e: any) => e.statusCode === 404);
    });
  });

  it("refuses to delete a template a WhatsAppCampaign still references, with a clear message - never a raw FK error", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const svc = new WhatsAppTemplateService(tx);
      const created = await svc.createTemplate(as(admin, Role.ADMIN), { name: `camp_${uid()}`, provider: "AISENSY", language: "en", body: "Hi" });
      await tx.whatsAppCampaign.create({ data: { name: "Campaign A", templateId: created.id, filters: {}, createdById: admin.id } });

      await assert.rejects(
        () => svc.deleteTemplate(as(admin, Role.ADMIN), created.id),
        (e: any) => e.statusCode === 409 && /1 campaign/.test(e.message),
      );
      // The template is untouched - a blocked delete never partially deletes or corrupts anything.
      assert.ok(await tx.whatsAppTemplate.findUnique({ where: { id: created.id } }));
    });
  });

  it("deleting a template used only by messages/automation configs (never a campaign) succeeds - their history survives with templateId set to null", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Priya", mobile: "9876500000", normalizedMobile: "919876500000" }, select: { id: true } });
      const svc = new WhatsAppTemplateService(tx);
      const created = await svc.createTemplate(as(admin, Role.ADMIN), { name: `msg_${uid()}`, provider: "AISENSY", language: "en", body: "Hi" });
      const message = await tx.whatsAppMessage.create({
        data: { provider: "AISENSY", providerMessageId: `m-${uid()}`, direction: "OUTBOUND", messageType: "TEMPLATE", status: "SENT", leadId: lead.id, templateId: created.id, toNumber: "919876500000", normalizedContact: "+919876500000" },
        select: { id: true },
      });

      await svc.deleteTemplate(as(admin, Role.ADMIN), created.id);

      const survivingMessage = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: message.id }, select: { templateId: true } });
      assert.equal(survivingMessage.templateId, null);
    });
  });
});
