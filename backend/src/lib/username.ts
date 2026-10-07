import { z } from "zod";

// Login identifier for CRM users. Stored lowercased so lookups are case-insensitive.
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Username must be at least 3 characters")
  .max(50, "Username is too long")
  .regex(/^[a-z0-9._-]+$/, "Use only letters, numbers, dots, underscores and hyphens");
