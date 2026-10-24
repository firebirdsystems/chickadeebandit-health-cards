/**
 * The care team: a hub member group (a nanny who signs in as a guest, a
 * grandparent) that reads every card marked "care" — allergies, emergency
 * medications, contacts — and changes nothing. The adults' own cards stay
 * with the adults. Medications has its own setting under the same key name.
 *
 * What the hub enforces is proved end-to-end in scenarios.json; this pins the
 * manifest shape that enforcement depends on, the migration, and the page's
 * side of the same rule.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  VISIBILITY_ADULTS, VISIBILITY_CARE, isCareProfile, isCareTeamMember,
  canShareWithCareTeam, failureLine, entrySnapshot, restoreEntry, confirmedEntries, printReady,
} from "../src/logic.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(__dirname, "../manifest.json"), "utf-8"));
const source = readFileSync(join(__dirname, "../src/index.html"), "utf-8");
const policies = manifest.row_policies;
const CHILD_TABLES = ["health_allergies", "health_medications", "health_contacts"];

/** The column list of every INSERT the page sends to a table. */
function insertedColumns(table) {
  const re = new RegExp(`INSERT INTO app_health_cards__${table} \\(([^)]+)\\)`, "g");
  const cols = new Set();
  for (const m of source.matchAll(re)) for (const c of m[1].split(",")) cols.add(c.trim());
  return [...cols];
}
/** The columns every UPDATE the page sends to a table assigns. */
function updatedColumns(table) {
  const re = new RegExp(`UPDATE app_health_cards__${table} SET ([^W]+) WHERE`, "g");
  const cols = new Set();
  for (const m of source.matchAll(re)) for (const part of m[1].split(",")) cols.add(part.split("=")[0].trim());
  return [...cols];
}

describe("care team row policies", () => {
  const profiles = policies.health_profiles;

  it("reads a card as an adult, its owner, or the care team group — select only, never the whole household", () => {
    expect(profiles.kind).toBe("owner_or_visibility");
    expect(profiles.member_column).toBe("member_id");
    expect(profiles.visibility_column).toBe("visibility");
    expect(profiles.everyone_values).toEqual([]);
    expect(profiles.adult_values).toEqual(["adults", "care"]);
    expect(profiles.privileged_values).toEqual(["care"]);
    // Never "adults": the adults' own cards must not reach the nanny.
    expect(profiles.privileged_values).not.toContain("adults");
    expect(profiles.privileged_groups).toEqual([
      { settings_table: "settings", settings_key: "care_team_group_id", actions: ["select"] },
    ]);
    // The policy compares the column, so it is stored in the clear.
    expect(manifest.db_plaintext_columns).toContain("visibility");
  });

  it("takes a card's writes from an adult alone, and lets an adult create a card for a child", () => {
    // An adult creates a card FOR a member; without this the hub would stamp
    // the parent as the card's owner.
    expect(profiles.supervisor_assigns_owner).toBe(true);
    // In a co-parenting space either parent creates a CHILD's card (the hub
    // keeps a supplied owner only when it is a current child member).
    expect(profiles.coparenting_child_supervision).toBe(true);
    expect(profiles.write_owner_only).toBeUndefined();
    expect(profiles.delete_adult_only).toBe(true);
    expect(profiles.audit_writes).toBe(true);
    // Every column the page writes is adult-only; a card is never re-owned
    // and never re-keyed (a swapped id would move another card's entries).
    for (const col of [...insertedColumns("health_profiles"), ...updatedColumns("health_profiles")]) {
      if (col === "member_id" || col === "id") continue;
      expect(profiles.column_write_acls[col], col).toEqual({ writable_by: ["adult"] });
    }
    expect(profiles.column_write_acls.member_id).toEqual({ writable_by: [], actions: ["update"] });
    expect(profiles.column_write_acls.id).toEqual({ writable_by: [], actions: ["update"] });
    expect(updatedColumns("health_profiles")).not.toContain("id");
    // Deleting a card takes its entries, so its id can never be re-inserted
    // under a child to adopt them.
    expect(manifest.delete_cascades.health_profiles).toEqual(
      CHILD_TABLES.map((table) => ({ table, foreign_key: "profile_id" })),
    );
    // The page never upserts a card: a supervisor's ON CONFLICT is refused.
    expect(source).not.toMatch(/health_profiles[^;]*ON CONFLICT/);
  });

  it("follows allergies, medications and contacts to the card, with adult-only writes", () => {
    for (const table of CHILD_TABLES) {
      const p = policies[table];
      expect(p.kind, table).toBe("inherit_visibility");
      expect(p.parent_table, table).toBe("health_profiles");
      expect(p.fk_column, table).toBe("profile_id");
      expect(p.writer_column, table).toBe("created_by");
      // Any adult corrects any entry on a card they can see, not only its writer.
      expect(p.adults_bypass, table).toBe(true);
      // In a co-parenting space either parent maintains every entry on a
      // child's card, whichever parent wrote it (never on an adult's card).
      expect(p.coparenting_child_supervision, table).toBe(true);
      // Migration 003 credits old entries to the card's member, a child
      // included, and column ACLs govern only INSERT/UPDATE: without this a
      // child could DELETE their own card's entries through the API.
      expect(p.delete_adult_only, table).toBe(true);
      expect(p.audit_writes, table).toBe(true);
      // A care-team member can see the card, so only the column ACLs keep
      // them from adding to it: every column the page writes must be listed.
      const written = [...insertedColumns(table), ...updatedColumns(table)];
      expect(written.length, table).toBeGreaterThan(0);
      for (const col of written) {
        if (col === "created_by") continue;
        expect(p.column_write_acls[col], `${table}.${col}`).toEqual({ writable_by: ["adult"] });
      }
      // The hub stamps the writer, and requires every INSERT to name the
      // column: the page binds the member it knows and never an UPDATE of it.
      expect(insertedColumns(table), table).toContain("created_by");
      expect(updatedColumns(table), table).not.toContain("created_by");
      // Nobody rewrites the writer: it decides who may change the entry.
      expect(p.column_write_acls.created_by, table).toEqual({ writable_by: [], actions: ["update"] });
      // Who wrote an entry is kept when they leave the household.
      expect(manifest.member_references[table]).toEqual({ column: "created_by", on_removed: "keep" });
    }
    expect(source).toContain('const WRITER = HUB_MEMBER?.id ?? "";');
  });

  it("keeps the group pointer admin-written and reads the groups it names", () => {
    expect(policies.settings).toEqual({ kind: "app_config" });
    expect(manifest.admin_config).toEqual({ settings_table: "settings", keys: ["care_team_group_id"] });
    expect(manifest.data_access.reads).toContain("family.groups");
    expect(manifest.preload.settings.sql).toBe("SELECT key, value FROM app_health_cards__settings WHERE key = 'care_team_group_id'");
    // The same key name as the Medications app (each app keeps its own value).
    const meds = join(__dirname, "../../medication-tracker/manifest.json");
    let medsManifest = null;
    try { medsManifest = JSON.parse(readFileSync(meds, "utf-8")); } catch { /* sibling checkout absent */ }
    if (medsManifest) expect(medsManifest.admin_config.keys).toContain("care_team_group_id");
  });

  it("keeps the share link as it was", () => {
    expect(manifest.shareable.card.mint_roles).toBe("admin");
    expect(manifest.shareable.card.columns).toEqual([]);
  });
});

