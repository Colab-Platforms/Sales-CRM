import type { ZodType } from "zod";

export function validateSchema<T>(schema: ZodType<T>, body: unknown): { error: { message: string } | null; value: T } {
  const result = schema.safeParse(body);
  if (!result.success) {
    return { error: { message: result.error.issues[0]?.message ?? "Invalid input" }, value: undefined as unknown as T };
  }
  return { error: null, value: result.data };
}
