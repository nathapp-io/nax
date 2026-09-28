import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makePRD, makeStory } from "@test/helpers";
import type { LogEntry } from "@/logger";
import { addSink, initLogger, resetLogger } from "@/logger";
import {
  applyPlanFidelity,
  backfillModifiedFiles,
  backfillOutOfScope,
  warnOnAcCrossReferences,
  warnOnDroppedContextFiles,
} from "@/operations";
import { byCodePoint } from "@/utils/sort";

const SPEC = [
  "# Feature",
  "",
  "## Out of Scope",
  "",
  "- An interactive Ink TUI",
  "",
  "## Stories",
  "",
  "1. **US-001: First** — no dependencies.",
  "2. **US-002: Second** — no dependencies.",
  "",
  "### Modifies",
  "",
  "**US-001**",
  "- `test/unit/engine/orchestrator.test.ts` — the identity no longer holds under the new accounting",
].join("\n");

const twoStoryPrd = () => makePRD({ userStories: [makeStory({ id: "US-001" }), makeStory({ id: "US-002" })] });

describe("backfillModifiedFiles", () => {
  test("attaches a spec-declared entry to its owning story only", () => {
    const result = backfillModifiedFiles(twoStoryPrd(), SPEC, "feat");

    expect(result.userStories[0].modifiedFiles).toEqual([
      {
        path: "test/unit/engine/orchestrator.test.ts",
        reason: "the identity no longer holds under the new accounting",
      },
    ]);
    expect(result.userStories[1].modifiedFiles).toBeUndefined();
  });

  test("drops an entry naming a story the PRD does not contain", () => {
    const spec = ["### Modifies", "", "**US-404**", "- `src/ghost.ts` — owned by nobody here"].join("\n");
    const input = twoStoryPrd();

    const result = backfillModifiedFiles(input, spec, "feat");

    expect(result).toBe(input);
    expect(result.userStories.every((s) => s.modifiedFiles === undefined)).toBe(true);
  });

  test("returns the input reference when the spec declares no Modifies section", () => {
    const input = twoStoryPrd();
    expect(backfillModifiedFiles(input, "# Feature\n\n## Design", "feat")).toBe(input);
  });
});