describe("the page", () => {
  it("reads the member groups with the members, and the setting on its own — neither can fail the cards", () => {
    expect(source).toContain(`fetchContext("family.members,family.groups")`);
    expect(source).toContain(`db("SELECT key, value FROM app_health_cards__settings WHERE key = 'care_team_group_id'")`);
    // Only a failed read of the members fails the load; the groups only label it.
    expect(source).toContain('if (!ctx.members) throw');
    expect(source).not.toMatch(/\$errors\?\.length/);
    // One context helper for the first load and the groups' own Try again.
    expect(source).toContain('async function fetchContext(keys) {');
    expect(source).toContain('const groupsRead = read("family.groups") && Array.isArray(ctx["family.groups"]);');
    expect(source).toContain('members: read("family.members") ? (ctx["family.members"] ?? []) : undefined,');
    expect(source).toContain('({ groups, groupsRead } = await fetchContext("family.groups"));');
    expect(source.match(/await fetch\(`\$\{CONTEXT\}/g)).toHaveLength(1);
    // The cards' Promise.all does not carry the setting.
    const load = source.slice(source.indexOf("async function loadAllProfileData"), source.indexOf("function ensureProfile("));
    expect(load).not.toContain("app_health_cards__settings");
    expect(source).toContain('const settingsLoad = loadSettings().catch(');
  });

  it("saves the care team group only through the hub's admin-config endpoint, as an admin", () => {
    expect(source).toContain('const ADMIN_CONFIG_URL = window.__ADMIN_CONFIG_URL ?? "";');
    expect(source).toContain('body: JSON.stringify({ key: "care_team_group_id", value }),');
    expect(source).toContain("window.openCareTeamModal = function() {\n  if (!IS_ADMIN) return;");
    expect(source).not.toMatch(/INSERT INTO app_health_cards__settings|UPDATE app_health_cards__settings/);
  });

  it("offers the care-team switch on the viewer's own card and a child's, and writes only the visibility column", () => {
    expect(source).toContain('${careWriteInFlight ? "disabled" : ""} onchange="setCareTeamSharing(this.checked)"');
    expect(source).toContain('await db("UPDATE app_health_cards__health_profiles SET visibility = ? WHERE id = ?", [visibility, profileId]);');
    expect(source).toContain("window.setCareTeamSharing = async function(on) {\n  if (!canShareCard(selectedMemberId) || careWriteInFlight) return;");
    expect(source).toContain("function careRowHtml(profile) {\n  if (!canShareCard(selectedMemberId)) return \"\";");
    expect(source).toContain("return canEditCard(memberId) && (!DB || canShareWithCareTeam(memberId, HUB_MEMBER, members));");
    // The switch waits for its write to settle.
    const toggle = source.slice(source.indexOf("window.setCareTeamSharing"), source.indexOf("\n};\n", source.indexOf("window.setCareTeamSharing")));
    expect(toggle).toContain("careWriteInFlight = true;");
    // Set and rolled back on the profile on the page after each await, never a stale copy.
    expect(toggle).toContain("const current = profiles[memberId];\n    if (current?.id === profileId) current.visibility = value;");
    expect(toggle).not.toMatch(/\bprofile\.visibility = /);
    expect(toggle.match(/setVisibility\(before\);/g)).toHaveLength(2);
    expect(toggle).toContain("} finally {\n    careWriteInFlight = false;");
    // A card still marked 'care' can be taken back with no group set; sharing anew waits for one.
    expect(source).toContain('data-testid="care-unshare" ${careWriteInFlight ? "disabled" : ""} onclick="setCareTeamSharing(false)"');
    expect(source).toContain("if (on && !careTeamConfigured()) return;");
  });

  it("treats a write that changed nothing as not saved, on every write path", () => {
    expect(source).toContain("return !!DB && Number(res?.changed ?? 0) === 0;");
    const body = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
    expect(body("async function settleWrite(", "\n}\n")).toContain("if (!wroteNothing(res)) {\n    if (insert) insertLanded(insert);\n    else if (before) changeLanded(before);\n    return;\n  }");
    expect(body("window.setCareTeamSharing", "\n};\n")).toContain("if (wroteNothing(res)) {");
    const names = body("async function refreshCardNames(", "\n}\n");
    // Batches within the hub's 25-statement limit; a refused batch falls back
    // to one request per card; each result is checked on its own.
    expect(source).toContain("const BATCH_LIMIT = 25;");
    expect(names).toContain("for (let i = 0; i < updates.length; i += BATCH_LIMIT) {");
    expect(names).toContain("results = await dbBatch(statements);");
    // Only a refusal is retried, a card at a time and in sequence; a failing hub is sent nothing more.
    expect(names).toContain("const isRefusal = e => e?.status === 400 || e?.status === 403;");
    expect(names).toContain("if (!isRefusal(e)) return;");
    expect(names).toContain("results.push(await db(sql, params));");
    // A failing hub mid-retry stops the retries (and the next batches).
    expect(names).toContain("if (!isRefusal(err)) { hubFailing = true; break; }");
    expect(names).toContain("if (hubFailing) return;");
    expect(names).toContain("if (!results[j] || wroteNothing(results[j])) return;");
    // Only the cards this member may change: the hub refuses a co-parent's write to the other parent's card.
    expect(names).toContain("members.filter(m => canEditCard(m.id) && (!only || m.id === only));");
    // Every UPDATE and DELETE of an entry names its row, so the re-read can say what happened.
    expect(source.match(/persist\(db\("DELETE FROM app_health_cards__health_\w+ WHERE id = \?", \[(\w+)\]\), \1, null, before\);/g)).toHaveLength(3);
  });

  it("draws no add, edit or remove control for a member who is not an adult", () => {
    expect(source).toContain("const canEdit = canEditCard(member.id);");
    // In a shared space the hub stamps a participant's new card to them and
    // narrows their changes to their own card; the steward keeps every card.
    expect(source).toContain("return IS_ADULT && (supervisesCard(memberId) || memberId === HUB_MEMBER?.id);");
    // A co-parenting space supervises children only (coparenting_child_supervision):
    // a steward keeps a child's card and every entry on it, and only their own
    // card and entries otherwise — never the other parent's.
    expect(source).toContain('const SUPERVISES = !IN_SPACE || (IS_ADMIN && SPACE_KIND !== "coparenting");');
    expect(source).toContain('const COPARENTING_STEWARD = IN_SPACE && IS_ADMIN && SPACE_KIND === "coparenting";');
    expect(source).toContain('  return SUPERVISES\n    || (COPARENTING_STEWARD && members.find(m => m.id === memberId)?.role === "child");');
    expect(source).toContain("const SPACE_KIND = window.__SPACE_KIND ?? null;");
    expect(source).toContain('const addBtn = (fn) => canEdit ? `<button class="btn-add" onclick="${fn}()">+ Add</button>` : "";');
    // Every entry-actions block is behind canEdit; every + Add goes through addBtn.
    expect(source.match(/<div class="entry-actions">/g)).toHaveLength(3);
    for (const v of ["a", "m", "c"]) expect(source).toContain(`\${canChangeEntry(${v}) ? \`<div class="entry-actions">`);
    // In a space a participant changes only the entries they wrote; the
    // steward (and at home any adult) changes any.
    expect(source).toContain("return canEditCard(selectedMemberId) && !pendingInserts.has(entry?.id)\n    && !entriesInFlight.has(entry?.id)\n    && (supervisesCard(selectedMemberId) || (!!WRITER && entry?.created_by === WRITER));");
    // An entry added on the page is not offered Edit/Remove until its INSERT settles.
    expect(source.match(/pendingInserts\.add\(id\);/g)).toHaveLength(3);
    // Every INSERT goes through persist with its optimistic row, which leaves
    // pendingInserts before persist's re-read on a failure, so a failed
    // INSERT's row is not merged back; a re-read meanwhile keeps every row
    // still pending, or landed after that read began (withPending), on both read paths.
    expect(source.match(/\), null, \{ table: "app_health_cards__health_(allergies|medications|contacts)", kind: "\1", row \}, before\)\.finally\(render\);/g)).toHaveLength(3);
    expect(source).not.toContain("pendingInserts.delete(id)");
    const persistBody = source.slice(source.indexOf("async function settleWrite("), source.indexOf("\n}\n", source.indexOf("async function settleWrite(")));
    expect(persistBody.match(/if \(insert\) pendingInserts\.delete\(insert\.row\.id\);\n/g)).toHaveLength(2);
    expect(source).toContain("const keep = pendingInserts.has(row.id) ? row : landed(row.id)?.row;");
    expect(source).toContain("const l = landedAt.get(id); return l && l.at >= seq ? l : null;");
    expect(source).toContain("const merged = withPending(list, fresh[pid] ?? [], seq);");
    expect(source.match(/= withPending\((allergies|medications|contacts)\[pid\], safe\(\w+\), seq\);/g)).toHaveLength(3);
    expect(source.match(/const seq = \+\+readSeq;/g)).toHaveLength(2);
    // Every read is open until it settles, so a landed write is forgotten only
    // once no read that began before it is out.
    expect(source.match(/const seq = \+\+readSeq;\n  openReads\.add\(seq\);\n  try \{/g)).toHaveLength(2);
    expect(source.match(/\} finally \{\n    readDone\(seq\);\n  \}\n\}/g)).toHaveLength(2);
    // An INSERT that landed is back on its card if a re-read dropped it meanwhile.
    expect(source).toContain("landedAt.set(row.id, { at: readSeq, row });");
    expect(source).toContain("if (!list.some(r => r.id === row.id)) list.push(row);");
    for (const fn of ["deleteAllergy", "deleteMedication", "deleteContact"]) {
      expect(source).toMatch(new RegExp(`window\\.${fn} = async function\\(\\w+\\) \\{\\n  const pid0 = [^\\n]+\\n  if \\(!canChangeEntry\\(`));
    }
    expect(source.match(/class="btn-add"/g)).toHaveLength(1);
    for (const fn of ["openAllergyModal", "openMedicationModal", "openContactModal"]) {
      expect(source).toMatch(new RegExp(`window\\.${fn} = function\\(\\w+\\) \\{\\n  if \\(!canEditCard\\(selectedMemberId\\)\\) return;`));
    }
    // The printable card stays for everyone who can read the card.
    expect(source).toContain('<button class="btn-primary" data-testid="card-print" onclick="printCard()" ${printReady(writesInFlight, pid, careWriteInFlight) ? "" : "disabled"}>Print Card</button>');
  });

  it("uses a card already on the hub when creating it fails", () => {
    const ensure = source.slice(source.indexOf("async function createProfile"), source.indexOf("\n}\n", source.indexOf("async function createProfile")));
    expect(ensure).toContain("const stored = await loadProfileData(memberId).then(() => profiles[memberId], () => null);");
    expect(ensure).toContain("if (stored) return stored;\n    throw e;");
    // Single-flight per member: concurrent callers share one INSERT or recovery.
    const flight = source.slice(source.indexOf("function ensureProfile("), source.indexOf("async function createProfile"));
    expect(flight).toContain("let creating = profileCreations.get(memberId);");
    expect(flight).toContain("creating = createProfile(memberId).finally(() => profileCreations.delete(memberId));\n    profileCreations.set(memberId, creating);");
    expect(ensure).toContain("profiles[memberId] ??= {");
  });

  it("reads a thrown INSERT back by its id: found, it landed and says nothing", () => {
    const persistBody = source.slice(source.indexOf("async function settleWrite("), source.indexOf("\n}\n", source.indexOf("async function settleWrite(")));
    expect(persistBody).toContain("if (insert && outcomeUnknown(e) && await rowStored(insert.table, insert.row.id)) {\n      insertLanded(insert);\n      return;\n    }");
    expect(persistBody.indexOf("rowStored(")).toBeLessThan(persistBody.indexOf("hubAlert("));
    // No status, a 400, or a 5xx other than 507.
    expect(source).toContain("return !status || status === 400 || (status >= 500 && status !== 507);");
    expect(source).toContain("const { rows } = await db(`SELECT id FROM ${table} WHERE id = ?`, [id]);");
  });

  it("says a refused write is a refusal, never \"try again\"", () => {
    expect(source).not.toContain("could not be saved. Try again.");
    expect(source.match(/failureLine\(e, \{ action: "save that change" \}\)/g)).toHaveLength(4);
    expect(source).toContain('failureLine(e, { action: "change who reads this card" })');
    expect(source).toContain('failureLine(e, { action: "choose the care team" })');
  });

  it("tells an admin the care team could not be checked, with a way to read it again", () => {
    expect(source).toContain('data-testid="care-team-error"');
    expect(source).toContain('onclick="retryCareTeam()"');
    expect(source).toContain("window.retryCareTeam = async function() {");
  });

  it("reads every card in one request, answered by the preload on first render", () => {
    const load = source.slice(source.indexOf("async function loadAllProfileData"), source.indexOf("function ensureProfile("));
    expect(load).toContain("[pr, ar, mr, cr] = await dbBatch([");
    expect(load).not.toContain("Promise.all([\n      db(");
    // One card (the recovery read) is one request too: its entries are joined to it.
    const one = source.slice(source.indexOf("async function loadProfileData"), source.indexOf("function withPending("));
    expect(one).toContain("const [profileRes, ar, mr, cr] = await dbBatch([");
    expect(one).not.toContain("await db(");
    expect(source).toContain("body: JSON.stringify({ statements: statements.map(({ sql, params = [] }) => ({ sql, params })) }),");
  });

  it("lists, for a member who is not an adult, every card the hub let them read", () => {
    // The hub's SELECT decides; the page's copy of the care-team rule labels only.
    expect(source).toContain("const listed = IS_ADULT ? members : members.filter(m => !!profiles[m.id]);");
    expect(source).toContain("if (!IS_ADULT && !profilesLoaded) {");
  });
});

