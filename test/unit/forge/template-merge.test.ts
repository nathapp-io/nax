import { describe, expect, test } from "bun:test";
import { TEMPLATE_BY_NAME, TEMPLATE_FIXTURES, UNPARSEABLE_FIXTURE_NAMES } from "@test/fixtures/pr-templates";
import { type BodySection, DEFAULT_SECTION_ALIASES, mergeTemplate } from "@/forge";

/**
 * The nax-authored sections, in the canonical order `buildFinishBody` emits
 * them. `footer` carries no heading, which is how a headingless trailing line
 * is expressed — it must never be matched to a template heading.
 */
function sections(overrides: Partial<Record<string, string>> = {}): BodySection[] {
  const all: BodySection[] = [
    { key: "narrative", heading: "What changed", body: "Adds a description field." },
    { key: "stories", heading: "Stories", body: "| Story | Title | ACs |\n|---|---|---|\n| US-001 | Carry it | 9 |" },
    { key: "verification", heading: "Verification", body: "- Acceptance: passed\n- Gates: build, test" },
    { key: "rounds", heading: "Review rounds", body: "### quality attempt 1\n- _no findings_" },
    { key: "outOfScope", heading: "Out of scope", body: "- Making it required." },
    { key: "footer", heading: "", body: "2/2 stories · 18m 24s" },
  ];
  return all
    .map((s) => (overrides[s.key] !== undefined ? { ...s, body: overrides[s.key] as string } : s))
    .filter((s) => s.body.length > 0);
}

