import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { logger } from "./logger.js";

describe("logger.error", () => {
  it("prints only the message when no error is given (no trailing 'undefined' argument)", () => {
    const spy = mock.method(console, "error", () => {});
    try {
      logger.error("something failed");
      assert.equal(spy.mock.calls[0]!.arguments.length, 1);
      assert.match(String(spy.mock.calls[0]!.arguments[0]), /\[ERROR\] .*: something failed$/);
    } finally {
      spy.mock.restore();
    }
  });

  it("still passes an error through when one is given", () => {
    const spy = mock.method(console, "error", () => {});
    try {
      const err = new Error("boom");
      logger.error("something failed", err);
      assert.equal(spy.mock.calls[0]!.arguments.length, 2);
      assert.equal(spy.mock.calls[0]!.arguments[1], err);
    } finally {
      spy.mock.restore();
    }
  });
});
