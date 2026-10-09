import type { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import { ticketsService } from "./tickets.service.js";
import { validateCommentBody, validateCreateBody, validateIdParams, validateListQuery, validateStatusBody } from "./tickets.validators.js";

const fail = (res: Response, error: any) => sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
const bad = (res: Response, message: string) => sendResponse(res, false, null, message, STATUS_CODES.BAD_REQUEST);

export const createTicket = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = validateCreateBody(req.body);
    if (body.error) return void bad(res, body.error.message);
    sendResponse(res, true, await ticketsService.create(req.user!, body.value), "Ticket raised", STATUS_CODES.CREATED);
  } catch (error: any) {
    fail(res, error);
  }
};

export const listTickets = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const query = validateListQuery(req.query);
    if (query.error) return void bad(res, query.error.message);
    sendResponse(res, true, await ticketsService.list(req.user!, query.value), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const getOpenTicketCount = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    sendResponse(res, true, await ticketsService.openCount(req.user!), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const getTicket = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validateIdParams(req.params);
    if (params.error) return void bad(res, params.error.message);
    sendResponse(res, true, await ticketsService.get(req.user!, params.value.id), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const addTicketComment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validateIdParams(req.params);
    if (params.error) return void bad(res, params.error.message);
    const body = validateCommentBody(req.body);
    if (body.error) return void bad(res, body.error.message);
    sendResponse(res, true, await ticketsService.addComment(req.user!, params.value.id, body.value.body), "Comment added", STATUS_CODES.CREATED);
  } catch (error: any) {
    fail(res, error);
  }
};

export const setTicketStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validateIdParams(req.params);
    if (params.error) return void bad(res, params.error.message);
    const body = validateStatusBody(req.body);
    if (body.error) return void bad(res, body.error.message);
    sendResponse(res, true, await ticketsService.setStatus(req.user!, params.value.id, body.value.status), "Ticket updated", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};
