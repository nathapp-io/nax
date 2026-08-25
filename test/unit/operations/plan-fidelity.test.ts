import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makePRD, makeStory } from "@test/helpers";
import type { LogEntry } from "@/logger";
import { addSink, initLogger, resetLogger } from "@/logger";
import { applyPlanFidelity, backfillModifiedFiles, backfillOutOfScope, warnOnDroppedContextFiles } from "@/operations";

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
    expect(warnings.map((w) => w.data?.storyId).sort()).toEqual(["US-001", "US-002"]);
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
