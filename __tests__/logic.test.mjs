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

import { cardNameFor, cardNameUpdates, profileInsert } from "../src/logic.js";

describe("card name", () => {
  it("is the member's trimmed display name, or null", () => {
    expect(cardNameFor({ name: "  Emma " })).toBe("Emma");
    expect(cardNameFor({ name: "   " })).toBeNull();
    expect(cardNameFor({ name: "" })).toBeNull();
    expect(cardNameFor({})).toBeNull();
    expect(cardNameFor(null)).toBeNull();
  });

  it("updates only profiles whose name changed, never to an empty name", () => {
    const members = [
      { id: "m1", name: "Emma" },
      { id: "m2", name: "Liam B." },
      { id: "m3", name: "" },
      { id: "m4", name: "Noah" },
      { id: "m5", name: "Ava" },
    ];
    const profiles = {
      m1: { id: "p1", card_name: "Emma" },
      m2: { id: "p2", card_name: "Liam" },
      m3: { id: "p3", card_name: "Old" },
      m4: null,
      m5: { id: "p5", card_name: "" },
    };
    expect(cardNameUpdates(profiles, members)).toEqual([
      { id: "p2", cardName: "Liam B." },
      { id: "p5", cardName: "Ava" },
    ]);
  });

  it("skips a profile with an unsafe id", () => {
    expect(cardNameUpdates({ m1: { id: "p 1", card_name: "" } }, [{ id: "m1", name: "Emma" }])).toEqual([]);
  });

  it("stores the name on a new profile, and never binds an empty string", () => {
    const named = profileInsert("p1", { id: "m1", name: " Emma " }, "T");
    expect(named.params).toEqual(["p1", "m1", "Emma", "T", "T"]);
    expect(named.sql).toMatch(/\(id, member_id, notes, card_name, created_at, updated_at\) VALUES \(\?, \?, '', \?, \?, \?\)/);
    expect(named.cardName).toBe("Emma");

    const unnamed = profileInsert("p2", { id: "m2", name: "" }, "T");
    expect(unnamed.params).toEqual(["p2", "m2", "T", "T"]);
    expect(unnamed.sql).not.toContain("card_name");
    expect(unnamed.cardName).toBeNull();
    for (const p of [...named.params, ...unnamed.params]) expect(p).not.toBe("");
  });
});
