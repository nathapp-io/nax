/**
 * The PR title — the one piece of PR metadata derived from a model, and so the
 * one that has to assume the reply is junk.
 *
 * Every guarantee here is on a pure function: the acp node that produces the
 * text cannot be executed in tests, so the sanitiser and its fallback chain
 * live where a test can reach them.
 */
import { describe, expect, test } from "bun:test";
import { parseTitle, resolveTitle, sanitizeTitle, TITLE_MAX_CHARS } from "@/finish";

describe("sanitizeTitle", () => {
  test("keeps a well-formed conventional-commit subject unchanged", () => {
    expect(sanitizeTitle("fix: make the Alembic drift gate able to fail")).toBe(
      "fix: make the Alembic drift gate able to fail",
    );
  });

  test.each([
    ["feat", "feat: add a thing"],
    ["fix", "fix: repair a thing"],
    ["refactor", "refactor: move a thing"],
    ["perf", "perf: speed a thing"],
    ["chore", "chore: bump a thing"],
    ["revert", "revert: undo a thing"],
  ])("accepts the %s type as an existing prefix", (_type, title) => {
    expect(sanitizeTitle(title)).toBe(title);
  });

  test("accepts a scope and a breaking-change marker", () => {
    expect(sanitizeTitle("feat(readyz)!: return 503 on schema drift")).toBe(
      "feat(readyz)!: return 503 on schema drift",
    );
  });

  test("prefixes a bare subject rather than rejecting it", () => {
    // The prose is usually right even when the model forgets the ceremony.
    expect(sanitizeTitle("make the drift gate able to fail")).toBe("feat: make the drift gate able to fail");
  });

  test("keeps only the first line, dropping a rationale written below it", () => {
    expect(sanitizeTitle("fix: repair the gate\n\nBecause it could never fail.")).toBe("fix: repair the gate");
  });

  test.each([
    ['"fix: repair the gate"', "double quotes"],
    ["'fix: repair the gate'", "single quotes"],
    ["`fix: repair the gate`", "backticks"],
    ["**fix: repair the gate**", "bold markers"],
    ['"`fix: repair the gate`"', "nested quoting"],
  ])("strips %s (%s)", (raw) => {
    expect(sanitizeTitle(raw)).toBe("fix: repair the gate");
  });

  test("strips a markdown heading mark", () => {
    expect(sanitizeTitle("## fix: repair the gate")).toBe("fix: repair the gate");
  });

  test("strips trailing sentence punctuation", () => {
    expect(sanitizeTitle("fix: repair the gate.")).toBe("fix: repair the gate");
  });

  test("collapses internal whitespace so the length cap matches what a reader sees", () => {
    expect(sanitizeTitle("fix:   repair    the gate")).toBe("fix: repair the gate");
  });

  test("clamps an over-long title on a word boundary", () => {
    const long = `fix: ${"repair ".repeat(30)}gate`;
    const out = sanitizeTitle(long) as string;
    expect(out.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    // A mid-word cut reads as corruption rather than brevity.
    expect(out.endsWith("repair")).toBe(true);
  });

  test("clamps a title with no spaces at all rather than returning nothing", () => {
    const out = sanitizeTitle(`fix: ${"x".repeat(200)}`) as string;
    expect(out.length).toBe(TITLE_MAX_CHARS);
  });

  test.each([
    ["", "empty"],
    ["   \n  ", "whitespace only"],
    ["feat:", "a bare type with no subject"],
    ["**  **", "only wrapping markers"],
  ])("returns undefined for %s input (%s)", (raw) => {
    expect(sanitizeTitle(raw)).toBeUndefined();
  });

  test("returns undefined for a non-string, and never throws", () => {
    expect(sanitizeTitle(undefined)).toBeUndefined();
    expect(sanitizeTitle(42 as unknown as string)).toBeUndefined(); // test-ratchet-allow: as-unknown-as
  });
});

describe("parseTitle", () => {
  test("reads the sentinel out of a reply that also carries prose", () => {
    const reply = "Let me look at the diff.\n<title>fix: repair the gate</title>\n<narrative>Prose.</narrative>";
    expect(parseTitle(reply)).toBe("fix: repair the gate");
  });

  test("takes the last opening tag, so narrating the tag does not win", () => {
    expect(parseTitle("I'll put it in <title> tags.\n<title>fix: real one</title>")).toBe("fix: real one");
  });

  test("recovers a title when the closing tag is missing", () => {
    expect(parseTitle("<title>fix: repair the gate")).toBe("fix: repair the gate");
  });

  test("returns undefined when the sentinel is absent entirely", () => {
    expect(parseTitle("fix: repair the gate")).toBeUndefined();
  });

  test("returns undefined for an empty sentinel", () => {
    expect(parseTitle("<title>   </title>")).toBeUndefined();
  });
});

describe("resolveTitle", () => {
  test("prefers the model's subject", () => {
    expect(resolveTitle("fix: repair the gate", "schema-drift-gate")).toBe("fix: repair the gate");
  });

  test.each([
    [undefined, "nothing"],
    ["   ", "whitespace"],
    ["feat:", "an unusable subject"],
  ])("falls back to 'feat: <feature>' given %s (%s)", (raw) => {
    // The floor is what shipped before, and what the auto-PR plugin opens with.
    expect(resolveTitle(raw, "schema-drift-gate")).toBe("feat: schema-drift-gate");
  });
});
