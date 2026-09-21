import type { ShopifyConfig } from "./shopify.config.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_RETRY_WAIT_MS = 10_000;

export interface GraphQLErrorDetail {
  message: string;
  code: string | null;
  path: string | null;
  /** Access scopes Shopify says are missing, e.g. ["read_orders"]. */
  requiredScopes: string[];
}

export class ShopifyApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ShopifyApiError";
    this.status = status;
  }
}

export class ShopifyGraphQLError extends ShopifyApiError {
  readonly errors: GraphQLErrorDetail[];
  constructor(message: string, errors: GraphQLErrorDetail[]) {
    super(message, 200);
    this.name = "ShopifyGraphQLError";
    this.errors = errors;
  }

  get requiredScopes(): string[] {
    return [...new Set(this.errors.flatMap((e) => e.requiredScopes))];
  }
}

export interface ShopifyClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ShopifyClient {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly config: ShopifyConfig,
    options: ShopifyClientOptions = {},
  ) {
    this.endpoint = `https://${config.storeDomain}/admin/api/${config.apiVersion}/graphql.json`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Removes the access token (and anything shaped like one) from text that came from outside. */
  private redact(text: string): string {
    return text
      .split(this.config.accessToken)
      .join("[REDACTED]")
      .replace(/shp(?:at|ca|pa|ss)_[A-Za-z0-9]+/g, "[REDACTED]");
  }

  async query<T>(document: string, variables: Record<string, unknown> = {}): Promise<T> {
    let lastError: ShopifyApiError | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.send<T>(document, variables);
      } catch (error) {
        if (!(error instanceof RetryableError)) throw error;
        lastError = error.cause;
        if (attempt === MAX_ATTEMPTS) break;
        await this.sleep(error.waitMs);
      }
    }

    throw lastError ?? new ShopifyApiError("Shopify request failed");
  }

  private async send<T>(document: string, variables: Record<string, unknown>): Promise<T> {
    // The timer covers the whole exchange, including reading the body, so a stalled response can't hang the CLI.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const timedOut = () => new ShopifyApiError(`Shopify did not respond within ${Math.round(this.timeoutMs / 1000)}s`);

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-Shopify-Access-Token": this.config.accessToken,
          },
          body: JSON.stringify({ query: document, variables }),
          signal: controller.signal,
        });
      } catch (error) {
        // Only a coarse reason is kept; the raw error is dropped so nothing from the request can leak.
        if (controller.signal.aborted) throw timedOut();
        const code = (error as { cause?: { code?: string } }).cause?.code;
        throw new ShopifyApiError(`Could not reach ${this.config.storeDomain}${code ? ` (${code})` : ""}`);
      }

      if (!response.ok) {
        const error = this.httpError(response.status);
        if (RETRYABLE_STATUS.has(response.status)) {
          throw new RetryableError(error, retryWaitMs(response));
        }
        throw error;
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        if (controller.signal.aborted) throw timedOut();
        throw new ShopifyApiError("Shopify returned a response that was not valid JSON", response.status);
      }

      return this.readBody<T>(body, response.status);
    } finally {
      clearTimeout(timer);
    }
  }

  private readBody<T>(body: unknown, status: number): T {
    const { data, errors } = (body ?? {}) as { data?: T | null; errors?: unknown };
    if (Array.isArray(errors) && errors.length > 0) {
      const details = errors.map((e) => this.graphQLErrorDetail(e));
      if (details.some((d) => d.code === "THROTTLED")) {
        throw new RetryableError(new ShopifyGraphQLError(this.summarise(details), details), 2_000);
      }
      throw new ShopifyGraphQLError(this.summarise(details), details);
    }
    if (data === undefined || data === null) {
      throw new ShopifyApiError("Shopify returned no data", status);
    }
    return data;
  }

  private httpError(status: number): ShopifyApiError {
    const reasons: Record<number, string> = {
      401: "Shopify rejected the access token (401). Check SHOPIFY_ACCESS_TOKEN.",
      402: "The Shopify store is unavailable (402), for example because of billing.",
      403: "Shopify refused the request (403). The app may lack the required access scopes.",
      404: "Shopify could not find that store or API version (404). Check SHOPIFY_STORE_DOMAIN and SHOPIFY_API_VERSION.",
      423: "The Shopify store is locked (423).",
      429: "Shopify is rate limiting requests (429).",
    };
    return new ShopifyApiError(
      reasons[status] ?? (status >= 500 ? `Shopify had a server error (${status}).` : `Shopify returned HTTP ${status}.`),
      status,
    );
  }

  private graphQLErrorDetail(raw: unknown): GraphQLErrorDetail {
    const error = (raw ?? {}) as {
      message?: unknown;
      path?: unknown;
      extensions?: { code?: unknown; requiredAccess?: unknown };
    };
    const message = this.redact(typeof error.message === "string" ? error.message : "Unknown GraphQL error");
    const code = typeof error.extensions?.code === "string" ? error.extensions.code : null;

    const scopes = new Set<string>();
    const required = error.extensions?.requiredAccess;
    if (typeof required === "string") {
      for (const match of required.matchAll(/\b(?:read|write)_[a-z_]+\b/g)) scopes.add(match[0]);
    }
    if (code === "ACCESS_DENIED") {
      for (const match of message.matchAll(/`((?:read|write)_[a-z_]+)`/g)) scopes.add(match[1]);
    }

    return {
      message,
      code,
      path: Array.isArray(error.path) ? error.path.map(String).join(".") : null,
      requiredScopes: [...scopes],
    };
  }

  private summarise(details: GraphQLErrorDetail[]): string {
    const lines = details.slice(0, 5).map((d) => `${d.code ? `[${d.code}] ` : ""}${d.message}${d.path ? ` (at ${d.path})` : ""}`);
    return `Shopify GraphQL error:\n  - ${lines.join("\n  - ")}`;
  }
}

class RetryableError extends Error {
  constructor(
    readonly cause: ShopifyApiError,
    readonly waitMs: number,
  ) {
    super(cause.message);
  }
}

function retryWaitMs(response: Response): number {
  const seconds = Number(response.headers.get("Retry-After"));
  const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1_000;
  return Math.min(wait, MAX_RETRY_WAIT_MS);
}
