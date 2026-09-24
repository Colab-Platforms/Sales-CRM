import "dotenv/config"; // the route modules pull in @/lib/jwt.js, which reads JWT_SECRET at load
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApiError } from "@/utils/apiError.js";
import { decryptJson, encryptJson } from "@/utils/crypto.js";
import type { DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import WhatsAppCloudConfigService, { DEFAULT_PUBLIC_BACKEND_URL, getWebhookUrl } from "./whatsapp.cloud-config.service.js";
import { resolveAIProvider } from "./whatsapp.ai.factory.js";
import { DEFAULT_GEMINI_MODEL } from "./whatsapp.ai.gemini.provider.js";
import whatsappRoutes from "./whatsapp.routes.js";
import metaWebhookRoutes from "./whatsapp.meta.webhook.routes.js";
import type { StoredWhatsAppCredentials } from "./whatsapp.cloud-config.types.js";

const KEY = Buffer.alloc(32, 11).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 12).toString("base64");
const ADMIN: AuthUser = { id: "admin-1", role: Role.ADMIN, email: "admin@example.com" };
const SECRETS = { accessToken: "EAA-meta-access-token-XYZ", appSecret: "meta-app-secret-XYZ", verifyToken: "verify-token-XYZ" };
const GEMINI_KEY = "AIza-gemini-secret-key-XYZ";
const ALL_SECRETS = [...Object.values(SECRETS), GEMINI_KEY];

function fakeDb() {
  const configs: any[] = [];
  const activities: any[] = [];
  const db = {
    whatsAppConfig: {
      async findFirst({ orderBy, where }: any = {}) {
        const rows = configs.filter((c) => !where || where.isActive === undefined || c.isActive === where.isActive);
        if (!rows.length) return null;
        return [...rows].sort((a, b) => (orderBy?.createdAt === "desc" ? b.createdAt - a.createdAt : 0))[0];
      },
      async create({ data, select }: any) {
        const row = { id: `cfg-${configs.length + 1}`, createdAt: new Date(configs.length), updatedAt: new Date(), ...data };
        configs.push(row);
        return select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row;
      },
      async update({ where, data, select }: any) {
        const row = configs.find((c) => c.id === where.id);
        Object.assign(row, data, { updatedAt: new Date() });
        return select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row;
      },
      async delete({ where }: any) {
        configs.splice(configs.findIndex((c) => c.id === where.id), 1);
      },
    },
    activity: { async create({ data }: any) { activities.push(data); return data; } },
  } as unknown as DbClient;
  return { db, configs, activities };
}

const useKey = (k: string) => { process.env.INTEGRATION_ENCRYPTION_KEY = k; };
const noSecrets = (text: string) => ALL_SECRETS.every((s) => !text.includes(s));
const BASE = { phoneNumberId: "111", businessAccountId: "222" };

