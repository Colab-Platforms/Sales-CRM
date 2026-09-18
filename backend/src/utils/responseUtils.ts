import type { Response } from "express";

export function sendResponse(
  res: Response,
  success: boolean,
  data: unknown,
  message: string,
  status: number,
): void {
  res.status(status).json({ success, message, data });
}
