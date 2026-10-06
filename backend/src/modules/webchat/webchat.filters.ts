import type { Prisma } from "../../../generated/prisma/client.js";
import type { ListWebChatConversationsQuery } from "./webchat.types.js";

const MAX_SEARCH_TERMS = 5;

/** Search reaches the linked Lead's name/number/mobile, and the chatbot's own conversation id for
 * an anonymous visitor who has no Lead yet. Every term must match (AND), same as calls/leads. */
export function webChatSearchWhere(search: string): Prisma.WebChatConversationWhereInput {
  const terms = search.split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS);

  return {
    AND: terms.map((term): Prisma.WebChatConversationWhereInput => {
      const contains = { contains: term, mode: "insensitive" as const };
      return {
        OR: [
          { externalConversationId: contains },
          {
            lead: {
              OR: [{ firstName: contains }, { lastName: contains }, { leadNumber: contains }, { mobile: contains }],
            },
          },
        ],
      };
    }),
  };
}

/** Combines the caller's visibility scope with the list query's own filters. Each filter is an
 * AND-ed clause; the scope is never replaced or loosened by a filter. */
export function buildWebChatListWhere(
  query: Pick<ListWebChatConversationsQuery, "search" | "archived" | "mode" | "assigned">,
  scope: Prisma.WebChatConversationWhereInput,
): Prisma.WebChatConversationWhereInput {
  const and: Prisma.WebChatConversationWhereInput[] = [];

  if (Object.keys(scope).length > 0) and.push(scope);
  if (query.search) and.push(webChatSearchWhere(query.search));

  // The active queue is the default view: archived conversations are hidden unless asked for.
  if (query.archived === true) and.push({ archivedAt: { not: null } });
  else and.push({ archivedAt: null });

  if (query.mode) and.push({ mode: query.mode });

  if (query.assigned === true) and.push({ assignedToId: { not: null } });
  else if (query.assigned === false) and.push({ assignedToId: null });

  return and.length > 0 ? { AND: and } : {};
}

/** A single conversation, only if the caller's scope allows it - an out-of-scope id looks the same
 * as a missing one (no existence leak), same convention as scopedCallWhere. */
export function scopedWebChatWhere(id: string, scope: Prisma.WebChatConversationWhereInput): Prisma.WebChatConversationWhereInput {
  if (Object.keys(scope).length === 0) return { id };
  return { AND: [{ id }, scope] };
}