describe("save configuration: Meta + AI, encrypted at rest", () => {
  it("stores every secret (Meta and Gemini) only inside one encrypted blob - no plaintext column or value", async () => {
    useKey(KEY);
    const { db, configs } = fakeDb();
    await new WhatsAppCloudConfigService(db).createConfig(ADMIN, { ...BASE, credentials: SECRETS, ai: { enabled: true, provider: "gemini", model: "gemini-3.5-flash-lite", geminiApiKey: GEMINI_KEY } });

    const row = configs[0];
    assert.equal(typeof row.credentials, "string");
    assert.ok(noSecrets(JSON.stringify(row)), "no secret appears anywhere in the stored row");
    const decrypted = decryptJson<StoredWhatsAppCredentials>(row.credentials);
    assert.deepEqual(decrypted, { ...SECRETS, ai: { enabled: true, provider: "gemini", model: "gemini-3.5-flash-lite", geminiApiKey: GEMINI_KEY } });
  });

  it("uses the existing integration encryption: a different INTEGRATION_ENCRYPTION_KEY cannot read it", async () => {
    useKey(KEY);
    const { db, configs } = fakeDb();
    await new WhatsAppCloudConfigService(db).createConfig(ADMIN, { ...BASE, credentials: SECRETS });
    useKey(OTHER_KEY);
    assert.throws(() => decryptJson(configs[0].credentials));
    useKey(KEY);
  });

  it("the API response is masked: booleans and non-secret AI settings only, never a secret", async () => {
    useKey(KEY);
    const { db } = fakeDb();
    const service = new WhatsAppCloudConfigService(db);
    const saved = await service.createConfig(ADMIN, { ...BASE, credentials: SECRETS, ai: { enabled: true, model: "gemini-x", geminiApiKey: GEMINI_KEY } });
    for (const surface of [JSON.stringify(saved), JSON.stringify(await service.getConfig())]) assert.ok(noSecrets(surface));
    assert.equal(saved.hasAccessToken, true);
    assert.equal(saved.hasAppSecret, true);
    assert.equal(saved.hasWebhookVerifyToken, true);
    assert.equal(saved.hasGeminiApiKey, true);
    assert.equal(saved.aiEnabled, true);
    assert.equal(saved.aiProvider, "gemini");
    assert.equal(saved.aiModel, "gemini-x");
    assert.equal(saved.decryptable, true);
  });

  it("the audit trail records field names and the AI toggle - never a value", async () => {
    useKey(KEY);
    const { db, activities } = fakeDb();
    await new WhatsAppCloudConfigService(db).createConfig(ADMIN, { ...BASE, credentials: SECRETS, ai: { enabled: true, geminiApiKey: GEMINI_KEY } });
    assert.ok(noSecrets(JSON.stringify(activities)));
    assert.match(activities[0].description, /geminiApiKey/);
    assert.match(activities[0].description, /AI enabled/);
  });

  it("a new config requires all three Meta secrets", async () => {
    useKey(KEY);
    const { db } = fakeDb();
    await assert.rejects(
      () => new WhatsAppCloudConfigService(db).createConfig(ADMIN, { ...BASE, credentials: { accessToken: "a", appSecret: "b" } }),
      (err: unknown) => err instanceof ApiError && err.statusCode === 400 && /verifyToken is required/.test(err.message),
    );
  });

  it("replacing a config with blank secrets keeps the stored Meta and Gemini secrets", async () => {
    useKey(KEY);
    const { db, configs } = fakeDb();
    const service = new WhatsAppCloudConfigService(db);
    await service.createConfig(ADMIN, { ...BASE, credentials: SECRETS, ai: { enabled: true, geminiApiKey: GEMINI_KEY } });
    const updated = await service.createConfig(ADMIN, { phoneNumberId: "333", businessAccountId: "444", credentials: {}, ai: { enabled: false, model: "gemini-y" }, confirmOverwrite: true });

    assert.equal(updated.phoneNumberId, "333");
    assert.equal(updated.aiEnabled, false);
    const stored = decryptJson<StoredWhatsAppCredentials>(configs[0].credentials);
    assert.deepEqual({ ...stored, ai: undefined }, { ...SECRETS, ai: undefined });
    assert.equal(stored.ai?.geminiApiKey, GEMINI_KEY, "the Gemini key survives an AI toggle");
    assert.equal(stored.ai?.model, "gemini-y");
  });

  it("a supplied secret replaces only that secret", async () => {
    useKey(KEY);
    const { db, configs } = fakeDb();
    const service = new WhatsAppCloudConfigService(db);
    await service.createConfig(ADMIN, { ...BASE, credentials: SECRETS });
    await service.createConfig(ADMIN, { ...BASE, credentials: { accessToken: "NEW-TOKEN" }, confirmOverwrite: true });
    const stored = decryptJson<StoredWhatsAppCredentials>(configs[0].credentials);
    assert.equal(stored.accessToken, "NEW-TOKEN");
    assert.equal(stored.appSecret, SECRETS.appSecret);
  });

  it("enabling AI with no Gemini key anywhere (saved or server env) is rejected", async () => {
    useKey(KEY);
    const previous = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const { db } = fakeDb();
      await assert.rejects(
        () => new WhatsAppCloudConfigService(db).createConfig(ADMIN, { ...BASE, credentials: SECRETS, ai: { enabled: true } }),
        (err: unknown) => err instanceof ApiError && err.statusCode === 400 && /Gemini API key/.test(err.message),
      );
    } finally {
      if (previous !== undefined) process.env.GEMINI_API_KEY = previous;
    }
  });
});

