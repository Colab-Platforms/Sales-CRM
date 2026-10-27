import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AuthUser } from "@/middlewares/auth.js";
import type { DbClient } from "@/lib/leadScope.js";
import { Role } from "../../../generated/prisma/enums.js";
import WhatsAppTemplateService from "../whatsapp/whatsapp.template.service.js";
import type { NormalizedTemplate, WhatsAppProvider } from "../whatsapp/whatsapp.provider.js";
import { addPickerTemplate, listPickerTemplates } from "./report-automation.template-picker.js";
import { classifyReportTemplates, planTemplateParams } from "./report-automation.sender.js";
import { STRUCTURED_TEMPLATE_VARIABLES } from "./report-automation.template-metrics.js";

type Row = Record<string, any>;
const admin = { id: "a1", role: Role.ADMIN } as AuthUser;
const manager = { id: "m1", role: Role.MANAGER } as AuthUser;
const BODY_STRUCTURED = STRUCTURED_TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(" ");

const meta = (name: string, language: string, status: NormalizedTemplate["status"], body: string, category: string | null = "UTILITY"): NormalizedTemplate => ({ providerTemplateId: `${name}-${language}`, externalId: null, name, category, language, body, status, quality: null });

function setup(list: NormalizedTemplate[] | Error, seed: Row[] = []) {
  const rows: Row[] = [...seed];
  const activities: Row[] = [];
  const db = {
    whatsAppTemplate: {
      findMany: async () => rows.map((r) => ({ name: r.name, language: r.language })),
      findUnique: async ({ where }: Row) => {
        const k = where.provider_name_language ?? where.provider_providerTemplateId;
        return rows.find((r) => (where.provider_name_language ? r.provider === k.provider && r.name === k.name && r.language === k.language : r.provider === k.provider && r.providerTemplateId === k.providerTemplateId)) ?? null;
      },
      create: async ({ data }: Row) => {
        if (rows.some((r) => r.provider === data.provider && r.name === data.name && r.language === data.language)) throw Object.assign(new Error("dup"), { code: "P2002" });
        const r = { id: `t${rows.length + 1}`, ...data }; rows.push(r); return r;
      },
      update: async ({ where, data }: Row) => Object.assign(rows.find((r) => r.id === where.id)!, data),
    },
    activity: { create: async ({ data }: Row) => { activities.push(data); return data; } },
  } as unknown as DbClient;
  let calls = 0;
  const provider = { id: "META", listTemplates: async () => { calls++; if (list instanceof Error) throw list; return { supported: true, templates: list }; } } as unknown as WhatsAppProvider;
  const svc = new WhatsAppTemplateService(db, () => null, async () => provider);
  return { svc, rows, activities, calls: () => calls };
}

const META_LIST = [
  meta("daily_team_report1", "en", "APPROVED", "*Report* {{report_text}}"),
  meta("daily_team_report2", "en", "APPROVED", BODY_STRUCTURED),
  meta("daily_team_report2", "hi", "APPROVED", BODY_STRUCTURED),
  meta("daily_team_report3", "en", "PENDING", BODY_STRUCTURED),
  meta("daily_team_report4", "en", "REJECTED", BODY_STRUCTURED),
  meta("webinar_feedback_form", "en", "APPROVED", "Hi {{name}}", "MARKETING"),
  meta("daily_team_report5", "en", "APPROVED", "{{a}} {{b}}"),
];

describe("Add Template picker: Meta's approved list", () => {
  it("lists only APPROVED templates, with Meta's own name, language, category and variables", async () => {
    const { svc } = setup(META_LIST);
    const list = await listPickerTemplates(admin, svc);
    assert.deepEqual(list.map((t) => `${t.name}/${t.language}`), ["daily_team_report1/en", "daily_team_report2/en", "daily_team_report2/hi", "webinar_feedback_form/en", "daily_team_report5/en"]);
    const t2 = list.find((t) => t.name === "daily_team_report2" && t.language === "hi")!;
    assert.equal(t2.category, "UTILITY");
    assert.deepEqual(t2.variables, [...STRUCTURED_TEMPLATE_VARIABLES]);
    assert.equal(list.find((t) => t.name === "webinar_feedback_form")!.category, "MARKETING");
  });

  it("marks templates the report cannot send, with the reason", async () => {
    const list = await listPickerTemplates(admin, setup(META_LIST).svc);
    const by = (n: string) => list.find((t) => t.name === n)!;
    assert.equal(by("daily_team_report2").compatible, true);
    assert.equal(by("daily_team_report1").compatible, true);
    assert.equal(by("webinar_feedback_form").compatible, false);
    assert.match(by("webinar_feedback_form").incompatibleReason!, /starts with "daily_team_report"/);
    assert.equal(by("daily_team_report5").compatible, false);
    assert.match(by("daily_team_report5").incompatibleReason!, /2 variables/);
  });

  it("flags templates already registered for that provider, name and language", async () => {
    const { svc } = setup(META_LIST, [{ id: "x", provider: "META", name: "daily_team_report1", language: "en", providerTemplateId: "daily_team_report1-en" }]);
    const list = await listPickerTemplates(admin, svc);
    assert.deepEqual(list.filter((t) => t.alreadyAdded).map((t) => `${t.name}/${t.language}`), ["daily_team_report1/en"]);
  });

  it("is Admin only", async () => {
    const { svc, calls } = setup(META_LIST);
    await assert.rejects(listPickerTemplates(manager, svc), (e: any) => e.statusCode === 403);
    await assert.rejects(addPickerTemplate(manager, svc, "daily_team_report2", "en"), (e: any) => e.statusCode === 403);
    assert.equal(calls(), 0);
  });
});

