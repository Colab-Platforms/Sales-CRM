import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { ApprovedMetaTemplate } from "../whatsapp/whatsapp.template.service.js";
import { reportCompatibility } from "./report-automation.sender.js";

// "Add Template": the Admin picks from the templates Meta itself reports as APPROVED. Nothing is typed in; the name, language, category, body and variables stored are Meta's own (the same record a sync writes).

/** The part of WhatsAppTemplateService the picker needs (injectable in tests). */
export interface TemplateSource {
  listApprovedMeta(): Promise<ApprovedMetaTemplate[]>;
  addApprovedMeta(user: AuthUser, name: string, language: string): Promise<{ alreadyAdded: boolean; name: string; language: string }>;
}

export type PickerTemplate = ApprovedMetaTemplate & { compatible: boolean; incompatibleReason: string | null };

const assertAdmin = (user: AuthUser) => {
  if (user.role !== Role.ADMIN) throw new ApiError("Only an Admin can add templates.", STATUS_CODES.FORBIDDEN);
};

export async function listPickerTemplates(user: AuthUser, source: TemplateSource): Promise<PickerTemplate[]> {
  assertAdmin(user);
  return (await source.listApprovedMeta()).map((t) => {
    const c = reportCompatibility(t);
    return { ...t, compatible: c.ok, incompatibleReason: c.ok ? null : c.reason };
  });
}

export async function addPickerTemplate(user: AuthUser, source: TemplateSource, name: string, language: string) {
  assertAdmin(user);
  if (!name || !language) throw new ApiError("Choose a template from the list.", STATUS_CODES.BAD_REQUEST);
  // Re-read Meta's list: only a template Meta currently reports as APPROVED, and that the report can actually send, is added.
  const picked = (await listPickerTemplates(user, source)).find((t) => t.name === name && t.language === language);
  if (!picked) throw new ApiError("That template is not APPROVED in Meta (or no longer exists). Refresh the list.", STATUS_CODES.NOT_FOUND);
  if (!picked.compatible) throw new ApiError(`The report cannot use this template: ${picked.incompatibleReason}.`, STATUS_CODES.BAD_REQUEST);
  if (picked.alreadyAdded) return { alreadyAdded: true, name, language };
  return source.addApprovedMeta(user, name, language);
}
