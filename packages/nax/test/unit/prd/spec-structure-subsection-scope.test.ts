/**
 * US-002 — the subsection scope of the structure grammar.
 *
 * `## Stories` carries subsections that are free text about a story's work:
 * `### Modifies` says which existing files a story is authorised to touch, and
 * `### Seams` describes where it attaches. Their reasons routinely NAME another
 * story ("the count test depends on US-003's registration"), and they may quote
 * a `Workdir` while discussing someone else's package — so a statement read out
 * of one is enforced against a declaration the author never made.
 *
 * `### Context Files` and `### Creates` are the opposite case: they list the
 * story's OWN files, so a `Workdir` there is the story's.
 */
import { describe, expect, test } from "bun:test";
import { extractSpecStructure, type SpecStructure } from "@/prd";

/** A spec whose `## Stories` is `body`. */
function specOf(body: string): string {
  return `# SPEC: fixture\n\n## Stories\n\n${body}\n\n## Acceptance Criteria\n\n1. \`[unit]\` the behaviour holds.\n`;
}

function workdirOf(structure: SpecStructure, id: string): string | undefined {
  return structure.stories.find((story) => story.id === id)?.workdir;
}

function dependsOnOf(structure: SpecStructure, id: string): readonly string[] | undefined {
  return structure.stories.find((story) => story.id === id)?.dependsOn;
}

/** US-001…US-003 declared, then `subsection` holding a statement about US-002. */
function specWith(statement: string, subsection: string): string {
  return specOf(`### US-001 — Core

### US-002 — API

### US-003 — Web

${subsection}

**US-002**

- ${statement}`);
}

const FREE_TEXT_SUBSECTIONS = ["### Modifies", "### Seams", "### Context Files", "### Creates"];

describe("extractSpecStructure — subsection scope (US-002)", () => {
  test.each(FREE_TEXT_SUBSECTIONS)("US-002: a dependency mention under %s is not US-002's", (subsection) => {
    const spec = specWith("`scripts/count.ts` — the count test depends on US-003's registration", subsection);

    expect(dependsOnOf(extractSpecStructure(spec), "US-002")).toBeUndefined();
  });

  test("US-002: a dependency statement in the story's own prose IS US-002's", () => {
    const spec = specOf(`### US-002 — API

- \`scripts/count.ts\` — see the notes

- Depends on: US-001`);

    expect(dependsOnOf(extractSpecStructure(spec), "US-002")).toEqual(["US-001"]);
  });

  test.each(["### Modifies", "### Seams"])("US-002: a Workdir under %s is not US-002's", (subsection) => {
    const spec = specWith("`apps/web/src/a.ts` — Workdir: apps/web is the other package's", subsection);

    expect(workdirOf(extractSpecStructure(spec), "US-002")).toBeUndefined();
  });

  test.each(["### Context Files", "### Creates"])("US-002: a Workdir under %s IS US-002's", (subsection) => {
    const spec = specWith("`apps/web/src/a.ts` — read it. Workdir `apps/web`", subsection);

    expect(workdirOf(extractSpecStructure(spec), "US-002")).toBe("apps/web");
  });
});