describe("Add Template picker: adding", () => {
  it("adds the chosen template with Meta's own data, status and variables, and it becomes selectable", async () => {
    const { svc, rows, activities } = setup(META_LIST);
    const r = await addPickerTemplate(admin, svc, "daily_team_report2", "hi");
    assert.equal(r.alreadyAdded, false);
    assert.equal(rows.length, 1);
    assert.deepEqual({ name: rows[0]!.name, language: rows[0]!.language, category: rows[0]!.category, status: rows[0]!.status, provider: rows[0]!.provider, providerTemplateId: rows[0]!.providerTemplateId }, { name: "daily_team_report2", language: "hi", category: "UTILITY", status: "APPROVED", provider: "META", providerTemplateId: "daily_team_report2-hi" });
    assert.deepEqual(rows[0]!.variables, [...STRUCTURED_TEMPLATE_VARIABLES]);
    assert.equal(activities.length, 1);
    assert.deepEqual(classifyReportTemplates(rows as any).usable.map((t) => `${t.name}/${t.language}`), ["daily_team_report2/hi"]);
  });

  it("does not create a duplicate: a second Add reports Already added", async () => {
    const { svc, rows } = setup(META_LIST);
    await addPickerTemplate(admin, svc, "daily_team_report1", "en");
    const again = await addPickerTemplate(admin, svc, "daily_team_report1", "en");
    assert.equal(again.alreadyAdded, true);
    assert.equal(rows.length, 1);
    await addPickerTemplate(admin, svc, "daily_team_report2", "en"); // same name, other language is separate
    await addPickerTemplate(admin, svc, "daily_team_report2", "hi");
    assert.equal(rows.length, 3);
  });

  it("refuses anything Meta does not list as APPROVED, and anything the sender cannot send", async () => {
    const { svc, rows } = setup(META_LIST);
    await assert.rejects(addPickerTemplate(admin, svc, "daily_team_report3", "en"), (e: any) => e.statusCode === 404); // PENDING
    await assert.rejects(addPickerTemplate(admin, svc, "daily_team_report4", "en"), (e: any) => e.statusCode === 404); // REJECTED
    await assert.rejects(addPickerTemplate(admin, svc, "made_up_template", "en"), (e: any) => e.statusCode === 404);
    await assert.rejects(addPickerTemplate(admin, svc, "daily_team_report2", "fr"), (e: any) => e.statusCode === 404); // wrong language
    await assert.rejects(addPickerTemplate(admin, svc, "webinar_feedback_form", "en"), (e: any) => e.statusCode === 400);
    await assert.rejects(addPickerTemplate(admin, svc, "daily_team_report5", "en"), (e: any) => e.statusCode === 400);
    assert.equal(rows.length, 0);
  });

  it("leaves existing templates and their configuration untouched", async () => {
    const old = { id: "old", provider: "META", name: "daily_team_report1", language: "en", providerTemplateId: "daily_team_report1-en", status: "APPROVED", variables: ["report_text"], body: "kept" };
    const { svc, rows } = setup(META_LIST, [{ ...old }]);
    await addPickerTemplate(admin, svc, "daily_team_report1", "en");
    await addPickerTemplate(admin, svc, "daily_team_report2", "en");
    assert.deepEqual(rows[0], old);
  });
});

describe("Add Template picker: Meta failures", () => {
  it("a Meta timeout is reported and nothing is written; a later Retry works", async () => {
    const down = setup(new Error("Meta request timed out"));
    await assert.rejects(listPickerTemplates(admin, down.svc), /timed out/);
    await assert.rejects(addPickerTemplate(admin, down.svc, "daily_team_report2", "en"), /timed out/);
    assert.equal(down.rows.length, 0);
    const up = setup(META_LIST);
    assert.ok((await listPickerTemplates(admin, up.svc)).length > 0);
  });

  it("explains when Meta listing is not configured", async () => {
    const db = { whatsAppTemplate: { findMany: async () => [] } } as unknown as DbClient;
    const svc = new WhatsAppTemplateService(db, () => null, async () => null);
    await assert.rejects(listPickerTemplates(admin, svc), (e: any) => e.statusCode === 503 && /not configured/.test(e.message));
  });
});

describe("sender compatibility of an added template", () => {
  it("sends a structured template's own variables by name, and report_text as the single text", async () => {
    const stored = [...STRUCTURED_TEMPLATE_VARIABLES]; // as the sync stores them (order of appearance)
    const values = Object.fromEntries(stored.map((v, i) => [v, String(i)])) as any;
    const p = await planTemplateParams({ name: "daily_team_report2", variables: stored }, "text", async () => values);
    assert.deepEqual(p.paramNames, stored);
    assert.deepEqual(p.params, stored.map((_, i) => String(i)));
    assert.deepEqual(await planTemplateParams({ name: "daily_team_report1", variables: ["report_text"] }, "hello"), { params: ["hello"], paramNames: ["report_text"] });
  });
});
