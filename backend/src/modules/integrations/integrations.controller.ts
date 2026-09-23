import { Request, Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { logger } from "@/utils/logger.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import IntegrationsService from "./integrations.service.js";
import {
  validateCreateSourceSchema,
  validateUpdateSourceSchema,
  validateListSourcesQuerySchema,
  validateToggleSourceStatusSchema,
  validateListSourceEventsQuerySchema,
} from "./integrations.validators.js";

const integrationsService = new IntegrationsService();

export const listSources = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateListSourcesQuerySchema(req.query);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await integrationsService.listSources(value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getSource = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await integrationsService.getSource(req.params.id as string);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const createSource = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateCreateSourceSchema(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await integrationsService.createSource(value);
    sendResponse(res, true, result, "Source created successfully.", STATUS_CODES.CREATED);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const updateSource = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateUpdateSourceSchema(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await integrationsService.updateSource(req.params.id as string, value);
    sendResponse(res, true, result, "Source updated successfully.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const toggleSourceStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateToggleSourceStatusSchema(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await integrationsService.toggleStatus(req.params.id as string, value);
    sendResponse(res, true, result, "Source status updated successfully.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const listSourceWebhookEvents = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateListSourceEventsQuerySchema(req.query);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await integrationsService.listSourceEvents(req.params.id as string, value.limit);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const verifyProviderChallenge = (req: Request, res: Response): void => {
  try {
    const challenge = integrationsService.verifyMetaChallenge(req.query as Record<string, unknown>);
    res.status(STATUS_CODES.OK).send(challenge);
  } catch (error: any) {
    res.status(error.statusCode ?? STATUS_CODES.SERVER_ERROR).send(error.message ?? "Verification failed");
  }
};

export const receiveWebhook = async (req: Request, res: Response): Promise<void> => {
  const provider = req.params.provider as string;
  const rawBody = (req as any).rawBody ?? JSON.stringify(req.body);

  // Logged before any processing so an inbound delivery is visible even when it is
  // later rejected — an empty log here means the provider never reached us at all.
  logger.info(
    `[webhook] inbound provider=${provider} topic=${req.headers["x-shopify-topic"] ?? "-"} shop=${req.headers["x-shopify-shop-domain"] ?? "-"} bytes=${rawBody.length}`,
  );

  try {
    await integrationsService.handleWebhook(provider, req.headers, rawBody, req.body);
    res.status(STATUS_CODES.OK).json({ success: true });
  } catch (error: any) {
    // Signature/unknown-provider failures return 4xx; any other processing error is
    // already recorded on the WebhookEvent row and still gets a 200 so the provider
    // doesn't retry/disable the webhook subscription.
    if (error.statusCode === STATUS_CODES.UNAUTHORIZED || error.statusCode === STATUS_CODES.BAD_REQUEST) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(STATUS_CODES.OK).json({ success: true });
  }
};
