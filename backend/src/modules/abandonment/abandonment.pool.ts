// 24/7 abandoned-lead pool: the canonical identities and the pure round-robin rule (no database here, so it is testable and the dry run uses the very same function the assignment does).

/** The nine telecallers, in round-robin order, by their EXACT CRM username (never by display name: "Roshni " is stored with a trailing space). Resolved to user ids at configure time; nothing is created. */
export const CANONICAL_POOL: { username: string; name: string }[] = [
  { username: "shreya_awl", name: "Shreya" },
  { username: "aayush_awl", name: "Aayush Tiwari" },
  { username: "priti_awl", name: "Priti" },
  { username: "aryan_awl", name: "Aryan" },
  { username: "yash_awl", name: "Yash" },
  { username: "dheeraj_awl", name: "Dheeraj" },
  { username: "rustam_awl", name: "Rustam" },
  { username: "bhoomi_awl", name: "Bhoomi" },
  { username: "roshni_awl", name: "Roshni" },
];

/**
 * The next member after `lastAssignedId` in `members` order. The cursor is an id, not an index, so a member who has since been disabled or removed does not shift anyone's turn: if the last one is no
 * longer in the list, the sequence restarts from the first still-eligible member. Empty list = nobody (null).
 */
export function nextPoolMember<T extends { id: string }>(members: readonly T[], lastAssignedId: string | null): T | null {
  if (members.length === 0) return null;
  const idx = lastAssignedId ? members.findIndex((m) => m.id === lastAssignedId) : -1;
  return members[(idx + 1) % members.length] ?? null;
}

/** What the next `leadCount` assignments would be, starting after `lastAssignedId` - used by the dry run, so it matches the real assignment exactly. */
export function simulateRoundRobin<T extends { id: string }>(members: readonly T[], lastAssignedId: string | null, leadCount: number): T[] {
  const out: T[] = [];
  let last = lastAssignedId;
  for (let i = 0; i < leadCount; i++) {
    const next = nextPoolMember(members, last);
    if (!next) break;
    out.push(next);
    last = next.id;
  }
  return out;
}
