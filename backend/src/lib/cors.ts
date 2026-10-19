import type { CorsOptions } from "cors";

type Env = Record<string, string | undefined>;

/**
 * The browser origins allowed to call the API: FRONTEND_URL exactly as before (with and without a trailing slash), plus an OPTIONAL comma-separated CORS_ALLOWED_ORIGINS for extra EXACT origins
 * (for example http://localhost:3000 while a developer uses the deployed API). Nothing is allowed by default. Each extra entry must be a bare http(s) origin (scheme + host [+ port], no path), and
 * "*" or anything malformed is ignored - credentials are enabled, so a wildcard must never be possible.
 */
export function parseAllowedOrigins(env: Env = process.env): string[] {
  const allowed = new Set<string>();
  const frontend = (env.FRONTEND_URL ?? "").trim();
  if (frontend) {
    allowed.add(frontend);
    allowed.add(frontend.replace(/\/$/, ""));
  }
  for (const raw of (env.CORS_ALLOWED_ORIGINS ?? "").split(",")) {
    const value = raw.trim().replace(/\/+$/, "");
    if (!value || value === "*") continue;
    try {
      const url = new URL(value);
      if ((url.protocol === "http:" || url.protocol === "https:") && url.origin === value) allowed.add(value);
    } catch {
      // not a URL: ignored
    }
  }
  return [...allowed];
}

export function createCorsOptions(env: Env = process.env, log: (message: string, origin: string) => void = (m, o) => console.log(m, o)): CorsOptions {
  const allowedOrigins = parseAllowedOrigins(env);
  return {
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      log("Origin not allowed by CORS:", origin);
      // A refusal, not a server fault: 403 (it used to surface as an unhandled error, i.e. HTTP 500). The browser still gets no CORS headers and blocks the call.
      callback(Object.assign(new Error("Not allowed by CORS"), { statusCode: 403 }));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
  };
}