describe("warnOnDroppedContextFiles — #1466", () => {
  let entries: LogEntry[];

  beforeEach(() => {
    resetLogger();
    initLogger({ level: "debug" });
    entries = [];
    addSink((entry) => entries.push(entry));
  });

  afterEach(() => {
    resetLogger();
  });

  const CONTEXT_FILES_SPEC = [
    "### Context Files",
    "",
    "**US-001**",
    "- `src/a.ts` — read this",
    "- `src/b.ts` — and this",
    "",
    "**US-002**",
    "- `src/c.ts` — this too",
  ].join("\n");

  test("warns once per story with a spec-declared Context Files entry missing from contextFiles", () => {
    const prd = makePRD({
      userStories: [
        makeStory({ id: "US-001", contextFiles: ["src/a.ts"] }), // src/b.ts dropped
        makeStory({ id: "US-002", contextFiles: ["src/c.ts"] }), // fully present
      ],
    });

    warnOnDroppedContextFiles(prd, CONTEXT_FILES_SPEC, "feat");

    const warnings = entries.filter((e) => e.level === "warn" && e.stage === "plan");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].data).toMatchObject({
      featureName: "feat",
      storyId: "US-001",
      droppedCount: 1,
      dropped: ["src/b.ts"],
    });
  });

  test("does not mutate the PRD", () => {
    const prd = makePRD({ userStories: [makeStory({ id: "US-001", contextFiles: ["src/a.ts"] })] });
    const before = JSON.stringify(prd);

    warnOnDroppedContextFiles(prd, CONTEXT_FILES_SPEC, "feat");

    expect(JSON.stringify(prd)).toBe(before);
  });

  test("emits nothing when every spec-declared entry survives", () => {
    const prd = makePRD({
      userStories: [
        makeStory({ id: "US-001", contextFiles: ["src/a.ts", "src/b.ts"] }),
        makeStory({ id: "US-002", contextFiles: ["src/c.ts"] }),
      ],
    });

    warnOnDroppedContextFiles(prd, CONTEXT_FILES_SPEC, "feat");

    expect(entries.filter((e) => e.level === "warn" && e.stage === "plan")).toHaveLength(0);
  });

  test("emits nothing when the spec declares no Context Files section", () => {
    const prd = makePRD({ userStories: [makeStory({ id: "US-001", contextFiles: [] })] });

    warnOnDroppedContextFiles(prd, "# Feature\n\n## Design", "feat");

    expect(entries.filter((e) => e.level === "warn" && e.stage === "plan")).toHaveLength(0);
  });

  test("reports an entry naming a story the PRD does not contain as an orphan, not a per-story drop", () => {
    const prd = makePRD({ userStories: [makeStory({ id: "US-001", contextFiles: [] })] });
    const spec = ["### Context Files", "", "**US-404**", "- `src/ghost.ts` — owned by nobody here"].join("\n");

    warnOnDroppedContextFiles(prd, spec, "feat");

    const warnings = entries.filter((e) => e.level === "warn" && e.stage === "plan");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("name no story in the PRD");
    expect(warnings[0].data).toMatchObject({ orphanCount: 1, orphans: [{ storyId: "US-404", path: "src/ghost.ts" }] });
  });

  test("applyPlanFidelity surfaces the warning without changing the returned PRD's contextFiles", () => {
    const prd = makePRD({ userStories: [makeStory({ id: "US-001", contextFiles: ["src/a.ts"] })] });

    const result = applyPlanFidelity(prd, CONTEXT_FILES_SPEC, "feat");

    expect(result.userStories[0].contextFiles).toEqual(["src/a.ts"]);
    expect(entries.some((e) => e.level === "warn" && e.stage === "plan" && e.data?.storyId === "US-001")).toBe(true);
  });

  test("resolves a contextFiles entry stored as a {path, factId} object, not just a plain string", () => {
    const prd = makePRD({
      userStories: [makeStory({ id: "US-001", contextFiles: [{ path: "src/a.ts", factId: "fact-1" }] })],
    });

    warnOnDroppedContextFiles(prd, CONTEXT_FILES_SPEC, "feat");

    const warning = entries.find((e) => e.level === "warn" && e.stage === "plan" && e.data?.storyId === "US-001");
    expect(warning?.data).toMatchObject({ dropped: ["src/b.ts"] });
  });

  test("normalizes a leading ./ so it does not read as a drop", () => {
    const spec = ["### Context Files", "", "**US-001**", "- `src/a.ts` — a", "- `src/b.ts` — b"].join("\n");
    const prd = makePRD({ userStories: [makeStory({ id: "US-001", contextFiles: ["./src/a.ts", "./src/b.ts"] })] });

    warnOnDroppedContextFiles(prd, spec, "feat");

    expect(entries.filter((e) => e.level === "warn" && e.stage === "plan")).toHaveLength(0);
  });

  test("dedupes a spec-declared path listed twice for the same story instead of double-counting the drop", () => {
    const spec = ["### Context Files", "", "**US-001**", "- `src/b.ts` — first", "- `src/b.ts` — again"].join("\n");
    const prd = makePRD({ userStories: [makeStory({ id: "US-001", contextFiles: [] })] });

    warnOnDroppedContextFiles(prd, spec, "feat");

    const warning = entries.find((e) => e.level === "warn" && e.stage === "plan" && e.data?.storyId === "US-001");
    expect(warning?.data).toMatchObject({ declaredCount: 1, droppedCount: 1, dropped: ["src/b.ts"] });
  });

  test("emits a separate warning per story when more than one drops an entry", () => {
    const prd = makePRD({
      userStories: [
        makeStory({ id: "US-001", contextFiles: [] }), // src/a.ts, src/b.ts dropped
        makeStory({ id: "US-002", contextFiles: [] }), // src/c.ts dropped
      ],
    });

    warnOnDroppedContextFiles(prd, CONTEXT_FILES_SPEC, "feat");

    const warnings = entries.filter((e) => e.level === "warn" && e.stage === "plan" && e.message.includes("absent"));
    expect(warnings.map((w) => String(w.data?.storyId)).sort(byCodePoint)).toEqual(["US-001", "US-002"]);
  });

  test("ignores an absolute or traversing path instead of counting it as a drop", () => {
    const spec = [
      "### Context Files",
      "",
      "**US-001**",
      "- `/etc/passwd` — absolute",
      "- `../outside.ts` — traversing",
    ].join("\n");
    const prd = makePRD({ userStories: [makeStory({ id: "US-001", contextFiles: [] })] });

    warnOnDroppedContextFiles(prd, spec, "feat");

    const dropWarnings = entries.filter(
      (e) => e.level === "warn" && e.stage === "plan" && e.message.includes("absent"),
    );
    expect(dropWarnings).toHaveLength(0);
    const rejectedWarning = entries.find(
      (e) => e.level === "warn" && e.stage === "plan" && e.message.includes("absolute or traversing"),
    );
    expect(rejectedWarning?.data).toMatchObject({ rejectedCount: 2 });
  });

  test("a repo-rooted spec Context Files declaration matches a canonicalized monorepo story (nax#2125 / #1473)", () => {
    const specContent = [
      "## Stories",
      "",
      "### US-001: add a route",
      "",
      "### Context Files",
      "",
      "**US-001**",
      "- `packages/api/src/routes/index.ts`",
    ].join("\n");
    const story = makeStory({
      id: "US-001",
      workdir: "packages/api",
      workdirSource: "stated",
      contextFiles: ["packages/api/src/routes/index.ts"], // already canonicalized, matching frame
    });
    const prd = makePRD({ userStories: [story] });

    warnOnDroppedContextFiles(prd, specContent, "test-feature");

    const dropWarnings = entries.filter(
      (e) => e.level === "warn" && e.stage === "plan" && e.message.includes("Context Files entries absent"),
    );
    expect(dropWarnings).toEqual([]);
  });

  test("a workdir-relative spec declaration on a canonicalized monorepo story is correctly reported as not matching (post-redesign, spec must be repo-relative)", () => {
    const specContent = [
      "## Stories",
      "",
      "### US-001: add a route",
      "",
      "### Context Files",
      "",
      "**US-001**",
      "- `src/routes/index.ts`",
    ].join("\n");
    const story = makeStory({
      id: "US-001",
      workdir: "packages/api",
      workdirSource: "stated",
      contextFiles: ["packages/api/src/routes/index.ts"],
    });
    const prd = makePRD({ userStories: [story] });

    // A spec still written the OLD (workdir-relative) way genuinely will not
    // match a repo-rooted PRD -- this is the expected, correct behavior under
    // the new convention (the fix is "author specs repo-relative", not "make
    // the comparison frame-aware"). This test pins that the warning path is
    // intact, not broken by Task 1/2/4, so a genuine spec/PRD mismatch is
    // still caught.
    warnOnDroppedContextFiles(prd, specContent, "test-feature");

    const dropWarnings = entries.filter(
      (e) => e.level === "warn" && e.stage === "plan" && e.message.includes("Context Files entries absent"),
    );
    expect(dropWarnings.some((w) => w.data?.storyId === "US-001")).toBe(true);
  });
});

