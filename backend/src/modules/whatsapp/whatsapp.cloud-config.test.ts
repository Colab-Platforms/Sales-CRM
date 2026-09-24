import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "@/utils/apiError.js";
import type { DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import WhatsAppCloudConfigService from "./whatsapp.cloud-config.service.js";
import { validateCreateWhatsAppCloudConfigSchema } from "./whatsapp.cloud-config.validators.js";

const KEY = Buffer.alloc(32, 5).toString("base64");
const ADMIN: AuthUser = { id: "user-1", role: Role.ADMIN, email: "admin@example.com" };

// A minimal in-memory stand-in for the two Prisma delegates this service actually touches
// (whatsAppConfig, activity) - enough to exercise create/get/reset/test without a real database.
function fakeDb() {
  const configs: any[] = [];
  const activities: any[] = [];
  const db = {
    whatsAppConfig: {
      async findFirst({ orderBy }: any = {}) {
        if (configs.length === 0) return null;
        return [...configs].sort((a, b) => (orderBy?.createdAt === "desc" ? b.createdAt - a.createdAt : 0))[0];
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
        const idx = configs.findIndex((c) => c.id === where.id);
        configs.splice(idx, 1);
      },
    },
    activity: {
      async create({ data }: any) {
        activities.push(data);
        return data;
      },
    },
  } as unknown as DbClient;
  return { db, configs, activities };
}

const credentials = { accessToken: "EAA-secret-token", appSecret: "app-secret", verifyToken: "verify-me" };

describe("WhatsApp Cloud API config validation", () => {
  it("accepts blank/omitted secrets at the schema level (the service decides whether they are required)", () => {
    const { error } = validateCreateWhatsAppCloudConfigSchema({ phoneNumberId: "1", businessAccountId: "2", credentials: { accessToken: "a", appSecret: "b" } });
    assert.equal(error, null);
  });

  it("rejects a malformed AI model name, an unsupported provider, and an empty phone number id", () => {
    const base = { phoneNumberId: "1", businessAccountId: "2", credentials };
    assert.ok(validateCreateWhatsAppCloudConfigSchema({ ...base, ai: { enabled: true, model: "../../etc/passwd" } }).error);
    assert.ok(validateCreateWhatsAppCloudConfigSchema({ ...base, ai: { enabled: true, provider: "anthropic" } }).error);
    assert.ok(validateCreateWhatsAppCloudConfigSchema({ ...base, phoneNumberId: "" }).error);
    assert.equal(validateCreateWhatsAppCloudConfigSchema({ ...base, ai: { enabled: true, provider: "gemini", model: "gemini-3.5-flash-lite" } }).error, null);
  });

  it("accepts a well-formed create request", () => {
    const { error, value } = validateCreateWhatsAppCloudConfigSchema({ phoneNumberId: "1", businessAccountId: "2", credentials });
    assert.equal(error, null);
    assert.equal(value.phoneNumberId, "1");
  });

  it("rejects an empty phoneNumberId/businessAccountId", () => {
    assert.ok(validateCreateWhatsAppCloudConfigSchema({ phoneNumberId: "", businessAccountId: "2", credentials }).error);
  });
});

describe("WhatsAppCloudConfigService", () => {
  it("reports not configured when no row exists", async () => {
    process.env.INTEGRATION_ENCRYPTION_KEY = KEY;
    const { db } = fakeDb();
    const service = new WhatsAppCloudConfigService(db);
    assert.equal((await service.getConfig()).configured, false);
  });

  it("creates a config, never returning the raw secrets, and records an audit Activity", async () => {
    process.env.INTEGRATION_ENCRYPTION_KEY = KEY;
    const { db, activities } = fakeDb();
    const service = new WhatsAppCloudConfigService(db);
    const result = await service.createConfig(ADMIN, { phoneNumberId: "123", businessAccountId: "456", credentials });

    assert.equal(result.phoneNumberId, "123");
    assert.equal(result.hasAccessToken, true);
    assert.equal(result.decryptable, true);
    assert.equal(JSON.stringify(result).includes("EAA-secret-token"), false);
    assert.equal(JSON.stringify(result).includes("app-secret"), false);
    assert.equal(activities.length, 1);
    assert.equal(activities[0].type, "WHATSAPP_CLOUD_CONFIG_CREATED");
    assert.equal(JSON.stringify(activities[0]).includes("EAA-secret-token"), false);
  });

  it("refuses to silently overwrite an existing config without confirmOverwrite", async () => {
    process.env.INTEGRATION_ENCRYPTION_KEY = KEY;
    const { db } = fakeDb();
    const service = new WhatsAppCloudConfigService(db);
    await service.createConfig(ADMIN, { phoneNumberId: "123", businessAccountId: "456", credentials });
    await assert.rejects(
      () => service.createConfig(ADMIN, { phoneNumberId: "999", businessAccountId: "999", credentials }),
      (err: unknown) => err instanceof ApiError && err.statusCode === 409,
    );
  });

  it("replaces the config when confirmOverwrite is true, and audits an update instead of a create", async () => {
    process.env.INTEGRATION_ENCRYPTION_KEY = KEY;
    const { db, activities } = fakeDb();
    const service = new WhatsAppCloudConfigService(db);
    await service.createConfig(ADMIN, { phoneNumberId: "123", businessAccountId: "456", credentials });
    const updated = await service.createConfig(ADMIN, { phoneNumberId: "999", businessAccountId: "999", credentials, confirmOverwrite: true });
    assert.equal(updated.phoneNumberId, "999");
    assert.equal(activities.at(-1).type, "WHATSAPP_CLOUD_CONFIG_UPDATED");
  });

  it("resets (deletes) an existing config and records an audit Activity", async () => {
    process.env.INTEGRATION_ENCRYPTION_KEY = KEY;
    const { db, configs, activities } = fakeDb();
    const service = new WhatsAppCloudConfigService(db);
    await service.createConfig(ADMIN, { phoneNumberId: "123", businessAccountId: "456", credentials });
    await service.resetConfig(ADMIN);
    assert.equal(configs.length, 0);
    assert.equal(activities.at(-1).type, "WHATSAPP_CLOUD_CONFIG_RESET");
    assert.equal((await service.getConfig()).configured, false);
  });

  it("throws 404 when resetting with nothing configured", async () => {
    const { db } = fakeDb();
    const service = new WhatsAppCloudConfigService(db);
    await assert.rejects(() => service.resetConfig(ADMIN), (err: unknown) => err instanceof ApiError && err.statusCode === 404);
  });

  it("surfaces a controlled 'cannot be decrypted' state instead of throwing when the encryption key has changed", async () => {
    process.env.INTEGRATION_ENCRYPTION_KEY = KEY;
    const { db } = fakeDb();
    const service = new WhatsAppCloudConfigService(db);
    await service.createConfig(ADMIN, { phoneNumberId: "123", businessAccountId: "456", credentials });

    // Simulate ENCRYPTION_KEY rotating/differing from what the row was encrypted with.
    process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    const result = await service.getConfig();
    assert.equal(result.configured, true);
    if (result.configured) {
      assert.equal(result.config.decryptable, false);
    }
    process.env.INTEGRATION_ENCRYPTION_KEY = KEY;
  });

  it("test connection reports the controlled decrypt-failure message rather than throwing, and audits it", async () => {
    process.env.INTEGRATION_ENCRYPTION_KEY = KEY;
    const { db, activities } = fakeDb();
    const service = new WhatsAppCloudConfigService(db);
    await service.createConfig(ADMIN, { phoneNumberId: "123", businessAccountId: "456", credentials });
    process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

    const result = await service.testConnection(ADMIN);
    assert.equal(result.success, false);
    assert.match(result.message, /cannot be decrypted/);
    assert.equal(activities.at(-1).type, "WHATSAPP_CLOUD_CONFIG_TESTED");
    assert.equal(JSON.stringify(activities.at(-1)).includes("EAA-secret-token"), false);
    process.env.INTEGRATION_ENCRYPTION_KEY = KEY;
  });

  it("credentials never appear anywhere in the JSON-serialized config row returned to a caller", async () => {
    process.env.INTEGRATION_ENCRYPTION_KEY = KEY;
    const { db } = fakeDb();
    const service = new WhatsAppCloudConfigService(db);
    const result = await service.createConfig(ADMIN, { phoneNumberId: "123", businessAccountId: "456", credentials });
    const serialized = JSON.stringify(result);
    for (const secret of [credentials.accessToken, credentials.appSecret, credentials.verifyToken]) {
      assert.equal(serialized.includes(secret), false, `${secret} must never appear in the API response`);
    }
  });
});