describe("logic", () => {
  const adult = { id: "a1", role: "adult" };
  const kid = { id: "k1", role: "child" };
  const nanny = { id: "g1", role: "guest" };
  const groups = [{ id: "g-care", name: "Care team", memberIds: ["g1"] }];
  const kidCard = { id: "p1", member_id: "k1", visibility: VISIBILITY_CARE };
  const adultCard = { id: "p2", member_id: "a1", visibility: VISIBILITY_ADULTS };

  it("names the care team by the configured group, and nobody when there is none", () => {
    expect(isCareTeamMember(nanny, groups, "g-care")).toBe(true);
    expect(isCareTeamMember(kid, groups, "g-care")).toBe(false);
    expect(isCareTeamMember(nanny, groups, null)).toBe(false);
    expect(isCareTeamMember(nanny, groups, "g-gone")).toBe(false);
    expect(isCareTeamMember(null, groups, "g-care")).toBe(false);
    expect(isCareTeamMember(nanny, undefined, "g-care")).toBe(false);
  });

  it("offers sharing on your own card and a child's, never another adult's or a guest's", () => {
    const other = { id: "a2", role: "adult" };
    const admin = { id: "ad", role: "admin" };
    const members = [adult, other, admin, kid, nanny];
    expect(canShareWithCareTeam("a1", adult, members)).toBe(true);
    expect(canShareWithCareTeam("k1", adult, members)).toBe(true);
    expect(canShareWithCareTeam("g1", adult, members)).toBe(false);
    expect(canShareWithCareTeam("a2", adult, members)).toBe(false);
    expect(canShareWithCareTeam("ad", adult, members)).toBe(false);
    expect(canShareWithCareTeam("k1", nanny, members)).toBe(false);
    expect(canShareWithCareTeam("k1", kid, members)).toBe(false);
    expect(canShareWithCareTeam("gone", adult, members)).toBe(false);
    expect(canShareWithCareTeam(null, adult, members)).toBe(false);
  });

  it("picks the failure line from the status", () => {
    expect(failureLine({ status: 403 }, { action: "save that change" })).toBe("You don’t have permission to save that change.");
    expect(failureLine({ status: 507 }, { action: "save that change" })).toBe("The household’s storage is full — free up space first.");
    expect(failureLine({ status: 500 }, { action: "save that change" })).toBe("Couldn’t save that change — try again.");
    expect(failureLine(new Error("no answer"), { action: "save that change" })).toBe("Couldn’t save that change — try again.");
    expect(failureLine(null, { action: "save that change" })).toBe("Couldn’t save that change — try again.");
  });

  it("tells a card shared with the care team from one kept with the adults", () => {
    expect(isCareProfile(kidCard)).toBe(true);
    expect(isCareProfile(adultCard)).toBe(false);
    expect(isCareProfile(null)).toBe(false);
  });
});

