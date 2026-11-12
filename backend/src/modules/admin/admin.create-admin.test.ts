import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateCreateAdminSchema } from "./admin.validators.js";
import adminRouter from "./admin.routes.js";

const valid = { name: "Asha Rao", username: "Asha.Rao", email: " Asha@Example.com ", password: "secret1", phone: "9876543210" };

describe("validateCreateAdminSchema", () => {
  it("accepts a valid body and normalises username/email", () => {
    const r = validateCreateAdminSchema(valid);
    assert.ok(!r.error);
    assert.equal(r.value?.username, "asha.rao");
    assert.equal(r.value?.email, "asha@example.com");
  });
  it("rejects missing required fields", () => {
    for (const key of Object.keys(valid)) {
      const { [key]: _omit, ...rest } = valid as Record<string, string>;
      assert.ok(validateCreateAdminSchema(rest).error, `missing ${key}`);
    }
  });
  it("rejects bad email, short password and short phone", () => {
    assert.ok(validateCreateAdminSchema({ ...valid, email: "not-an-email" }).error);
    assert.ok(validateCreateAdminSchema({ ...valid, password: "123" }).error);
    assert.ok(validateCreateAdminSchema({ ...valid, phone: "123" }).error);
  });
  it("rejects a client-supplied role or other extra field", () => {
    for (const extra of [{ role: "ADMIN" }, { role: "SUPERADMIN" }, { isAdmin: true }]) {
      assert.ok(validateCreateAdminSchema({ ...valid, ...extra }).error, JSON.stringify(extra));
    }
  });
});

describe("admin routes", () => {
  const layers = (adminRouter as unknown as { stack: { route?: { path: string; methods: Record<string, boolean>; stack: { name: string; handle: unknown }[] } }[] }).stack;
  const find = (path: string, method: string) => layers.find((l) => l.route?.path === path && l.route.methods[method])?.route;

  it("registers POST and GET /admins behind one role guard (not the ADMIN+HR guard used elsewhere)", () => {
    const post = find("/admins", "post");
    assert.ok(post && find("/admins", "get"));
    assert.equal(post.stack.length, 2); // role guard + handler
    // the HR-allowed route /salespersons has a different guard instance than /admins
    const spGuard = find("/salespersons", "post")!.stack[0]!.handle;
    assert.notEqual(post.stack[0]!.handle, spGuard);
  });
});