/** Every H2 heading in a rendered body, in order. */
function headings(body: string): string[] {
  return body
    .split("\n")
    .filter((l) => /^##\s/.test(l))
    .map((l) => l.replace(/^##\s+/, ""));
}

/** The text under a given H2, up to the next H2. */
function bodyUnder(body: string, heading: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

describe("mergeTemplate — no template to merge", () => {
  test("renders nax sections in canonical order when the template is absent", () => {
    const out = mergeTemplate(undefined, sections());
    expect(headings(out)).toEqual(["What changed", "Stories", "Verification", "Review rounds", "Out of scope"]);
    expect(out.trimEnd().endsWith("2/2 stories · 18m 24s")).toBe(true);
  });

  test("treats a whitespace-only template as absent", () => {
    expect(mergeTemplate("   \n\n  ", sections())).toBe(mergeTemplate(undefined, sections()));
  });

  test('mode "ignore" drops a perfectly parseable template', () => {
    const out = mergeTemplate(TEMPLATE_BY_NAME.nax, sections(), { mode: "ignore" });
    expect(out).toBe(mergeTemplate(undefined, sections()));
  });

  test.each(UNPARSEABLE_FIXTURE_NAMES)("falls back to the nax body for the unparseable %s template", (name) => {
    const out = mergeTemplate(TEMPLATE_BY_NAME[name], sections());
    expect(out).toBe(mergeTemplate(undefined, sections()));
  });
});

describe("mergeTemplate — this repo's template (the #1504 defect)", () => {
  const merged = mergeTemplate(TEMPLATE_BY_NAME.nax, sections());

  test("adopts the template's headings and order for the sections it can fill", () => {
    expect(headings(merged).slice(0, 3)).toEqual(["What", "How", "Testing"]);
  });

  test("fills each adopted heading with the matching nax content", () => {
    expect(bodyUnder(merged, "What")).toBe("Adds a description field.");
    expect(bodyUnder(merged, "How")).toContain("| US-001 | Carry it | 9 |");
    expect(bodyUnder(merged, "Testing")).toBe("- Acceptance: passed\n- Gates: build, test");
  });

  test("drops template sections nax has nothing to say under", () => {
    expect(headings(merged)).not.toContain("Why");
    expect(headings(merged)).not.toContain("Notes");
  });

  test("appends nax sections the template has no home for, under nax's own headings", () => {
    expect(headings(merged).slice(3)).toEqual(["Review rounds", "Out of scope"]);
  });

  test("emits no unchecked checkbox contradicting the verified gate list", () => {
    expect(merged).not.toContain("- [ ]");
    expect(bodyUnder(merged, "Testing")).toContain("Acceptance: passed");
  });

  test("emits no dangling issue reference", () => {
    expect(merged).not.toMatch(/(closes|fixes|resolves)\s*#\s*$/im);
  });
});

describe("mergeTemplate — corpus invariants", () => {
  const parseable = TEMPLATE_FIXTURES.filter((f) => !UNPARSEABLE_FIXTURE_NAMES.includes(f.name));

  test.each(TEMPLATE_FIXTURES.map((f) => f.name))("%s: never ships an HTML placeholder comment", (name) => {
    expect(mergeTemplate(TEMPLATE_BY_NAME[name], sections())).not.toContain("<!--");
  });

  test.each(TEMPLATE_FIXTURES.map((f) => f.name))("%s: never ships an unchecked checkbox", (name) => {
    expect(mergeTemplate(TEMPLATE_BY_NAME[name], sections())).not.toContain("- [ ]");
  });

  test.each(parseable.map((f) => f.name))("%s: never emits a heading with nothing under it", (name) => {
    const out = mergeTemplate(TEMPLATE_BY_NAME[name], sections());
    for (const heading of headings(out)) expect(bodyUnder(out, heading)).not.toBe("");
  });

  test.each(TEMPLATE_FIXTURES.map((f) => f.name))("%s: carries every nax section through exactly once", (name) => {
    const out = mergeTemplate(TEMPLATE_BY_NAME[name], sections());
    for (const s of sections()) {
      const occurrences = out.split(s.body).length - 1;
      expect(occurrences).toBe(1);
    }
  });
});

describe("mergeTemplate — heading matching", () => {
  test("matches case-insensitively and ignores punctuation", () => {
    const out = mergeTemplate(TEMPLATE_BY_NAME["github-community"], sections());
    expect(bodyUnder(out, "How Has This Been Tested?")).toBe("- Acceptance: passed\n- Gates: build, test");
    expect(bodyUnder(out, "Description")).toBe("Adds a description field.");
  });

  test("drops the unmatched sections of a third-party template", () => {
    const out = mergeTemplate(TEMPLATE_BY_NAME["github-community"], sections());
    expect(headings(out)).not.toContain("Type of change");
    expect(headings(out)).not.toContain("Checklist:");
  });

  test("a sectionMap entry overrides the default alias table", () => {
    const out = mergeTemplate(TEMPLATE_BY_NAME.nax, sections(), { sectionMap: { notes: "outOfScope" } });
    expect(bodyUnder(out, "Notes")).toBe("- Making it required.");
    expect(headings(out)).not.toContain("Out of scope");
  });

  test("a sectionMap entry can suppress a default alias by pointing it at no section", () => {
    const out = mergeTemplate(TEMPLATE_BY_NAME.nax, sections(), { sectionMap: { what: "" } });
    expect(headings(out)).not.toContain("What");
    expect(headings(out)).toContain("What changed");
  });

  test("the first of two headings sharing a key consumes it; the second is dropped", () => {
    const template = "## Summary\n\nx\n\n## Description\n\ny\n";
    const out = mergeTemplate(template, sections());
    expect(bodyUnder(out, "Summary")).toBe("Adds a description field.");
    expect(headings(out)).not.toContain("Description");
  });

  test("the headingless footer is never matched to a template heading", () => {
    const out = mergeTemplate("## Notes\n\n<!-- x -->\n", sections(), { sectionMap: { notes: "footer" } });
    expect(headings(out)).not.toContain("Notes");
    expect(out.trimEnd().endsWith("2/2 stories · 18m 24s")).toBe(true);
  });

  test("a sectionMap key is matched the same way a template heading is — raw, as a human writes it in config", () => {
    // The config schema promises keys match "case- and punctuation-
    // insensitively". A user pins GitLab's default heading by pasting it, not
    // by pre-normalising it to `what does this mr do and why`.
    const out = mergeTemplate(TEMPLATE_BY_NAME["gitlab-default"], sections(), {
      sectionMap: { "Screenshots or screen recordings": "rounds" },
    });
    expect(bodyUnder(out, "Screenshots or screen recordings")).toContain("quality attempt 1");
  });

  test("the default alias table maps the headings the corpus actually uses", () => {
    expect(DEFAULT_SECTION_ALIASES.what).toBe("narrative");
    expect(DEFAULT_SECTION_ALIASES.testing).toBe("verification");
    expect(DEFAULT_SECTION_ALIASES.why).toBeUndefined();
  });
});

describe("mergeTemplate — preamble and frontmatter", () => {
  test("preserves YAML frontmatter verbatim at the top", () => {
    const out = mergeTemplate(TEMPLATE_BY_NAME["with-frontmatter"], sections());
    expect(out.startsWith('---\nname: Standard change\nlabels: ["needs-review", "team/platform"]')).toBe(true);
    expect(out).toContain("assignees: octocat\n---");
  });

  test("frontmatter precedes the first heading", () => {
    const out = mergeTemplate(TEMPLATE_BY_NAME["with-frontmatter"], sections());
    expect(out.indexOf("---")).toBeLessThan(out.indexOf("## Summary"));
  });

  test("keeps preamble prose that survives comment stripping", () => {
    const out = mergeTemplate("Please read CONTRIBUTING.md.\n\n## What\n\n<!-- x -->\n", sections());
    expect(out.startsWith("Please read CONTRIBUTING.md.")).toBe(true);
  });

  test("drops a preamble that was only a placeholder comment", () => {
    const out = mergeTemplate(TEMPLATE_BY_NAME["gitlab-default"], sections());
    expect(out.startsWith("<!--")).toBe(false);
    expect(out).not.toContain("Set the MR title");
  });

  test("drops a dangling issue reference left in the preamble", () => {
    const out = mergeTemplate("Closes #\n\n## What\n\n<!-- x -->\n", sections());
    expect(out).not.toContain("Closes #");
  });

  test("keeps a real issue reference in the preamble", () => {
    const out = mergeTemplate("Closes #1504\n\n## What\n\n<!-- x -->\n", sections());
    expect(out).toContain("Closes #1504");
  });
});

describe('mergeTemplate — "strict" mode', () => {
  const strict = mergeTemplate(TEMPLATE_BY_NAME.nax, sections(), { mode: "strict" });

  test("keeps every template heading so a heading-checking bot still passes", () => {
    expect(headings(strict).slice(0, 5)).toEqual(["What", "Why", "How", "Testing", "Notes"]);
  });

  test("leaves unfillable sections empty rather than shipping their placeholders", () => {
    expect(bodyUnder(strict, "Why")).toBe("");
    expect(bodyUnder(strict, "Notes")).toBe("");
    expect(strict).not.toContain("<!--");
    expect(strict).not.toContain("- [ ]");
  });

  test("still fills the sections it can match", () => {
    expect(bodyUnder(strict, "What")).toBe("Adds a description field.");
    expect(bodyUnder(strict, "Testing")).toBe("- Acceptance: passed\n- Gates: build, test");
  });

  test("still appends the nax sections the template has no home for", () => {
    expect(headings(strict).slice(5)).toEqual(["Review rounds", "Out of scope"]);
  });
});

describe("mergeTemplate — hostile template shapes", () => {
  test("a CRLF template does not leak carriage returns into the body", () => {
    const out = mergeTemplate("## What\r\n\r\n<!-- x -->\r\n\r\n## Testing\r\n\r\n- [ ] tests\r\n", sections());
    expect(out).not.toContain("\r");
    expect(bodyUnder(out, "What")).toBe("Adds a description field.");
  });

  test("strips an unchecked checkbox left in the preamble, above the first heading", () => {
    // A real shape: repos that open with a contributor checklist and only then
    // start their sections. Preamble text is the one template region that
    // survives into the body, so the no-unfilled-field rule has to hold there.
    const out = mergeTemplate("- [ ] I read CONTRIBUTING.md\n\n## What\n\n<!-- x -->\n", sections());
    expect(out).not.toContain("- [ ]");
  });

  test("keeps preamble prose that sits alongside a stripped checkbox", () => {
    const out = mergeTemplate("Please confirm:\n\n- [ ] I read CONTRIBUTING.md\n\n## What\n\n<!-- x -->\n", sections());
    expect(out).toContain("Please confirm:");
    expect(out).not.toContain("- [ ]");
  });

  test("does not mistake a leading horizontal rule for YAML frontmatter", () => {
    const out = mergeTemplate("---\n\nRead the guide.\n\n---\n\n## What\n\n<!-- x -->\n", sections());
    expect(bodyUnder(out, "What")).toBe("Adds a description field.");
    expect(out).toContain("Read the guide.");
  });
});

describe("mergeTemplate — degenerate inputs", () => {
  test("renders the template's shape when nax produced no sections at all", () => {
    const out = mergeTemplate(TEMPLATE_BY_NAME.nax, []);
    expect(out).toBe("");
  });

  test("does not leave a run of blank lines where a section was dropped", () => {
    expect(mergeTemplate(TEMPLATE_BY_NAME.nax, sections())).not.toMatch(/\n{3,}/);
  });

  test("does not emit trailing whitespace on any line", () => {
    const out = mergeTemplate(TEMPLATE_BY_NAME["github-community"], sections());
    for (const line of out.split("\n")) expect(line).toBe(line.trimEnd());
  });

  test("a sectionMap does not leak into the default alias table on the next call", () => {
    const baseline = mergeTemplate(TEMPLATE_BY_NAME.nax, sections());
    mergeTemplate(TEMPLATE_BY_NAME.nax, sections(), { sectionMap: { notes: "outOfScope", what: "" } });
    expect(mergeTemplate(TEMPLATE_BY_NAME.nax, sections())).toBe(baseline);
  });
});
