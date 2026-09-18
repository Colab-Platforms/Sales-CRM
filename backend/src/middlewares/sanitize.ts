import { Request, Response, NextFunction } from "express";
import xss from "xss";

function sanitizeValue(value: any): any {
  if (typeof value === "string") return xss(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") return sanitizeObject(value);
  return value;
}

function sanitizeObject(obj: Record<string, any>): Record<string, any> {
  for (const key of Object.keys(obj)) {
    obj[key] = sanitizeValue(obj[key]);
  }
  return obj;
}

export default function sanitizeMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    if (req.body) sanitizeObject(req.body);
    if (req.query) sanitizeObject(req.query as any);
    if (req.params) sanitizeObject(req.params as any);
  } catch (e) {
    console.warn("Sanitize middleware error:", e);
  }
  next();
}