describe("applyPlanFidelity", () => {
  test("applies the out-of-scope backfill and the Modifies carry in one pass", () => {
    const result = applyPlanFidelity(twoStoryPrd(), SPEC, "feat");

    expect(result.outOfScope).toEqual(["An interactive Ink TUI"]);
    expect(result.userStories[0].modifiedFiles).toHaveLength(1);
  });

  test("matches backfillOutOfScope for a spec that declares no Modifies", () => {
    const specWithoutModifies = SPEC.split("### Modifies")[0];
    const viaFidelity = applyPlanFidelity(twoStoryPrd(), specWithoutModifies, "feat");
    const viaOutOfScope = backfillOutOfScope(twoStoryPrd(), specWithoutModifies, "feat");

    expect(viaFidelity.outOfScope).toEqual(viaOutOfScope.outOfScope);
    expect(viaFidelity.userStories.every((s) => s.modifiedFiles === undefined)).toBe(true);
  });
});

describe("warnOnAcCrossReferences — US-002", () => {
  let entries: LogEntry[];

  beforeEach(() => {
    resetLogger();
    initLogger({ level: "debug" });
    entries = [];
    addSink((entry) => entries.push(entry));
  });

  afterEach(() => {
    resetLogger();
  });

  const AC_CROSS_REF_MESSAGE =
    "PRD acceptance criterion refers to another criterion by number — AC numbering is not stable across plan runs";

  function acCrossRefWarns(): LogEntry[] {
    return entries.filter((e) => e.level === "warn" && e.stage === "plan" && e.message === AC_CROSS_REF_MESSAGE);
  }

  test("AC-14: emits exactly one plan-stage warn when one AC references AC-1 by number", () => {
    const prd = makePRD({
      userStories: [
        makeStory({
          id: "US-001",
          acceptanceCriteria: ["foo() returns 1", "Given the AC-1 setup, foo() returns 2"],
        }),
      ],
    });

    warnOnAcCrossReferences(prd, "feat");

    const warnings = acCrossRefWarns();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toBe(AC_CROSS_REF_MESSAGE);
  });

  test("AC-15: warn data has storyId first, then featureName/acIndex/references", () => {
    const prd = makePRD({
      userStories: [
        makeStory({
          id: "US-001",
          acceptanceCriteria: ["foo() returns 1", "Given the AC-1 setup, foo() returns 2"],
        }),
      ],
    });

    warnOnAcCrossReferences(prd, "feat");

    const warning = acCrossRefWarns()[0];
    const dataKeys = Object.keys(warning.data ?? {});
    expect(dataKeys[0]).toBe("storyId");
    expect(warning.data).toMatchObject({
      storyId: "US-001",
      featureName: "feat",
      acIndex: 2,
      references: ["AC-1"],
    });
  });

  test("AC-16: emits one warn per story whose AC carries a numeric reference", () => {
    const prd = makePRD({
      userStories: [
        makeStory({
          id: "US-001",
          acceptanceCriteria: ["no refs", "In the AC-1 shape, bar() throws"],
        }),
        makeStory({
          id: "US-002",
          acceptanceCriteria: ["Given the AC 3 setup, baz() returns 0"],
        }),
      ],
    });

    warnOnAcCrossReferences(prd, "feat");

    const warnings = acCrossRefWarns();
    expect(warnings).toHaveLength(2);
    expect(warnings.map((w) => String(w.data?.storyId)).sort(byCodePoint)).toEqual(["US-001", "US-002"]);
  });

  test("AC-17: emits no warn when no AC carries a numeric reference", () => {
    const prd = makePRD({
      userStories: [
        makeStory({
          id: "US-001",
          acceptanceCriteria: ["foo() returns 1", "the refined criterion is returned unchanged"],
        }),
      ],
    });

    warnOnAcCrossReferences(prd, "feat");

    expect(acCrossRefWarns()).toHaveLength(0);
  });
});