describe("reset configuration after an undecryptable ('Stored token can't be decrypted') config", () => {
  it("shows the controlled state, cannot keep blank secrets, and reset + save works with the current key", async () => {
    useKey(KEY);
    const { db, configs, activities } = fakeDb();
    const service = new WhatsAppCloudConfigService(db);
    await service.createConfig(ADMIN, { ...BASE, credentials: SECRETS, ai: { enabled: true, geminiApiKey: GEMINI_KEY } });

    useKey(OTHER_KEY); // the integration key changed after the row was saved
    const state = await service.getConfig();
    assert.equal(state.configured, true);
    if (state.configured) {
      assert.equal(state.config.decryptable, false);
      assert.equal(state.config.aiEnabled, false, "nothing about the AI settings is guessed when unreadable");
    }
    const test = await service.testConnection(ADMIN);
    assert.equal(test.success, false);
    assert.match(test.message, /cannot be decrypted/);

    // Blank secrets cannot "keep" what can't be read.
    await assert.rejects(() => service.createConfig(ADMIN, { ...BASE, credentials: {}, confirmOverwrite: true }), (e: unknown) => e instanceof ApiError && e.statusCode === 400);

    await service.resetConfig(ADMIN);
    assert.equal(configs.length, 0);
    assert.equal(activities.at(-1).type, "WHATSAPP_CLOUD_CONFIG_RESET");

    const fresh = await service.createConfig(ADMIN, { ...BASE, credentials: SECRETS });
    assert.equal(fresh.decryptable, true, "re-saved under the current key");
    assert.deepEqual(decryptJson<StoredWhatsAppCredentials>(configs[0].credentials), SECRETS);
    useKey(KEY);
  });

  it("overwriting an undecryptable config with a full set of secrets also recovers it", async () => {
    useKey(KEY);
    const { db } = fakeDb();
    const service = new WhatsAppCloudConfigService(db);
    await service.createConfig(ADMIN, { ...BASE, credentials: SECRETS });
    useKey(OTHER_KEY);
    const recovered = await service.createConfig(ADMIN, { ...BASE, credentials: SECRETS, confirmOverwrite: true });
    assert.equal(recovered.decryptable, true);
    useKey(KEY);
  });
});

describe("Meta connection test (Graph API mocked)", () => {
  const graphResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  async function setup() {
    useKey(KEY);
    const { db, activities } = fakeDb();
    const service = new WhatsAppCloudConfigService(db);
    await service.createConfig(ADMIN, { ...BASE, credentials: SECRETS });
    return { service, activities };
  }

  it("verifies the credentials against Graph and returns only safe details (number, verified name, account name)", async () => {
    const { service, activities } = await setup();
    const calls: { url: string; auth: string }[] = [];
    const spy = mock.method(globalThis, "fetch", async (input: any, init: any) => {
      const url = String(input);
      calls.push({ url, auth: new Headers(init.headers).get("authorization") ?? "" });
      return url.includes("/111?") ? graphResponse(200, { display_phone_number: "+91 98765 43210", verified_name: "Aayush Wellness" }) : graphResponse(200, { name: "Aayush WABA" });
    });
    try {
      const result = await service.testConnection(ADMIN);
      assert.deepEqual(result, { success: true, message: "Connected", displayPhoneNumber: "+91 98765 43210", verifiedName: "Aayush Wellness", businessAccountName: "Aayush WABA" });
      assert.ok(calls.every((c) => c.url.startsWith("https://graph.facebook.com/") && c.auth === `Bearer ${SECRETS.accessToken}`));
      assert.ok(calls.some((c) => c.url.includes("/111?")) && calls.some((c) => c.url.includes("/222?")), "phone number and WABA were both checked");
      assert.ok(noSecrets(JSON.stringify(result)) && noSecrets(JSON.stringify(activities)));
      assert.equal(activities.at(-1).type, "WHATSAPP_CLOUD_CONFIG_TESTED");
    } finally {
      spy.mock.restore();
    }
  });

  it("is still 'Connected' when only the WABA lookup is refused", async () => {
    const { service } = await setup();
    const spy = mock.method(globalThis, "fetch", async (input: any) => (String(input).includes("/111?") ? graphResponse(200, { display_phone_number: "+91 1", verified_name: "N" }) : graphResponse(403, { error: { code: 10 } })));
    try {
      const result = await service.testConnection(ADMIN);
      assert.equal(result.success, true);
      assert.equal(result.businessAccountName, undefined);
    } finally {
      spy.mock.restore();
    }
  });

  it("a rejected token reports only the HTTP status and Meta's error code - not Meta's message, not the token", async () => {
    const { service } = await setup();
    const spy = mock.method(globalThis, "fetch", async () => graphResponse(401, { error: { code: 190, message: `Invalid OAuth access token ${SECRETS.accessToken}` } }));
    try {
      const result = await service.testConnection(ADMIN);
      assert.equal(result.success, false);
      assert.match(result.message, /HTTP 401, code 190/);
      assert.ok(noSecrets(JSON.stringify(result)));
    } finally {
      spy.mock.restore();
    }
  });

  it("a network failure gives a generic message even if the error text contains the token", async () => {
    const { service, activities } = await setup();
    const spy = mock.method(globalThis, "fetch", async () => { throw new Error(`connect failed for ${SECRETS.accessToken}`); });
    try {
      const result = await service.testConnection(ADMIN);
      assert.equal(result.success, false);
      assert.ok(noSecrets(JSON.stringify(result)) && noSecrets(JSON.stringify(activities)));
    } finally {
      spy.mock.restore();
    }
  });

  it("404s when nothing is configured", async () => {
    const { db } = fakeDb();
    await assert.rejects(() => new WhatsAppCloudConfigService(db).testConnection(ADMIN), (e: unknown) => e instanceof ApiError && e.statusCode === 404);
  });
});

