/**
 * The health card's share link (manifest.shareable.card): what a babysitter or
 * coach sees, and what they never do.
 *
 * Every projected column is public to anyone holding the link — row policies
 * do not apply to share reads — so the projection is pinned here column by
 * column. The end-to-end run against real SQLite lives in the hub
 * (__tests__/app-exercise/share-health-cards.test.ts).
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, it, expect } from "vitest";
import { SEV_LABEL } from "../src/logic.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(__dirname, "../manifest.json"), "utf-8"));
const card = manifest.shareable.card;
const html = readFileSync(join(__dirname, "../src/index.html"), "utf-8");

const projected = (feed) => feed.columns.map((c) => c.column);

describe("shareable.card", () => {
  it("is the only shareable item type", () => {
    expect(Object.keys(manifest.shareable)).toEqual(["card"]);
  });

  it("titles the page with card_name and projects no profile column", () => {
    expect(card.table).toBe("health_profiles");
    expect(card.title_column).toBe("card_name");
    // member_id and the unused profile notes stay off the page.
    expect(card.columns).toEqual([]);
    expect(card.files).toBeUndefined();
    expect(card.submit).toBeUndefined();
    expect(card.aggregates).toBeUndefined();
  });

  it("lets only household admins mint", () => {
    expect(card.mint_roles).toBe("admin");
  });

  it("shows allergies, then medications, then emergency contacts", () => {
    expect(card.feed).toBeUndefined();
    expect(card.feeds.map((f) => [f.label, f.table, f.fk_column])).toEqual([
      ["Allergies", "health_allergies", "profile_id"],
      ["Medications", "health_medications", "profile_id"],
      ["Emergency contacts", "health_contacts", "profile_id"],
    ]);
  });

  it("projects exactly these columns, and never an id or a timestamp", () => {
    const [allergies, medications, contacts] = card.feeds;
    expect(projected(allergies)).toEqual(["name", "severity", "triggers", "symptoms", "response_steps"]);
    expect(projected(medications)).toEqual(["name", "dose", "location", "when_to_give", "notes"]);
    expect(projected(contacts)).toEqual(["name", "relationship", "phone"]);
    for (const feed of card.feeds) {
      for (const column of projected(feed)) {
        expect(column, `${feed.table}.${column}`).not.toMatch(/(^id$|_id$|_at$|^member)/);
      }
    }
  });

  it("labels severity exactly as the app does", () => {
    const severity = card.feeds[0].columns.find((c) => c.column === "severity");
    expect(severity.value_labels).toEqual(SEV_LABEL);
  });

  it("makes the phone tap-to-call", () => {
    const phone = card.feeds[2].columns.find((c) => c.column === "phone");
    expect(phone.format).toBe("tel");
    expect(phone.role).toBe("detail");
  });

  it("orders each list the way the app does", () => {
    expect(card.feeds.map((f) => [f.order_column, f.order])).toEqual([
      ["sort_order", "oldest"],
      ["created_at", "oldest"],
      ["priority", "oldest"],
    ]);
  });

  it("declares priority plaintext, and nothing else", () => {
    // priority is an INTEGER the app writes as a number, and the codec never
    // encrypts numbers, so the stored cells are already plaintext. Declaring an
    // encrypted TEXT column here instead would break its reads.
    expect(manifest.db_plaintext_columns).toEqual(["priority"]);
    const init = readFileSync(join(__dirname, "../migrations/001_init.sql"), "utf-8");
    expect(init).toMatch(/\bpriority INTEGER NOT NULL DEFAULT 1\b/);
  });

  it("adds card_name in a migration", () => {
    const sql = readFileSync(join(__dirname, "../migrations/002_card_name.sql"), "utf-8");
    expect(sql).toMatch(/ALTER TABLE app_health_cards__health_profiles ADD COLUMN card_name TEXT NOT NULL DEFAULT ''/);
  });
});

describe("the Share button", () => {
  it("is shown only to admins, when sharing is on", () => {
    expect(html).toMatch(/const CAN_SHARE = share\.enabled && IS_ADMIN;/);
    expect(html).toMatch(/const IS_ADMIN\s+= window\.__IS_ADMIN === true;/);
    expect(html).toMatch(/\$\{CAN_SHARE && pid \? `<button[^`]*onclick="shareCard\(\)"/);
  });

  it("mints the card item type for the profile", () => {
    expect(html).toMatch(/itemType: "card"/);
    expect(html).toMatch(/shareUi\.open\(\{ id: profile\.id, title: member\.name \}\)/);
  });

  it("says what the page shows and that it is live", () => {
    expect(html).toContain("allergies and what to do, their medications with the dose and where they’re kept, and their emergency contacts’ phone numbers");
    expect(html).toContain("Changes you make here show up on the page straight away.");
  });
});
