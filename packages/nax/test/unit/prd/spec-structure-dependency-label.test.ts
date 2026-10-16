/**
 * US-005 — the `Dependencies:` label in the spec grammar.
 *
 * `Depends on US-001` was the only phrasing the grammar read, so a spec that
 * wrote the equally common `Dependencies: US-001.` label declared nothing: the
 * story's `dependsOn` stayed undefined, the binding table rendered
 * `(not stated)`, and `nax plan` wrote `"dependencies": []` (#2459).
 *
 * The label goes through the SAME reader as `depends on` (`readDependencyValue`
 * in `./spec-structure-grammar`), so every assertion here fixes which phrasings
 * reach it — the value syntax, the emphasis spec-kit authors write, and the
 * scopes (`### Modifies` and fenced blocks) the field already ignores.
 *
 * Split out of `spec-structure.test.ts` by concern — that file is at its size
 * target, not by ticket.
 */
import { describe, expect, test } from "bun:test";
import { extractSpecStructure, type SpecStructure } from "@/prd";

/** A spec whose `## Stories` is `storiesBody`, with the sections real specs carry. */
function specOf(storiesBody: string): string {
  return `# SPEC: fixture

## Stories

${storiesBody}

## Acceptance Criteria

1. \`[unit]\` the behaviour holds.
`;
}

function story(structure: SpecStructure, id: string) {
  return structure.stories.find((s) => s.id === id);
}

describe("Dependencies label (US-005)", () => {
  test("AC-1: reads `Dependencies: US-001.` stated after a story declaration", () => {
    const spec = specOf(`### US-001 — Core

### US-002 — API

Dependencies: US-001.`);

    const structure = extractSpecStructure(spec);

    expect(story(structure, "US-002")?.dependsOn).toEqual(["US-001"]);
    // Attribution is to the nearest PRECEDING declaring line: US-001 states
    // nothing, so the label must not be read onto it too.
    expect(story(structure, "US-001")?.dependsOn).toBeUndefined();
    expect(structure.warnings).toEqual([]);
  });

  test("AC-1 boundary: reads the label inline on the declaring line itself", () => {
    const spec = specOf(`1. **US-001: Core** — Workdir: packages/core — no dependencies
2. **US-002: API** — Workdir: apps/api — Dependencies: US-001.`);

    const structure = extractSpecStructure(spec);

    expect(story(structure, "US-002")?.dependsOn).toEqual(["US-001"]);
    expect(story(structure, "US-002")?.workdir).toBe("apps/api");
  });

  test("AC-2: `Dependencies: none.` states no dependencies, which is [] and not undefined", () => {
    const spec = specOf(`### US-001 — Core

Dependencies: none.

### US-002 — API`);

    const structure = extractSpecStructure(spec);

    // [] is the spec SAYING "none"; undefined is the spec saying nothing. Only
    // the label form's `none` can produce the first for this story.
    expect(story(structure, "US-001")?.dependsOn).toEqual([]);
  });

  test("AC-3: reads the emphasized `**Dependencies:**` label and its id list", () => {
    const spec = specOf(`### US-001 — Core

### US-002 — API

### US-003 — Web

**Dependencies:** US-001, US-002`);

    const structure = extractSpecStructure(spec);

    expect(story(structure, "US-003")?.dependsOn).toEqual(["US-001", "US-002"]);
  });

  test("AC-4: reads `**Dependencies**: none` — emphasis closed before the colon", () => {
    const spec = specOf(`### US-001 — Core

### US-002 — API

**Dependencies**: none`);

    expect(story(extractSpecStructure(spec), "US-002")?.dependsOn).toEqual([]);
  });

  test("AC-5: reads the label and its ids case-insensitively", () => {
    const spec = specOf(`### US-001 — Core

### US-002 — API

dependencies: us-001`);

    const structure = extractSpecStructure(spec);

    // The ids reach the PRD uppercase, so comparing against `US-001` is only
    // possible if both the label and the id are read case-blind.
    expect(story(structure, "US-002")?.dependsOn).toEqual(["US-001"]);
  });

  test("AC-6: a label whose value names no story id and no `none` is not a declaration", () => {
    const spec = specOf(`### US-001 — Core

### US-002 — API

Dependencies: zod`);

    const structure = extractSpecStructure(spec);

    expect(story(structure, "US-002")?.dependsOn).toBeUndefined();
    expect(structure.warnings).toEqual([]);
  });

  test("AC-6 failure handling: a value that is not a declaration does not cancel what else the story states", () => {
    const spec = specOf(`### US-001 — Core

### US-002 — API

Dependencies: zod

- Depends on: US-001`);

    const structure = extractSpecStructure(spec);

    // The unreadable label is ignored, not treated as "the author said
    // something, so the field is unenforceable".
    expect(story(structure, "US-002")?.dependsOn).toEqual(["US-001"]);
    expect(structure.warnings).toEqual([]);
  });

  test("AC-7: `Dependencies: none` beside `Depends on US-001` conflicts, warns, and leaves dependsOn undefined", () => {
    const spec = specOf(`### US-001 — Core

### US-002 — API

Dependencies: none

Depends on US-001`);

    const structure = extractSpecStructure(spec);

    expect(story(structure, "US-002")?.dependsOn).toBeUndefined();
    expect(structure.warnings).toHaveLength(1);
    expect(structure.warnings[0]?.storyId).toBe("US-002");
    expect(structure.warnings[0]?.field).toBe("dependsOn");
  });

  test("AC-8: ignores a `Dependencies:` label written inside a fenced example block", () => {
    const spec = specOf(`### US-001 — Core

### US-002 — API

Write the statement like this:

\`\`\`markdown
Dependencies: US-001.
\`\`\``);

    const structure = extractSpecStructure(spec);

    // The fenced copy is documentation. Reading it would state a dependency the
    // author never declared for this story.
    expect(story(structure, "US-002")?.dependsOn).toBeUndefined();
  });

  test("AC-8 boundary: the same label outside the fence IS read", () => {
    const spec = specOf(`### US-001 — Core

### US-002 — API

Write the statement like this:

\`\`\`markdown
Dependencies: US-002.
\`\`\`

Dependencies: US-001.`);

    expect(story(extractSpecStructure(spec), "US-002")?.dependsOn).toEqual(["US-001"]);
  });

  test("AC-9: ignores a `Dependencies:` label that only appears in a ### Modifies reason", () => {
    const spec = specOf(`### US-001 — Core

### US-002 — API

### Modifies

**US-002**

- \`scripts/count.ts\` — the count test reads US-001's registry; Dependencies: US-001.`);

    const structure = extractSpecStructure(spec);

    // A reason is free text about a change, not the story's package or its
    // dependencies: it routinely mentions another story by name.
    expect(story(structure, "US-002")?.dependsOn).toBeUndefined();
  });

  test("AC-9 boundary: the same label in the story's own prose IS a declaration", () => {
    const spec = specOf(`### US-001 — Core

### US-002 — API

Dependencies: US-001.`);

    expect(story(extractSpecStructure(spec), "US-002")?.dependsOn).toEqual(["US-001"]);
  });

  test("a `### Dependencies` heading is not a label, and its body states nothing", () => {
    const spec = specOf(`### US-001 — Core

### US-002 — API

### Dependencies

- US-001`);

    const structure = extractSpecStructure(spec);

    // Without a colon the word is a section title, not a statement — reading it
    // would enforce a list the grammar never parsed.
    expect(story(structure, "US-002")?.dependsOn).toBeUndefined();
    expect(structure.warnings).toEqual([]);
  });
});