describe("a write that failed when its re-read failed too", () => {
  const card = () => [
    { id: "a1", name: "Peanuts", severity: "anaphylactic" },
    { id: "a2", name: "Bees", severity: "moderate" },
    { id: "a3", name: "Dust", severity: "mild" },
  ];

  it("takes an add back off the card", () => {
    const list = card();
    const before = entrySnapshot(list, "new");
    expect(before).toEqual({ id: "new", row: null, index: -1 });
    list.push({ id: "new", name: "Shellfish", severity: "severe" });
    expect(restoreEntry(list, before)).toEqual(card());
  });

  it("puts an edited entry back as it was stored, in its place", () => {
    const list = card();
    const before = entrySnapshot(list, "a2");
    list[1] = { ...list[1], name: "Wasps", severity: "anaphylactic" };
    expect(before.row).toEqual({ id: "a2", name: "Bees", severity: "moderate" });
    expect(restoreEntry(list, before)).toEqual(card());
  });

  it("puts a removed entry back at its position", () => {
    const before = entrySnapshot(card(), "a1");
    const list = card().filter(r => r.id !== "a1");
    expect(restoreEntry(list, before)).toEqual(card());
    // Past the end of a list that shrank meanwhile: it goes last.
    expect(restoreEntry([], entrySnapshot(card(), "a3"))).toEqual([card()[2]]);
  });

  it("keeps a copy, so a change made on the page after the snapshot does not leak into it", () => {
    const list = card();
    const before = entrySnapshot(list, "a1");
    list[0].name = "Tree nuts";
    expect(restoreEntry(list, before)[0].name).toBe("Peanuts");
  });

  it("prints only confirmed entries: an add still in flight stays off the card", () => {
    const list = [...card(), { id: "new", name: "Shellfish" }];
    expect(confirmedEntries(list, new Set(["new"])).map(r => r.id)).toEqual(["a1", "a2", "a3"]);
    expect(confirmedEntries(list, new Set()).map(r => r.id)).toEqual(["a1", "a2", "a3", "new"]);
    expect(confirmedEntries(undefined, new Set())).toEqual([]);
  });

  it("is wired into persist: restored only when the re-read fails, on both failure paths", () => {
    const start = source.indexOf("async function settleWrite(");
    const body = source.slice(start, source.indexOf("\n}\n", start));
    expect(body).toContain("if (!await reread()) restoreConfirmed(before);");
    expect(body).toContain("if (!readBack) restoreConfirmed(before);");
    // The lost-response read-back still runs the success path first.
    expect(body.indexOf("insertLanded(insert);")).toBeLessThan(body.indexOf("restoreConfirmed("));
    // A refused re-read (accessDenied, nothing refreshed) is a failed one too —
    // run for real in "the recovery re-read when the hub refuses the reads".
    expect(source).toContain("    await loadAllProfileData();\n  } catch (e) {\n    console.error(e);\n    return false;\n  }\n  return !accessDenied;\n}");
  });

  it("snapshots every add, edit and remove before it changes the card, and hands it to persist", () => {
    for (const [kind, idVar] of [["allergies", "allergyId"], ["medications", "medId"], ["contacts", "contactId"]]) {
      expect(source).toContain(`const before = snapshotEntry("${kind}", pid, ${idVar});`);
      expect(source).toContain(`const before = snapshotEntry("${kind}", pid, id);`);
      expect(source).toContain(`const before = pid ? snapshotEntry("${kind}", pid, ${idVar}) : null;`);
      expect(source).toContain(`kind: "${kind}", row }, before).finally(render);`);
    }
    const calls = source.match(/\bpersist\(db\(/g) ?? [];
    expect(calls).toHaveLength(9);
    expect(source.match(/\w+, null, before\);|row \}, before\)\.finally\(render\);/g)).toHaveLength(9);
  });

  it("builds the printed card from confirmed entries only", () => {
    const start = source.indexOf("window.printCard = function()");
    const body = source.slice(start, source.indexOf("\n};\n", start));
    for (const kind of ["allergies", "medications", "contacts"]) {
      expect(body).toContain(`confirmedEntries(${kind}[pid], pendingInserts)`);
    }
  });
});

