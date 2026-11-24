// WHICH VERSION IS RUNNING, for the public /api/health answer. Render sets RENDER_GIT_COMMIT to the commit it built; locally it is not set and the value is null.
// Only a plain commit hash is ever returned (7-40 hex characters): anything else in that variable is dropped rather than echoed, and nothing else from the environment is exposed.

export interface BuildInfo {
  gitCommit: string | null;
  environment: "production" | "development";
}

export function buildInfo(env: Record<string, string | undefined> = process.env): BuildInfo {
  const raw = (env.RENDER_GIT_COMMIT ?? "").trim().toLowerCase();
  return {
    gitCommit: /^[0-9a-f]{7,40}$/.test(raw) ? raw : null,
    environment: env.NODE_ENV === "production" ? "production" : "development",
  };
}
