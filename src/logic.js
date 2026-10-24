// Pure, testable logic extracted from index.html.
// No DOM, no network — safe to import from Node for unit tests.

export const SEV_LABEL = { mild: "Mild", moderate: "Moderate", severe: "Severe", anaphylactic: "Anaphylactic" };
export const SEV_CLASS = { mild: "sev-mild", moderate: "sev-moderate", severe: "sev-severe", anaphylactic: "sev-anaphylactic" };

export function isSafeId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

export function hasSevereAllergy(allergies) {
  return (allergies ?? []).some(a => a.severity === "anaphylactic" || a.severity === "severe");
}

export function allergyCountLabel(count) {
  return `${count} ${count === 1 ? "allergy" : "allergies"}`;
}

export function sevLabel(severity) {
  return SEV_LABEL[severity] ?? severity;
}

export function sevClass(severity) {
  return SEV_CLASS[severity] ?? "";
}

/**
 * The name a card's share page shows: the member's display name, trimmed.
 * Null when there is none, because `card_name` is encrypted and the codec
 * refuses an empty string — a card with no name keeps whatever it had.
 */
export function cardNameFor(member) {
  const name = typeof member?.name === "string" ? member.name.trim() : "";
  return name || null;
}

/**
 * The profiles whose stored `card_name` no longer matches the member's name,
 * as `{ id, cardName }`. `profiles` maps member_id → profile row (or null);
 * `members` is the roster. A rename in the hub propagates the next time an
 * adult opens Health Cards.
 */
export function cardNameUpdates(profiles, members) {
  const updates = [];
  for (const member of members ?? []) {
    const profile = profiles?.[member.id];
    if (!profile || !isSafeId(profile.id)) continue;
    const cardName = cardNameFor(member);
    if (cardName && profile.card_name !== cardName) updates.push({ id: profile.id, cardName });
  }
  return updates;
}

/**
 * The INSERT for a new profile, and the `cardName` it stores (or null). The
 * name is bound only when there is one; otherwise the column takes its
 * default rather than an empty string the codec would refuse.
 */
export function profileInsert(id, member, now) {
  const cardName = cardNameFor(member);
  return cardName
    ? {
        sql: "INSERT INTO app_health_cards__health_profiles (id, member_id, notes, card_name, created_at, updated_at) VALUES (?, ?, '', ?, ?, ?)",
        params: [id, member.id, cardName, now, now],
        cardName,
      }
    : {
        sql: "INSERT INTO app_health_cards__health_profiles (id, member_id, notes, created_at, updated_at) VALUES (?, ?, '', ?, ?)",
        params: [id, member.id, now, now],
        cardName: null,
      };
}

// ── Care team ────────────────────────────────────────────────────────────────

/** The two values of a profile's `visibility` column. */
export const VISIBILITY_ADULTS = "adults";
export const VISIBILITY_CARE = "care";

/** A card the care team reads as well as the adults: the household's chosen
 * member group (a nanny who signs in as a guest, a grandparent). */
export function isCareProfile(profile) {
  return profile?.visibility === VISIBILITY_CARE;
}

/**
 * Whether a member is on the care team: the hub member group the app's
 * `care_team_group_id` setting names. Mirrors the hub's privileged_groups
 * rule for the health_profiles table (select only): nobody is on it until an
 * admin has chosen a group, and a group that no longer exists names no one.
 * For the page's labels only — the hub decides which cards a member reads.
 * Medications has its own Care team setting (the same key name, its own
 * value): an admin chooses the same group there.
 */
export function isCareTeamMember(member, groups, careTeamGroupId) {
  if (!member || !careTeamGroupId) return false;
  const group = (groups ?? []).find(g => g?.id === careTeamGroupId);
  return !!group && (group.memberIds ?? []).includes(member.id);
}

/**
 * Whether the page offers "Share with the care team" on a member's card: on
 * the viewer's own card, and on a child's card (role child) — never on another
 * adult's card, nor a guest's (the nanny's own). Mirrors Medications'
 * canChooseVisibility. At home the hub takes the column from any adult (column_write_acls
 * visibility: adult); in a co-parenting space it writes only the caller's own
 * and a child's card (coparenting_child_supervision), never the other parent's.
 */
export function canShareWithCareTeam(ownerId, me, members = []) {
  if (!isAdultMember(me) || !ownerId) return false;
  if (ownerId === me.id) return true;
  const owner = (members ?? []).find(m => m?.id === ownerId);
  return owner?.role === "child";
}

// Must match hub-sdk's isAdult; copied so this file stays SDK-free for tests.
function isAdultMember(member) {
  return !!member && (member.role === "adult" || member.role === "admin");
}

/**
 * The line a failed write shows (app-template "Refused, gone, or failed"):
 * decided from the status, never from the hub's text. "Try again" only where
 * trying again can work.
 */
export function failureLine(e, { action }) {
  if (e?.status === 403) return `You don’t have permission to ${action}.`;
  if (e?.status === 507) return "The household’s storage is full — free up space first.";
  return `Couldn’t ${action} — try again.`;
}

// ── Optimistic entries ───────────────────────────────────────────────────────

/**
 * The last confirmed state of one entry, taken just before an optimistic
 * add, edit or remove: a copy of the row and its position in the card's list,
 * or `row: null` when the entry is not there yet (an add).
 */
export function entrySnapshot(list, id) {
  const index = (list ?? []).findIndex(r => r?.id === id);
  return { id, row: index >= 0 ? { ...list[index] } : null, index };
}

/**
 * `list` with one entry put back as `snapshot` recorded it: an add taken out,
 * an edit undone in place, a removed entry back at its position. For a write
 * that failed when the re-read that would show what is stored failed too —
 * the card must not keep showing (and printing) a change the hub refused.
 */
export function restoreEntry(list, snapshot) {
  const rest = (list ?? []).filter(r => r?.id !== snapshot.id);
  if (!snapshot.row) return rest;
  rest.splice(Math.min(Math.max(snapshot.index, 0), rest.length), 0, snapshot.row);
  return rest;
}

/** The entries of a list that are stored: an add whose INSERT has not
 * settled (its id in `pendingIds`) is left out — the printed card carries only
 * what the hub has confirmed. */
export function confirmedEntries(list, pendingIds) {
  return (list ?? []).filter(r => !pendingIds?.has(r?.id));
}

/** Whether card `pid` may be printed: no add, edit or remove on it still in
 * flight (`inFlight`: profile id → unsettled writes) and no care-team switch
 * write (`careWriteInFlight`). A pending edit's value is unconfirmed and a
 * pending removal hides what is stored, so printing waits for them. */
export function printReady(inFlight, pid, careWriteInFlight = false) {
  return !careWriteInFlight && !(pid && (inFlight?.get(pid) ?? 0) > 0);
}