describe("migration 003 care team", () => {
  const roots = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const sql = (db, text) => execFileSync("sqlite3", [db], { input: text, encoding: "utf8" });
  const rows = (db, q) => { const out = execFileSync("sqlite3", ["-json", db, q], { encoding: "utf8" }); return out.trim() ? JSON.parse(out) : []; };
  const migration = (name) => readFileSync(join(__dirname, `../migrations/${name}`), "utf8");

  it("keeps every existing card with the adults, credits old entries to the card's member, and keys the settings", () => {
    const root = mkdtempSync(join(tmpdir(), "health-cards-migration-"));
    roots.push(root);
    const db = join(root, "cards.sqlite");
    sql(db, migration("001_init.sql"));
    sql(db, migration("002_card_name.sql"));
    sql(db, `INSERT INTO app_health_cards__health_profiles (id, member_id, notes, created_at, updated_at) VALUES ('p1', 'm1', '', 't', 't');
             INSERT INTO app_health_cards__health_profiles (id, member_id, notes, created_at, updated_at) VALUES ('p2', 'm2', '', 't', 't');
             INSERT INTO app_health_cards__health_allergies (id, profile_id, name, created_at) VALUES ('a1', 'p1', 'Peanuts', 't');
             INSERT INTO app_health_cards__health_allergies (id, profile_id, name, created_at) VALUES ('a2', 'p2', 'Bees', 't');
             INSERT INTO app_health_cards__health_allergies (id, profile_id, name, created_at) VALUES ('a3', 'gone', 'Dust', 't');
             INSERT INTO app_health_cards__health_medications (id, profile_id, name, created_at) VALUES ('d1', 'p1', 'EpiPen', 't');
             INSERT INTO app_health_cards__health_medications (id, profile_id, name, created_at) VALUES ('d2', 'gone', 'Inhaler', 't');
             INSERT INTO app_health_cards__health_contacts (id, profile_id, name, created_at) VALUES ('c1', 'p2', 'Dr. Smith', 't');
             INSERT INTO app_health_cards__health_contacts (id, profile_id, name, created_at) VALUES ('c2', 'gone', 'Gran', 't');`);

    sql(db, migration("003_care_team.sql"));

    expect(rows(db, `SELECT visibility FROM app_health_cards__health_profiles`)).toEqual([{ visibility: "adults" }, { visibility: "adults" }]);
    // An entry whose card is gone is deleted (a new card reusing the id
    // cannot adopt it); every other old entry is credited to its card's
    // member (the writer the row policy matches).
    const writers = (t) => rows(db, `SELECT id, created_by FROM app_health_cards__${t} ORDER BY id`);
    expect(writers("health_allergies")).toEqual([{ id: "a1", created_by: "m1" }, { id: "a2", created_by: "m2" }]);
    expect(writers("health_medications")).toEqual([{ id: "d1", created_by: "m1" }]);
    expect(writers("health_contacts")).toEqual([{ id: "c1", created_by: "m2" }]);
    // A replay (migrations replay from the start after a partial failure)
    // leaves a writer the hub stamped since, and an entry with a card, alone.
    sql(db, `INSERT INTO app_health_cards__health_allergies (id, profile_id, name, created_at, created_by) VALUES ('a4', 'p1', 'Milk', 't', 'm9')`);
    const replay = migration("003_care_team.sql").match(/^(?:DELETE|UPDATE) [\s\S]*?;/gm);
    expect(replay).toHaveLength(6);
    expect(replay.slice(0, 3).every((s) => s.startsWith("DELETE"))).toBe(true);
    sql(db, replay.join("\n"));
    expect(writers("health_allergies")).toEqual([
      { id: "a1", created_by: "m1" }, { id: "a2", created_by: "m2" }, { id: "a4", created_by: "m9" },
    ]);
    expect(rows(db, `SELECT key, value FROM app_health_cards__settings`)).toEqual([]);
    sql(db, `INSERT INTO app_health_cards__settings (key, value) VALUES ('care_team_group_id', 'g1')`);
    expect(() => sql(db, `INSERT INTO app_health_cards__settings (key, value) VALUES ('care_team_group_id', 'g2')`)).toThrow();
  });
});