describe("applyPlanFidelity — AC cross-references (US-002)", () => {
  let entries: LogEntry[];

  beforeEach(() => {
    resetLogger();
    initLogger({ level: "debug" });
    entries = [];
    addSink((entry) => entries.push(entry));
  });

  afterEach(() => {
    resetLogger();
  });

  const AC_CROSS_REF_MESSAGE =
    "PRD acceptance criterion refers to another criterion by number — AC numbering is not stable across plan runs";

  test("AC-18: applyPlanFidelity emits the AC cross-reference warn after warnOnDroppedContextFiles", () => {
    const prd = makePRD({
      userStories: [makeStory({ id: "US-001", acceptanceCriteria: ["Given the AC-1 setup, foo() returns 2"] })],
    });

    applyPlanFidelity(prd, "# Feature\n\n## Design\n\nno spec sections", "feat");

    const warnings = entries.filter(
      (e) => e.level === "warn" && e.stage === "plan" && e.message === AC_CROSS_REF_MESSAGE,
    );
    expect(warnings).toHaveLength(1);
  });

  test("AC-19: applyPlanFidelity returns the input's acceptanceCriteria element-for-element (no PRD mutation by the cross-reference warning)", () => {
    const inputAcs = ["Given the AC-1 setup, foo() returns 2"];
    const prd = makePRD({
      userStories: [makeStory({ id: "US-001", acceptanceCriteria: inputAcs })],
    });

    const result = applyPlanFidelity(prd, "# Feature\n\n## Design\n\nno spec sections", "feat");

    expect(result.userStories[0].acceptanceCriteria).toEqual(inputAcs);
  });
});
