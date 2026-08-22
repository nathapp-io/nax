import { describe, expect, test } from "bun:test";
import { MAX_MODIFIED_FILES, applyModifiedFiles, extractSpecModifiedFiles } from "@/prd";
import { makePRD, makeStory } from "@test/helpers";

/** The canonical shape spec-kit's spec-writing guide produces. */
const CANONICAL_SPEC = [
  "# Feature",
  "",
  "## Stories",
  "",
  "1. **US-001: Budget arithmetic** — no dependencies.",
  "2. **US-002: Truncation** — no dependencies.",
  "",
  "### Creates",
  "",
  "**US-001**",
  "- `test/unit/context/engine/available-budget.test.ts` — first tests for an untested module",
  "",
  "### Modifies",
  "",
  "**US-001**",
  '- `test/unit/context/engine/orchestrator.test.ts` — the test named "chunkTokens covers exactly the',
  '  included chunks" (`:99-110`) asserts `summed === usedTokens - digestTokens`. US-001 owns updating',
  "  it to the new invariant.",
  "",
  "**US-002**",
  "- `test/unit/context/rules/canonical-loader.test.ts` — the truncation test asserts a best-fit skip",
  "",
  "### Seams",
  "",
  "- **US-001** something else entirely",
].join("\n");

describe("extractSpecModifiedFiles", () => {
  test("extracts one entry per bullet, attributed to its `**US-00N**` group", () => {
    const entries = extractSpecModifiedFiles(CANONICAL_SPEC);

    expect(entries).toHaveLength(2);
    expect(entries[0].storyId).toBe("US-001");
    expect(entries[0].path).toBe("test/unit/context/engine/orchestrator.test.ts");
    expect(entries[1].storyId).toBe("US-002");
    expect(entries[1].path).toBe("test/unit/context/rules/canonical-loader.test.ts");
  });

  test("folds wrapped continuation lines into the reason verbatim", () => {
    const [first] = extractSpecModifiedFiles(CANONICAL_SPEC);

    expect(first.reason).toContain("chunkTokens covers exactly the included chunks");
    expect(first.reason).toContain("US-001 owns updating it to the new invariant.");
    // The path itself must not survive into the reason — it has its own field.
    expect(first.reason.startsWith("test/unit/")).toBe(false);
  });

  test("stops at the next sibling heading, so neighbouring sections are not absorbed", () => {
    const entries = extractSpecModifiedFiles(CANONICAL_SPEC);

    expect(entries.some((e) => e.path.includes("available-budget"))).toBe(false);
    expect(entries.some((e) => e.reason.includes("something else entirely"))).toBe(false);
  });

  test("ignores a `### Modifies` block written inside a fenced code example", () => {
    const spec = [
      "# Spec about specs",
      "",
      "Authors write the block like this:",
      "",
      "```markdown",
      "### Modifies",
      "",
      "**US-001**",
      "- `src/fabricated.ts` — this is documentation, not a real authorisation",
      "```",
      "",
      "## Design",
    ].join("\n");

    expect(extractSpecModifiedFiles(spec)).toEqual([]);
  });

  test("returns an unattributed entry with a null storyId rather than guessing", () => {
    const spec = ["## Modifies", "", "- `src/orphan.ts` — nobody declared which story owns this"].join("\n");

    const entries = extractSpecModifiedFiles(spec);

    expect(entries).toHaveLength(1);
    expect(entries[0].storyId).toBeNull();
    expect(entries[0].path).toBe("src/orphan.ts");
  });

  test("accepts a parenthetical heading suffix and the `Modified Files` spelling", () => {
    const spec = ["### Modified Files (per story)", "", "**US-003**", "- `src/a.ts` — reason a"].join("\n");

    const entries = extractSpecModifiedFiles(spec);

    expect(entries).toHaveLength(1);
    expect(entries[0].storyId).toBe("US-003");
  });

  test("records a bare path with an empty reason rather than dropping the authorisation", () => {
    const spec = ["### Modifies", "", "**US-001**", "- `src/bare.ts`"].join("\n");

    expect(extractSpecModifiedFiles(spec)).toEqual([{ storyId: "US-001", path: "src/bare.ts", reason: "" }]);
  });

  // A story heading at the section's OWN level is a sibling section, not a group.
  // Exempting it would read `## US-002` as a group and turn every bullet beneath
  // it into a fabricated authorisation.
  test("stops at a same-level story heading instead of swallowing it as a group", () => {
    const spec = [
      "## Modifies",
      "",
      "**US-001**",
      "- `src/real.ts` — genuinely authorised",
      "",
      "## US-002: Second story",
      "",
      "- `src/not-authorised.ts` — this is a story bullet, not a Modifies entry",
    ].join("\n");

    const entries = extractSpecModifiedFiles(spec);

    expect(entries).toEqual([{ storyId: "US-001", path: "src/real.ts", reason: "genuinely authorised" }]);
  });

  test("still reads a DEEPER story heading as a group lead-in", () => {
    const spec = ["### Modifies", "", "#### US-004", "- `src/deep.ts` — grouped by a heading, not bold"].join("\n");

    expect(extractSpecModifiedFiles(spec)).toEqual([
      { storyId: "US-004", path: "src/deep.ts", reason: "grouped by a heading, not bold" },
    ]);
  });

  // Without a path-shape check the first word of a prose bullet becomes a file
  // the implementer is told it may change.
  test("drops a prose bullet instead of inventing a path from its first word", () => {
    const spec = ["### Modifies", "", "**US-001**", "- see the notes below for details"].join("\n");

    expect(extractSpecModifiedFiles(spec)).toEqual([]);
  });

  test("accepts an unbackticked path-shaped token", () => {
    const spec = ["### Modifies", "", "**US-001**", "- src/plain.ts — no backticks here"].join("\n");

    expect(extractSpecModifiedFiles(spec)).toEqual([
      { storyId: "US-001", path: "src/plain.ts", reason: "no backticks here" },
    ]);
  });

  test("returns an empty list for a spec with no Modifies section", () => {
    expect(extractSpecModifiedFiles("# Feature\n\n## Design\n\n- nothing here")).toEqual([]);
    expect(extractSpecModifiedFiles("")).toEqual([]);
  });

  test("caps runaway sections at MAX_MODIFIED_FILES", () => {
    const bullets = Array.from({ length: MAX_MODIFIED_FILES + 10 }, (_, i) => `- \`src/f${i}.ts\` — reason ${i}`);
    const spec = ["### Modifies", "", "**US-001**", ...bullets].join("\n");

    expect(extractSpecModifiedFiles(spec)).toHaveLength(MAX_MODIFIED_FILES);
  });
});

