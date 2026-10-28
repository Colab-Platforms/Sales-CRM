import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateLoginSchema } from "./auth.validators.js";

// The login contract of THIS backend is { username, password } (since "replace email with username"). An "Email is required" reply means a different/older backend answered.
describe("login request validation", () => {
  it("accepts username + password and normalises the username", () => {
    const r = validateLoginSchema({ username: "  Asha_01 ", password: "secret1" });
    assert.ok(!r.error);
    assert.deepEqual(r.value, { username: "asha_01", password: "secret1" });
  });
  it("rejects a missing or empty username", () => {
    for (const body of [{ password: "secret1" }, { username: "", password: "secret1" }, { username: "   ", password: "secret1" }]) assert.ok(validateLoginSchema(body).error, JSON.stringify(body));
  });
  it("rejects a missing or too-short password", () => {
    for (const body of [{ username: "asha" }, { username: "asha", password: "123" }]) assert.ok(validateLoginSchema(body).error, JSON.stringify(body));
  });
  it("rejects unexpected fields instead of ignoring them (the old email field, role, ...)", () => {
    for (const extra of [{ email: "a@b.com" }, { role: "ADMIN" }, { isAdmin: true }]) assert.ok(validateLoginSchema({ username: "asha", password: "secret1", ...extra }).error, JSON.stringify(extra));
  });
});
