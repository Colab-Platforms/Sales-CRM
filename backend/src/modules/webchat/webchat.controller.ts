import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import { webChatService } from "./webchat.service.js";
import {
  validateAssignBody,
  validateListWebChatQuery,
  validateSendMessageBody,
  validateWebChatIdParams,
} from "./webchat.validators.js";

function handleError(res: Response, error: any): void {
  sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
}

function parseId(req: AuthRequest, res: Response): string | null {
  const { error, value } = validateWebChatIdParams(req.params);
  if (error) {
    sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
    return null;
  }
  return value.id;
}

export const listWebChatConversations = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateListWebChatQuery(req.query);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await webChatService.listConversations(req.user!, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    handleError(res, error);
  }
};

export const getWebChatConversation = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = parseId(req, res);
    if (!id) return;
    const result = await webChatService.getConversation(req.user!, id);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    handleError(res, error);
  }
};

export const markWebChatRead = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = parseId(req, res);
    if (!id) return;
    const result = await webChatService.markRead(req.user!, id);
    sendResponse(res, true, result, "Conversation marked as read.", STATUS_CODES.OK);
  } catch (error: any) {
    handleError(res, error);
  }
};

export const assignWebChatConversation = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = parseId(req, res);
    if (!id) return;
    const { error, value } = validateAssignBody(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await webChatService.assign(req.user!, id, value.assignedToId);
    sendResponse(res, true, result, "Conversation assigned.", STATUS_CODES.OK);
  } catch (error: any) {
    handleError(res, error);
  }
};

export const handoffWebChatConversation = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = parseId(req, res);
    if (!id) return;
    const result = await webChatService.handoff(req.user!, id);
    sendResponse(res, true, result, "Conversation handed off to a human.", STATUS_CODES.OK);
  } catch (error: any) {
    handleError(res, error);
  }
};

export const returnWebChatToAi = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = parseId(req, res);
    if (!id) return;
    const result = await webChatService.returnToAi(req.user!, id);
    sendResponse(res, true, result, "Conversation returned to AI.", STATUS_CODES.OK);
  } catch (error: any) {
    handleError(res, error);
  }
};

export const archiveWebChatConversation = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = parseId(req, res);
    if (!id) return;
    const result = await webChatService.archive(req.user!, id);
    sendResponse(res, true, result, "Conversation archived. Its history was kept.", STATUS_CODES.OK);
  } catch (error: any) {
    handleError(res, error);
  }
};

export const sendWebChatAgentMessage = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = parseId(req, res);
    if (!id) return;
    const { error, value } = validateSendMessageBody(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await webChatService.sendAgentMessage(req.user!, id, value.text);
    sendResponse(res, true, result, result.delivered ? "Message sent." : "Message saved, but could not be delivered to the visitor.", STATUS_CODES.CREATED);
  } catch (error: any) {
    handleError(res, error);
  }
};
