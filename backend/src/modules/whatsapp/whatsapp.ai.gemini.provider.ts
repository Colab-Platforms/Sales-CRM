import { ApiError, GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { logger } from "@/utils/logger.js";
import { OrderExtractionSchema, type OrderExtraction } from "./whatsapp.ai.types.js";
import { buildOrderContextText, ORDER_AGENT_SYSTEM_PROMPT, OrderExtractionError, type AIProvider, type ExtractOrderInfoInput, type OrderExtractionErrorCode } from "./whatsapp.ai.provider.js";

// Google Gemini implementation of AIProvider, via the official @google/genai SDK. Server-side only:
// the API key comes from GEMINI_API_KEY (see whatsapp.ai.factory.ts) and never reaches a response,
// a log line, the database, or the frontend.

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
const REQUEST_TIMEOUT_MS = 20_000;

/** The one SDK surface this provider uses - narrow so tests can inject a fake without the network. */
export interface GeminiClientLike {
  models: {
    generateContent(params: { model: string; contents: string; config: Record<string, unknown> }): Promise<{ text?: string | undefined }>;
  };
}

// Gemini's structured-output mode takes a JSON Schema; generating it from the same Zod schema the
// backend validates with keeps the two from drifting. The "$schema" marker is not accepted there.
const { $schema: _ignored, ...RESPONSE_JSON_SCHEMA } = z.toJSONSchema(OrderExtractionSchema) as Record<string, unknown>;

export interface GeminiProviderOptions {
  apiKey: string;
  model?: string;
  client?: GeminiClientLike;
}

function classify(error: unknown): OrderExtractionErrorCode {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return "TIMEOUT";
  if (error instanceof ApiError) {
    if (error.status === 429) return "RATE_LIMIT";
    if (error.status === 401 || error.status === 403) return "AUTH";
    // Gemini reports an invalid key as HTTP 400 "API key not valid" rather than 401.
    if (error.status === 400 && /api key/i.test(error.message)) return "AUTH";
    if (error.status === 408 || error.status === 504) return "TIMEOUT";
  }
  return "PROVIDER_ERROR";
}

// The model may emit explicit nulls for fields it has no value for; the shared schema models
// "absent" as undefined, so drop null-valued keys before validating.
function dropNulls(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null));
}

export class GeminiAIProvider implements AIProvider {
  readonly name = "gemini";
  private readonly client: GeminiClientLike;
  private readonly model: string;

  constructor({ apiKey, model, client }: GeminiProviderOptions) {
    if (!apiKey.trim() && !client) throw new OrderExtractionError("NOT_CONFIGURED");
    this.model = (model ?? "").trim() || DEFAULT_GEMINI_MODEL;
    // GoogleGenAI sends the key as a request header; it is never interpolated into a message here.
    this.client = client ?? (new GoogleGenAI({ apiKey }) as unknown as GeminiClientLike);
  }

  async extractOrderInfo(input: ExtractOrderInfoInput): Promise<OrderExtraction> {
    let text: string | undefined;
    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: buildOrderContextText(input),
        config: {
          systemInstruction: ORDER_AGENT_SYSTEM_PROMPT,
          responseMimeType: "application/json",
          responseJsonSchema: RESPONSE_JSON_SCHEMA,
          temperature: 0.2,
          maxOutputTokens: 1024,
          abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      });
      text = response.text;
    } catch (error) {
      const code = classify(error);
      // Only the classified code and HTTP status are logged - never the raw provider message.
      logger.error(`WhatsApp AI (gemini) request failed: ${code}${error instanceof ApiError ? ` (HTTP ${error.status})` : ""}`);
      throw new OrderExtractionError(code);
    }

    if (!text || !text.trim()) {
      logger.error("WhatsApp AI (gemini) returned an empty response");
      throw new OrderExtractionError("INVALID_RESPONSE");
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      logger.error("WhatsApp AI (gemini) returned malformed JSON");
      throw new OrderExtractionError("INVALID_RESPONSE");
    }

    const parsed = OrderExtractionSchema.safeParse(dropNulls(parsedJson));
    if (!parsed.success) {
      logger.error(`WhatsApp AI (gemini) response failed schema validation: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
      throw new OrderExtractionError("INVALID_RESPONSE");
    }
    return parsed.data;
  }
}
