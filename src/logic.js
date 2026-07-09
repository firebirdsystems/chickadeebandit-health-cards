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