// The page's own recovery read, run against a hub that refuses the reads
// (403): a refused save followed by a refused re-read is a FAILED recovery,
// so persist puts the entry back as last confirmed.
describe("the recovery re-read when the hub refuses the reads", () => {
  // A top-level function of the page, `async` included when it has it.
  const fnText = (name) => {
    const at = source.search(new RegExp(`^(async )?function ${name}\\(`, "m"));
    return source.slice(at, source.indexOf("\n}\n", at) + 2);
  };
  function page(batch) {
    const body = `
      let DB = "/db", accessDenied = false, profilesLoaded = false, readSeq = 0;
      let members = [], profiles = {}, allergies = {}, medications = {}, contacts = {};
      const pendingInserts = new Set(), landedAt = new Map(), openReads = new Set();
      const dbBatch = batch, isSafeId = () => true;
      ${fnText("readDone")}
      ${fnText("withPending")}
      ${fnText("loadAllProfileData")}
      ${fnText("reread")}
      return { reread, denied: () => accessDenied };`;
    return new Function("batch", body)(batch);
  }

  it("reports a refused re-read as failed", async () => {
    const p = page(async () => { throw Object.assign(new Error("no"), { status: 403 }); });
    expect(await p.reread()).toBe(false);
    expect(p.denied()).toBe(true);
  });

  it("reports an answered re-read as succeeded", async () => {
    const p = page(async () => [{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }]);
    expect(await p.reread()).toBe(true);
  });
});

