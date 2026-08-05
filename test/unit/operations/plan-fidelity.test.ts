import { describe, expect, test } from "bun:test";
import { applyPlanFidelity, backfillModifiedFiles, backfillOutOfScope } from "@/operations";
import { makePRD, makeStory } from "@test/helpers";

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