describe("Gemini configuration (Settings screen first, environment as fallback)", () => {
  const dbWith = (blob: unknown | null) =>
    ({ whatsAppConfig: { async findFirst() { return blob === null ? null : { credentials: blob }; } } }) as unknown as DbClient;
  const saved = (ai: StoredWhatsAppCredentials["ai"]) => { useKey(KEY); return encryptJson({ ...SECRETS, ...(ai ? { ai } : {}) }); };
  const modelOf = (p: unknown) => (p as { model: string }).model;

  it("uses the saved key and model when AI is enabled on the screen", async () => {
    const provider = await resolveAIProvider(dbWith(saved({ enabled: true, provider: "gemini", model: "gemini-custom", geminiApiKey: GEMINI_KEY })), {});
    assert.equal(provider?.name, "gemini");
    assert.equal(modelOf(provider), "gemini-custom");
  });

  it("defaults the model to gemini-3.5-flash-lite", async () => {
    const provider = await resolveAIProvider(dbWith(saved({ enabled: true, provider: "gemini", geminiApiKey: GEMINI_KEY })), {});
    assert.equal(modelOf(provider), DEFAULT_GEMINI_MODEL);
    assert.equal(DEFAULT_GEMINI_MODEL, "gemini-3.5-flash-lite");
  });

  it("AI disabled on the screen means no AI - even when the server has a key", async () => {
    assert.equal(await resolveAIProvider(dbWith(saved({ enabled: false, provider: "gemini", geminiApiKey: GEMINI_KEY })), { GEMINI_API_KEY: "env-key" }), null);
  });

  it("enabled without a saved key falls back to the server's GEMINI_API_KEY/GEMINI_MODEL, or nothing", async () => {
    const blob = saved({ enabled: true, provider: "gemini" });
    assert.equal(modelOf(await resolveAIProvider(dbWith(blob), { GEMINI_API_KEY: "env-key", GEMINI_MODEL: "env-model" })), "env-model");
    assert.equal(await resolveAIProvider(dbWith(blob), {}), null);
  });

  it("with nothing saved on the screen, the environment decides (AI_PROVIDER / GEMINI_API_KEY)", async () => {
    assert.equal((await resolveAIProvider(dbWith(null), { AI_PROVIDER: "gemini", GEMINI_API_KEY: "env-key" }))?.name, "gemini");
    assert.equal(await resolveAIProvider(dbWith(null), { AI_PROVIDER: "none", GEMINI_API_KEY: "env-key" }), null);
    assert.equal(await resolveAIProvider(dbWith(saved(undefined)), { GEMINI_API_KEY: "env-key" }).then((p) => p?.name), "gemini");
  });

  it("an unreadable saved config never breaks replies - it falls back to the environment", async () => {
    const blob = saved({ enabled: true, provider: "gemini", geminiApiKey: GEMINI_KEY });
    useKey(OTHER_KEY);
    assert.equal((await resolveAIProvider(dbWith(blob), { GEMINI_API_KEY: "env-key" }))?.name, "gemini");
    assert.equal(await resolveAIProvider(dbWith(blob), {}), null);
    useKey(KEY);
  });
});