describe("printing waits for every write on the card", () => {
  it("is ready only when no write on that card, and no care-team switch write, is in flight", () => {
    const inFlight = new Map([["p1", 1]]);
    expect(printReady(inFlight, "p1")).toBe(false);
    expect(printReady(inFlight, "p2")).toBe(true);
    expect(printReady(new Map(), "p1")).toBe(true);
    expect(printReady(new Map(), "p1", true)).toBe(false);
    expect(printReady(new Map([["p1", 0]]), "p1")).toBe(true);
    expect(printReady(undefined, null)).toBe(true);
  });

  it("counts every write through persist, by its card, until it settles", () => {
    const start = source.indexOf("async function persist(");
    const body = source.slice(start, source.indexOf("\n}\n", start));
    expect(body).toContain("const card = before?.pid ?? insert?.row.profile_id ?? null;");
    expect(body).toContain("writesInFlight.set(card, (writesInFlight.get(card) ?? 0) + 1);");
    expect(body).toMatch(/try \{\n    await settleWrite\(write, rowId, insert, before\);\n  \} finally \{[\s\S]*writesInFlight\.delete\(card\);\n    entriesInFlight\.delete\(before\?\.id \?\? rowId\);\n    entriesFailed\.delete\(before\?\.id \?\? rowId\);\n    render\(\);\n  \}/);
    // Every add, edit and remove goes through persist (9 calls) with its card's snapshot.
    expect(source.match(/\bpersist\(db\(/g)).toHaveLength(9);
    expect(source.match(/\bsettleWrite\(/g)).toHaveLength(2);
  });

  it("disables Print Card and refuses to print while a write is in flight", () => {
    const start = source.indexOf("window.printCard = function()");
    const body = source.slice(start, source.indexOf("\n};\n", start));
    expect(body).toContain("if (!member || accessDenied) return;");
    expect(body).toContain('if (!printReady(writesInFlight, pid, careWriteInFlight)) {\n    hubAlert("Wait for your changes to save, then print.");\n    return;\n  }');
    expect(body.indexOf("printReady(")).toBeLessThan(body.indexOf("printCardMarkup("));
    expect(source.match(/onclick="printCard\(\)"/g)).toHaveLength(1);
  });

  it("shows the access-denied view over an open card", () => {
    expect(source).toContain("if (selectedMemberId && !accessDenied) renderDetail();\n  else renderList();");
  });
});

// Overlapping edits on one entry: the second edit's snapshot would be the
// first edit's unsaved value, and a double failure (write + re-read) would
// restore it. The page serializes changes per entry instead — run here
// against the page's own functions.
describe("one change at a time on an entry", () => {
  const fnText = (name) => {
    const at = source.search(new RegExp(`^(async )?function ${name}\\(`, "m"));
    return source.slice(at, source.indexOf("\n}\n", at) + 2);
  };
  const windowFn = (name) => {
    const at = source.indexOf(`window.${name} = `);
    return source.slice(at, source.indexOf("\n};\n", at) + 3);
  };
  const decl = (name) => {
    const m = source.match(new RegExp(`^const ${name} = .*;$`, "m"));
    return m ? m[0] : "";
  };
  function page() {
    const body = `
      const window = {};
      let DB = "/db", accessDenied = false, careWriteInFlight = false, modal = null;
      const WRITER = "m1", selectedMemberId = "m1";
      const profiles = { m1: { id: "p1" } };
      let allergies = {}, contacts = {};
      let medications = { p1: [{ id: "med1", profile_id: "p1", name: "EpiPen", dose: "0.15mg", when_to_give: "", location: "", notes: "", created_by: "m1" }] };
      const pendingInserts = new Set(), writesInFlight = new Map(), landedAt = new Map();
      ${decl("entriesInFlight")}
      ${decl("entriesFailed")}
      let readSeq = 0;
      const fields = {};
      const document = { getElementById: (id) => ({ value: fields[id] ?? "", focus() {} }) };
      const canEditCard = () => true, supervisesCard = () => false;
      const ensureProfile = async () => profiles.m1;
      const openModal = (html) => { modal = html; }, closeModal = () => { modal = null; };
      const render = () => {}, hubAlert = () => {}, failureLine = () => "x", esc = (s) => String(s ?? "");
      const reread = async () => false; // the recovery re-read fails too
      const pending = [];
      const db = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
      ${fnText("canChangeEntry")}
      ${fnText("wroteNothing")}
      ${fnText("entryOnPage")}
      ${fnText("persist")}
      ${fnText("settleWrite")}
      ${fnText("entryLists")}
      ${fnText("snapshotEntry")}
      ${fnText("restoreConfirmed")}
      ${fnText("outcomeUnknown")}
      ${fnText("insertLanded")}
      ${windowFn("openMedicationModal")}
      ${windowFn("submitMedicationForm")}
      return {
        window, pending, fields, medications: () => medications, modal: () => modal,
        canChangeEntry, printReady: () => (writesInFlight.get("p1") ?? 0) === 0,
      };`;
    return new Function("entrySnapshot", "restoreEntry", body)(entrySnapshot, restoreEntry);
  }
  const flush = () => new Promise(r => setTimeout(r, 0));
  const editDose = async (p, dose) => {
    p.window.openMedicationModal("med1");
    if (!p.modal()) return false;
    Object.assign(p.fields, { "f-med-name": "EpiPen", "f-med-dose": dose });
    await p.window.submitMedicationForm("med1");
    return true;
  };

  it("refuses a second edit while the first is in flight, and a double failure restores the confirmed value", async () => {
    const p = page();
    expect(await editDose(p, "A")).toBe(true);
    expect(p.pending).toHaveLength(1);
    const entry = () => p.medications().p1.find(r => r.id === "med1");
    expect(entry().dose).toBe("A");
    // Edit/Remove are not offered, and the modal refuses to open.
    expect(p.canChangeEntry(entry())).toBe(false);
    expect(await editDose(p, "B")).toBe(false);
    expect(p.pending).toHaveLength(1);
    // The save fails and so does the recovery re-read: back to what is stored.
    p.pending[0].reject(Object.assign(new Error("no"), { status: 403 }));
    await flush();
    expect(entry().dose).toBe("0.15mg");
    // Settled: the entry is offered again, and the card prints the stored value.
    expect(p.canChangeEntry(entry())).toBe(true);
    expect(p.printReady()).toBe(true);
    expect(await editDose(p, "B")).toBe(true);
    expect(p.pending).toHaveLength(2);
  });

  it("holds the entry from before the optimistic change until the write settles, on every edit and remove", () => {
    const start = source.indexOf("async function persist(");
    const body = source.slice(start, source.indexOf("\n}\n", start));
    expect(body).toMatch(/\} finally \{[\s\S]*entriesInFlight\.delete\(/);
    expect(fnText("canChangeEntry")).toContain("!entriesInFlight.has(entry?.id)");
  });
});

// A recovery re-read (after one entry's write fails) rebuilds the lists from
// the hub while another entry's edit or remove is still in flight: the page
// keeps that entry as the member left it until its own write settles — run
// here against the page's own functions, the re-read included.
describe("a recovery re-read keeps another entry's change in flight", () => {
  const fnText = (name) => {
    const at = source.search(new RegExp(`^(async )?function ${name}\\(`, "m"));
    return source.slice(at, source.indexOf("\n}\n", at) + 2);
  };
  const windowFn = (name) => {
    const at = source.indexOf(`window.${name} = `);
    return source.slice(at, source.indexOf("\n};\n", at) + 3);
  };
  const decl = (name) => {
    const m = source.match(new RegExp(`^const ${name} = .*;$`, "m"));
    return m ? m[0] : "";
  };
  const med = (id, dose) => ({ id, profile_id: "p1", name: id, dose, when_to_give: "", location: "", notes: "", created_by: "m1" });
  function page() {
    const body = `
      const window = {};
      let DB = "/db", accessDenied = false, careWriteInFlight = false, modal = null, profilesLoaded = false;
      const WRITER = "m1", selectedMemberId = "m1", members = [{ id: "m1" }];
      let profiles = { m1: { id: "p1", member_id: "m1" } };
      let allergies = {}, contacts = {};
      // What the hub stores, and what the page shows.
      const stored = { medA: med("medA", "1mg"), medB: med("medB", "5mg") };
      let medications = { p1: Object.values(stored).map(r => ({ ...r })) };
      const pendingInserts = new Set(), writesInFlight = new Map(), landedAt = new Map();
      ${decl("entriesInFlight")}
      ${decl("entriesFailed")}
      let readSeq = 0;
      const fields = {};
      const document = { getElementById: (id) => ({ value: fields[id] ?? "", focus() {} }) };
      const canEditCard = () => true, supervisesCard = () => false, isSafeId = (s) => typeof s === "string";
      const ensureProfile = async () => profiles.m1;
      const hubConfirm = async () => true;
      const openModal = (html) => { modal = html; }, closeModal = () => { modal = null; };
      const render = () => {}, hubAlert = () => {}, failureLine = () => "x", esc = (s) => String(s ?? "");
      let readFails = false, holdReads = false;
      const heldReads = [];
      // A read answers with what is stored when it begins; held, it answers
      // only when released (a slow read that finishes after a later save).
      const dbBatch = async () => {
        if (readFails) throw new Error("offline");
        const answer = [
          { rows: [profiles.m1] }, { rows: [] },
          { rows: Object.values(stored).map(r => ({ ...r })) }, { rows: [] },
        ];
        if (!holdReads) return answer;
        return new Promise(resolve => heldReads.push(() => resolve(answer)));
      };
      // Each write waits; settled with ok, it lands in the store.
      const pending = [];
      const db = (sql, params) => new Promise((resolve, reject) => pending.push({
        reject,
        ok() {
          if (sql.startsWith("DELETE")) delete stored[params[0]];
          else stored[params[5]] = { ...stored[params[5]], dose: params[1] };
          resolve({ changed: 1 });
        },
      }));
      ${fnText("canChangeEntry")}
      ${fnText("wroteNothing")}
      ${fnText("entryOnPage")}
      ${fnText("persist")}
      ${fnText("settleWrite")}
      ${fnText("reread")}
      ${fnText("entryLists")}
      ${fnText("snapshotEntry")}
      ${fnText("restoreConfirmed")}
      ${fnText("outcomeUnknown")}
      ${fnText("insertLanded")}
      ${decl("openReads")}
      ${fnText("readDone")}
      ${fnText("changeLanded")}
      ${fnText("withPending")}
      ${fnText("loadAllProfileData")}
      ${windowFn("openMedicationModal")}
      ${windowFn("submitMedicationForm")}
      ${windowFn("deleteMedication")}
      return {
        window, pending, fields, setReadFails: (v) => { readFails = v; },
        holdReads: (v) => { holdReads = v; }, heldReads, stored, reread, landed: (id) => landedAt.has(id),
        dose: (id) => (medications.p1 ?? []).find(r => r.id === id)?.dose,
        printed: (id) => confirmedEntries(medications.p1, pendingInserts).find(r => r.id === id)?.dose,
        printReady: () => (writesInFlight.get("p1") ?? 0) === 0,
      };`;
    return new Function("entrySnapshot", "restoreEntry", "confirmedEntries", "med", body)(entrySnapshot, restoreEntry, confirmedEntries, med);
  }
  const flush = () => new Promise(r => setTimeout(r, 0));
  const editDose = async (p, id, dose) => {
    p.window.openMedicationModal(id);
    Object.assign(p.fields, { "f-med-name": id, "f-med-dose": dose });
    await p.window.submitMedicationForm(id);
  };
  const failB = async (p, i) => {
    p.pending[i].reject(Object.assign(new Error("no"), { status: 403 }));
    await flush();
  };

  it("an edit in flight keeps its new value through another entry's recovery re-read, and is the stored value once it saves", async () => {
    const p = page();
    await editDose(p, "medA", "2mg");
    await editDose(p, "medB", "10mg");
    expect(p.pending).toHaveLength(2);
    await failB(p, 1);
    expect(p.dose("medB")).toBe("5mg");   // B's failure shows what is stored
    expect(p.dose("medA")).toBe("2mg");   // A's edit is not undone by that read
    expect(p.printReady()).toBe(false);   // A is still in flight: no printing
    p.pending[0].ok();
    await flush();
    expect(p.dose("medA")).toBe("2mg");
    expect(p.printReady()).toBe(true);
  });

  it("an edit kept through another entry's re-read still goes back to its confirmed value when it fails", async () => {
    const p = page();
    await editDose(p, "medA", "2mg");
    await editDose(p, "medB", "10mg");
    await failB(p, 1);
    expect(p.dose("medA")).toBe("2mg");
    // A fails; its own re-read shows what is stored.
    p.pending[0].reject(Object.assign(new Error("no"), { status: 403 }));
    await flush();
    expect(p.dose("medA")).toBe("1mg");
    expect(p.printReady()).toBe(true);
  });

  it("an edit kept through another entry's re-read is restored from its own snapshot when it and its re-read fail", async () => {
    const p = page();
    await editDose(p, "medA", "2mg");
    await editDose(p, "medB", "10mg");
    await failB(p, 1);
    expect(p.dose("medA")).toBe("2mg");
    p.setReadFails(true);
    p.pending[0].reject(Object.assign(new Error("no"), { status: 403 }));
    await flush();
    expect(p.dose("medA")).toBe("1mg");
    expect(p.printReady()).toBe(true);
  });

  it("a remove in flight is not brought back by another entry's recovery re-read", async () => {
    const p = page();
    await p.window.deleteMedication("medA");
    await editDose(p, "medB", "10mg");
    expect(p.dose("medA")).toBeUndefined();
    await failB(p, 1);
    expect(p.dose("medB")).toBe("5mg");
    expect(p.dose("medA")).toBeUndefined();
    expect(p.printReady()).toBe(false);
    p.pending[0].ok();
    await flush();
    expect(p.dose("medA")).toBeUndefined();
    expect(p.printReady()).toBe(true);
  });

  // The recovery re-read begins before A saves and answers after A's lock is
  // released: A is no longer in flight, and the read carries A's old value.
  it("an edit that saves while another entry's recovery re-read is out keeps its saved value when that read answers late", async () => {
    const p = page();
    await editDose(p, "medA", "2mg");
    await editDose(p, "medB", "10mg");
    p.holdReads(true);
    p.pending[1].reject(Object.assign(new Error("no"), { status: 403 }));
    await flush();
    expect(p.heldReads).toHaveLength(1);  // B's recovery read began: A is 1mg in it
    p.pending[0].ok();                    // A saves and releases its lock
    await flush();
    expect(p.stored.medA.dose).toBe("2mg");
    p.heldReads[0]();                     // B's read answers with A's old dose
    await flush();
    expect(p.dose("medB")).toBe("5mg");
    expect(p.dose("medA")).toBe("2mg");
    expect(p.printReady()).toBe(true);
    expect(p.printed("medA")).toBe("2mg");
  });

  it("a remove that lands while another entry's recovery re-read is out is not brought back when that read answers late", async () => {
    const p = page();
    await p.window.deleteMedication("medA");
    await editDose(p, "medB", "10mg");
    p.holdReads(true);
    p.pending[1].reject(Object.assign(new Error("no"), { status: 403 }));
    await flush();
    expect(p.heldReads).toHaveLength(1);
    p.pending[0].ok();
    await flush();
    expect(p.stored.medA).toBeUndefined();
    p.heldReads[0]();
    await flush();
    expect(p.dose("medA")).toBeUndefined();
    expect(p.printed("medA")).toBeUndefined();
    expect(p.printReady()).toBe(true);
  });

  it("a landed change is forgotten once no read that began before it is out: a newer read shows what is stored", async () => {
    const p = page();
    await editDose(p, "medA", "2mg");
    await editDose(p, "medB", "10mg");
    p.holdReads(true);
    await failB(p, 1);
    p.pending[0].ok();
    await flush();
    expect(p.landed("medA")).toBe(true);   // B's older read is still out
    p.heldReads[0]();
    await flush();
    expect(p.landed("medA")).toBe(false);  // nothing older is out: the record goes
    // Someone else changes A; a read begun now shows it, not the page's value.
    p.holdReads(false);
    p.stored.medA = { ...p.stored.medA, dose: "3mg" };
    expect(await p.reread()).toBe(true);
    expect(p.dose("medA")).toBe("3mg");
    expect(p.landed("medA")).toBe(false);
  });

  it("a save that fails is not recorded as landed", async () => {
    const p = page();
    await editDose(p, "medA", "2mg");
    await editDose(p, "medB", "10mg");
    p.holdReads(true);
    await failB(p, 1);
    p.pending[0].reject(Object.assign(new Error("no"), { status: 403 }));
    await flush();
    expect(p.landed("medA")).toBe(false);
    for (const release of p.heldReads) release();
    await flush();
    expect(p.dose("medA")).toBe("1mg");
    expect(p.printed("medA")).toBe("1mg");
  });
});
