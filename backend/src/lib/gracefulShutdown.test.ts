import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { drainWithin, installGracefulShutdown } from "./gracefulShutdown.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("graceful shutdown", () => {
  it("drainWithin: waits for work that finishes in time, gives up (without waiting for the work) when it does not, and treats a failing job as stopped", async () => {
    let done = false;
    assert.equal(await drainWithin(async () => { await sleep(20); done = true; }, 500), "drained");
    assert.equal(done, true);
    const started = Date.now();
    assert.equal(await drainWithin(() => new Promise(() => undefined), 40), "timeout");
    assert.ok(Date.now() - started < 400, "did not wait for the never-ending work");
    assert.equal(await drainWithin(async () => { throw new Error("boom"); }, 500), "drained");
  });

  it("SIGTERM: stops taking connections, waits for in-flight work, then exits 0 - once, even if the signal repeats", async () => {
    const proc = new EventEmitter();
    const calls = { close: 0, drain: 0, exit: [] as number[], logs: [] as string[] };
    let finish!: () => void;
    installGracefulShutdown({
      server: { close: () => { calls.close++; } },
      drain: () => { calls.drain++; return new Promise<void>((r) => { finish = r; }); },
      timeoutMs: 1000,
      proc: { once: (sig, handler) => proc.once(sig, handler) },
      exit: (code) => { calls.exit.push(code); },
      log: (m) => calls.logs.push(m),
    });
    proc.emit("SIGTERM");
    proc.emit("SIGTERM"); // a second signal (or a second installation) does not run it again
    assert.deepEqual([calls.close, calls.drain, calls.exit], [1, 1, []], "exit waits for the in-flight work");
    finish();
    await sleep(20);
    assert.deepEqual(calls.exit, [0]);
    assert.match(calls.logs.join(" "), /in-flight work finished/);
    assert.equal(proc.listenerCount("SIGTERM"), 0, "registered with once(): no lingering handler");
  });

  it("SIGTERM with work that never finishes: exits after the timeout instead of hanging the shutdown", async () => {
    const proc = new EventEmitter();
    const exits: number[] = [];
    const logs: string[] = [];
    installGracefulShutdown({ server: { close: () => undefined }, drain: () => new Promise(() => undefined), timeoutMs: 30, proc: { once: (s, h) => proc.once(s, h) }, exit: (c) => exits.push(c), log: (m) => logs.push(m) });
    proc.emit("SIGTERM");
    await sleep(120);
    assert.deepEqual(exits, [0]);
    assert.match(logs.join(" "), /gave up waiting after 30 ms/);
  });
});
