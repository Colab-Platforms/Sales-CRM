// The "AI Agent" tag of a lead / customer and the filters over it, shared by the Leads list and the Customers list so both show and filter the AI calling agency's activity the same way.
// An AI Agent activity is an Activity row with source AI_AGENT (see agency.repo recordAiAgentActivity); its metadata.intent says ALREADY_ORDERED or INTERESTED.
import { ActivitySource } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";

export type AiAgentIntent = "ALREADY_ORDERED" | "INTERESTED";

export interface AiAgentTag {
  lastActivityAt: Date;
  lastResult: string | null;
  lastTitle: string | null;
  lastIntent: AiAgentIntent | null;
  /** COD / PREPAID as the agent reported it on the latest activity; null when not sent. */
  lastMethod: "COD" | "PREPAID" | null;
  /** The agent has reported this customer as interested ("Interested - AI Agent"). */
  interested: boolean;
}

/** Add to a lead `include` / `select`: the latest AI Agent activity, and how many of them are "interested". Use aiAgentTag() on the result. */
export const AI_AGENT_INCLUDE = {
  activities: { where: { source: ActivitySource.AI_AGENT }, select: { createdAt: true, title: true, metadata: true }, orderBy: { createdAt: "desc" }, take: 1 },
  _count: { select: { activities: { where: { source: ActivitySource.AI_AGENT, metadata: { path: ["intent"], equals: "INTERESTED" } } } } },
} satisfies Prisma.LeadInclude;

export function aiAgentTag(activities: { createdAt: Date; title: string | null; metadata: Prisma.JsonValue | null }[], interestedCount = 0): AiAgentTag | null {
  const latest = activities[0];
  if (!latest) return null;
  const meta = latest.metadata as { result?: unknown; intent?: unknown; method?: unknown } | null;
  const lastIntent = meta?.intent === "INTERESTED" || meta?.intent === "ALREADY_ORDERED" ? meta.intent : null;
  return { lastActivityAt: latest.createdAt, lastResult: typeof meta?.result === "string" ? meta.result : null, lastTitle: latest.title, lastIntent, lastMethod: meta?.method === "COD" || meta?.method === "PREPAID" ? meta.method : null, interested: interestedCount > 0 };
}

/** ONLY / EXCLUDE AI Agent leads, and/or leads with an AI Agent request of one intent. The conditions are ANDed. */
export function aiAgentWhere(aiAgent?: "ONLY" | "EXCLUDE", intent?: AiAgentIntent): Prisma.LeadWhereInput[] {
  const conditions: Prisma.LeadWhereInput[] = [];
  if (aiAgent === "ONLY") conditions.push({ activities: { some: { source: ActivitySource.AI_AGENT } } });
  else if (aiAgent === "EXCLUDE") conditions.push({ activities: { none: { source: ActivitySource.AI_AGENT } } });
  if (intent) conditions.push({ activities: { some: { source: ActivitySource.AI_AGENT, metadata: { path: ["intent"], equals: intent } } } });
  return conditions;
}
