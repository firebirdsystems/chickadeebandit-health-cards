import { describe, it, expect } from "vitest";
import {
  SEV_LABEL, SEV_CLASS, isSafeId, hasSevereAllergy, allergyCountLabel, sevLabel, sevClass,
} from "../src/logic.js";

describe("isSafeId", () => {
  it("accepts alphanumeric ids with dash/underscore", () => {
    expect(isSafeId("abc-123_XYZ")).toBe(true);
  });
  it("rejects empty, overlong, or unsafe values", () => {
    expect(isSafeId("")).toBe(false);
    expect(isSafeId("a".repeat(81))).toBe(false);
    expect(isSafeId("has space")).toBe(false);
    expect(isSafeId("drop;table")).toBe(false);
    expect(isSafeId(42)).toBe(false);
    expect(isSafeId(null)).toBe(false);
  });
});

describe("hasSevereAllergy", () => {
  it("is true when any allergy is severe or anaphylactic", () => {
    expect(hasSevereAllergy([{ severity: "mild" }, { severity: "severe" }])).toBe(true);
    expect(hasSevereAllergy([{ severity: "anaphylactic" }])).toBe(true);
  });
  it("is false for only mild/moderate or empty", () => {
    expect(hasSevereAllergy([{ severity: "mild" }, { severity: "moderate" }])).toBe(false);
    expect(hasSevereAllergy([])).toBe(false);
    expect(hasSevereAllergy(null)).toBe(false);
  });
});

describe("allergyCountLabel", () => {
  it("singularizes for one", () => expect(allergyCountLabel(1)).toBe("1 allergy"));
  it("pluralizes otherwise", () => {
    expect(allergyCountLabel(0)).toBe("0 allergies");
    expect(allergyCountLabel(3)).toBe("3 allergies");
  });
});

describe("severity accessors", () => {
  it("map known severities to label and class", () => {
    expect(sevLabel("anaphylactic")).toBe("Anaphylactic");
    expect(sevClass("mild")).toBe("sev-mild");
  });
  it("fall back gracefully for unknown severities", () => {
    expect(sevLabel("weird")).toBe("weird");
    expect(sevClass("weird")).toBe("");
  });
  it("expose stable maps", () => {
    expect(SEV_LABEL.severe).toBe("Severe");
    expect(SEV_CLASS.anaphylactic).toBe("sev-anaphylactic");
  });
});
