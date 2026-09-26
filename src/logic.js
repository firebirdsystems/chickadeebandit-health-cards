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