describe("webhook URL and mounting", () => {
  it("defaults to the production Render callback URL", () => {
    assert.equal(DEFAULT_PUBLIC_BACKEND_URL, "https://sales-crm-3pan.onrender.com");
    assert.equal(getWebhookUrl({}), "https://sales-crm-3pan.onrender.com/api/webhooks/whatsapp-cloud");
  });

  it("follows PUBLIC_BACKEND_URL (trailing slash tolerated) for another deployment", () => {
    assert.equal(getWebhookUrl({ PUBLIC_BACKEND_URL: "https://crm.example.com/" }), "https://crm.example.com/api/webhooks/whatsapp-cloud");
  });

  it("is included in the config response whether or not anything is configured", async () => {
    const previous = process.env.PUBLIC_BACKEND_URL;
    delete process.env.PUBLIC_BACKEND_URL;
    try {
      useKey(KEY);
      const { db } = fakeDb();
      const service = new WhatsAppCloudConfigService(db);
      const empty = await service.getConfig();
      assert.equal(empty.webhookUrl, "https://sales-crm-3pan.onrender.com/api/webhooks/whatsapp-cloud");
      assert.equal(empty.defaultAiModel, "gemini-3.5-flash-lite");
      await service.createConfig(ADMIN, { ...BASE, credentials: SECRETS });
      assert.equal((await service.getConfig()).webhookUrl, empty.webhookUrl);
    } finally {
      if (previous !== undefined) process.env.PUBLIC_BACKEND_URL = previous;
    }
  });

  it("server.ts mounts the Meta webhook router at /api/webhooks/whatsapp-cloud with the raw-body parser", () => {
    const source = readFileSync(fileURLToPath(new URL("../../server.ts", import.meta.url)), "utf8");
    assert.match(source, /app\.use\("\/api\/webhooks\/whatsapp-cloud", express\.raw\(\{ type: "\*\/\*", limit: "5mb" \}\), whatsappMetaWebhookRoutes\)/);
  });

  it("the webhook router answers both GET (verification) and POST (deliveries) at its root", () => {
    const routes = (metaWebhookRoutes as any).stack.filter((l: any) => l.route).map((l: any) => ({ path: l.route.path, methods: Object.keys(l.route.methods) }));
    assert.deepEqual(routes.filter((r: any) => r.path === "/").flatMap((r: any) => r.methods).sort(), ["get", "post"]);
  });
});

describe("RBAC: configuration routes are admin-only", () => {
  const layers = (whatsappRoutes as any).stack.filter((l: any) => l.route && l.route.path.startsWith("/cloud-config"));
  const roleGate = (route: any) => route.stack[1].handle; // [requireAuth, requireRole(ADMIN), controller]
  const run = (gate: (req: any, res: any, next: (e?: unknown) => void) => void, role: Role | null) => {
    let forwarded: any;
    gate(role ? { user: { id: "u", role, email: "x@y.z" } } : {}, {}, (e) => { forwarded = e; });
    return forwarded;
  };

  it("exposes exactly GET/POST /cloud-config, POST /cloud-config/test and DELETE /cloud-config", () => {
    const seen = layers.map((l: any) => `${Object.keys(l.route.methods)[0]!.toUpperCase()} ${l.route.path}`).sort();
    assert.deepEqual(seen, ["DELETE /cloud-config", "GET /cloud-config", "POST /cloud-config", "POST /cloud-config/test"]);
  });

  it("every one rejects a salesperson, a manager and an unauthenticated caller (403) and admits an admin", () => {
    for (const layer of layers) {
      assert.equal(layer.route.stack.length, 3, "auth + role gate + controller");
      const gate = roleGate(layer.route);
      for (const role of [Role.SALESPERSON, Role.MANAGER, null]) {
        const err = run(gate, role);
        assert.ok(err instanceof ApiError && err.statusCode === 403, `${layer.route.path} must reject ${role ?? "anonymous"}`);
      }
      assert.equal(run(gate, Role.ADMIN), undefined);
    }
  });
});
