// Graceful SIGTERM handling. Render (and most hosts) send SIGTERM on a redeploy / restart and kill the process after a grace period. Background work that was already started - for example the Daily Team Report
// released by a recipient's WhatsApp reply - is given a bounded time to finish; it is never waited for indefinitely, and this cannot promise that every in-flight delivery completes (a SIGKILL, a crash or a
// power loss still interrupt work, which is why interrupted report parts are recovered as UNCERTAIN on the next reply).

export type DrainResult = "drained" | "timeout";

/** Runs `work` and resolves "drained" when it finishes, or "timeout" after `timeoutMs` (the work is then left running; nothing waits for it). A failing `work` counts as drained - the caller only needs to know that it stopped. */
export async function drainWithin(work: () => Promise<unknown>, timeoutMs: number): Promise<DrainResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<DrainResult>((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    return await Promise.race([work().then(() => "drained" as const, () => "drained" as const), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ShutdownOptions {
  /** Stops accepting new connections (http.Server). In-flight requests finish. */
  server: { close: (callback?: (error?: Error) => void) => unknown };
  /** In-flight background work to wait for. */
  drain: () => Promise<unknown>;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the real process. */
  proc?: { once: (signal: "SIGTERM", handler: () => void) => unknown };
  exit?: (code: number) => void;
  log?: (message: string) => void;
}

/** Installs ONE SIGTERM handler (`once`, plus a re-entry guard, so a second signal or a second installation never runs the shutdown twice). */
export function installGracefulShutdown(options: ShutdownOptions): void {
  const { server, drain, timeoutMs = 10_000, proc = process, exit = (code: number) => process.exit(code), log = (m: string) => console.log(m) } = options;
  let started = false;
  proc.once("SIGTERM", () => {
    if (started) return;
    started = true;
    log("[shutdown] SIGTERM received: no new connections; waiting for in-flight WhatsApp work");
    try {
      server.close();
    } catch {
      /* already closed */
    }
    void drainWithin(drain, timeoutMs).then((result) => {
      log(result === "drained" ? "[shutdown] in-flight work finished" : `[shutdown] gave up waiting after ${timeoutMs} ms; exiting`);
      exit(0);
    });
  });
}