describe("applyModifiedFiles", () => {
  const prdWithTwoStories = () =>
    makePRD({
      userStories: [makeStory({ id: "US-001" }), makeStory({ id: "US-002" })],
    });

  test("attaches each entry to the story that declared it, and to no other", () => {
    const { prd } = applyModifiedFiles(prdWithTwoStories(), CANONICAL_SPEC);

    const [first, second] = prd.userStories;
    expect(first.modifiedFiles).toEqual([
      { path: "test/unit/context/engine/orchestrator.test.ts", reason: expect.stringContaining("chunkTokens") },
    ]);
    expect(second.modifiedFiles).toEqual([
      { path: "test/unit/context/rules/canonical-loader.test.ts", reason: expect.stringContaining("best-fit skip") },
    ]);
  });

  test("reports an unattributed entry as an orphan and attaches it nowhere", () => {
    const spec = ["### Modifies", "", "- `src/orphan.ts` — no owning group"].join("\n");

    const { prd, orphans } = applyModifiedFiles(prdWithTwoStories(), spec);

    expect(orphans).toHaveLength(1);
    expect(orphans[0].path).toBe("src/orphan.ts");
    expect(prd.userStories.every((s) => s.modifiedFiles === undefined)).toBe(true);
  });

  test("reports an entry naming a story absent from the PRD as an orphan", () => {
    const spec = ["### Modifies", "", "**US-999**", "- `src/ghost.ts` — owned by a story that does not exist"].join(
      "\n",
    );

    const { prd, orphans } = applyModifiedFiles(prdWithTwoStories(), spec);

    expect(orphans).toHaveLength(1);
    expect(orphans[0].storyId).toBe("US-999");
    expect(prd.userStories.every((s) => s.modifiedFiles === undefined)).toBe(true);
  });

  test("deduplicates repeated paths within one story, keeping the first reason", () => {
    const spec = [
      "### Modifies",
      "",
      "**US-001**",
      "- `src/dup.ts` — first reason",
      "- `src/dup.ts` — second reason",
    ].join("\n");

    const { prd } = applyModifiedFiles(prdWithTwoStories(), spec);

    expect(prd.userStories[0].modifiedFiles).toEqual([{ path: "src/dup.ts", reason: "first reason" }]);
  });

  // The plan op runs validatePlanOutput in `parse` but this carry in `verify`,
  // so without a check here an escaping path reaches prd.json and the
  // implementer's authorisation block without meeting the schema's path policy.
  test.each([
    ["an absolute path", "/etc/passwd"],
    ["a traversing path", "../../../etc/passwd"],
    ["a traversal buried mid-path", "src/../../secrets.txt"],
  ])("rejects %s instead of attaching it", (_label, path) => {
    const input = prdWithTwoStories();
    const spec = ["### Modifies", "", "**US-001**", `- \`${path}\` — looks legitimate`].join("\n");

    const { prd, invalidPaths, orphans } = applyModifiedFiles(input, spec);

    expect(invalidPaths).toHaveLength(1);
    expect(invalidPaths[0].path).toBe(path);
    expect(orphans).toEqual([]);
    expect(prd).toBe(input);
    expect(prd.userStories.every((s) => s.modifiedFiles === undefined)).toBe(true);
  });

  test.each([
    ["a filename containing two dots", "src/foo..bar.ts"],
    ["a snapshot pair filename", "test/fixtures/v1..v2.snap"],
    ["a dotted directory segment", "src/a..b/c.ts"],
  ])("accepts %s — '..' as a substring is not traversal", (_label, path) => {
    // A bare `includes("..")` also rejected legitimate filenames that merely
    // contain two dots, silently dropping a valid authorisation. Traversal is a
    // whole path SEGMENT, not a substring.
    const spec = ["### Modifies", "", "**US-001**", `- \`${path}\` — legitimate`].join("\n");

    const { prd, invalidPaths } = applyModifiedFiles(prdWithTwoStories(), spec);

    expect(invalidPaths).toEqual([]);
    expect(prd.userStories[0].modifiedFiles).toEqual([{ path, reason: "legitimate" }]);
  });

  test("still rejects a Windows-style traversing segment", () => {
    const spec = ["### Modifies", "", "**US-001**", "- `..\\..\\secrets.txt` — nope"].join("\n");

    const { invalidPaths } = applyModifiedFiles(prdWithTwoStories(), spec);

    expect(invalidPaths).toHaveLength(1);
  });

  test("rejects an escaping path while still attaching the safe entries beside it", () => {
    const spec = ["### Modifies", "", "**US-001**", "- `/etc/passwd` — rejected", "- `src/safe.ts` — kept"].join("\n");

    const { prd, invalidPaths } = applyModifiedFiles(prdWithTwoStories(), spec);

    expect(invalidPaths.map((e) => e.path)).toEqual(["/etc/passwd"]);
    expect(prd.userStories[0].modifiedFiles).toEqual([{ path: "src/safe.ts", reason: "kept" }]);
  });

  test("returns the input PRD reference unchanged when the spec declares nothing", () => {
    const input = prdWithTwoStories();
    const { prd, orphans } = applyModifiedFiles(input, "# Feature\n\n## Design");

    expect(prd).toBe(input);
    expect(orphans).toEqual([]);
  });

  test("returns the input PRD reference unchanged when every entry is an orphan", () => {
    const input = prdWithTwoStories();
    const { prd } = applyModifiedFiles(input, "### Modifies\n\n- `src/orphan.ts` — unowned");

    expect(prd).toBe(input);
  });

  test("lets the spec's reason win over a stale one already in the PRD", () => {
    const input = makePRD({
      userStories: [
        makeStory({ id: "US-001", modifiedFiles: [{ path: "src/x.ts", reason: "stale reason from a prior plan" }] }),
        makeStory({ id: "US-002" }),
      ],
    });

    const { prd } = applyModifiedFiles(input, "### Modifies\n\n**US-001**\n- `src/x.ts` — the spec's current reason");

    expect(prd.userStories[0].modifiedFiles).toEqual([{ path: "src/x.ts", reason: "the spec's current reason" }]);
  });

  test("preserves modifiedFiles the PRD already carried for an untouched story", () => {
    const existing = { path: "src/kept.ts", reason: "already there" };
    const input = makePRD({
      userStories: [makeStory({ id: "US-001", modifiedFiles: [existing] }), makeStory({ id: "US-002" })],
    });

    const { prd } = applyModifiedFiles(input, "### Modifies\n\n**US-002**\n- `src/new.ts` — added now");

    expect(prd.userStories[0].modifiedFiles).toEqual([existing]);
    expect(prd.userStories[1].modifiedFiles).toEqual([{ path: "src/new.ts", reason: "added now" }]);
  });
});
