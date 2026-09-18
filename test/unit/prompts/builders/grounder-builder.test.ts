/**
 * Render-and-read coverage for GrounderPromptBuilder (Task 16, single-frame PR 2).
 *
 * GrounderPromptBuilder.build takes a `_workdir` argument that is not read. The
 * audit's job is to prove the rendered prompt carries no path framing: the spec
 * and codebase context are embedded verbatim and the workdir never leaks in.
 * Rendering goes through the production path (composeSections + join).
 */

import { describe, expect, test } from "bun:test";
import { GrounderPromptBuilder } from "@/prompts";
import type { ComposeInput } from "@/prompts/compose";
import { composeSections, join } from "@/prompts/compose";

const SPEC = "## Feature\n\nThe CLI shall ground facts against the repo.";
const CONTEXT = "### src/index.ts\n\nexport function main(): void {}";

function render(input: ComposeInput): string {
  return join(composeSections(input));
}

describe("GrounderPromptBuilder.build — render-and-read", () => {
  test("embeds spec and codebase context verbatim and the facts-manifest schema", () => {
    const prompt = render(new GrounderPromptBuilder().build(SPEC, CONTEXT, "/repo/packages/app"));

    expect(prompt).toContain("You are a grounding agent.");
    expect(prompt).toContain(SPEC);
    expect(prompt).toContain(CONTEXT);
    expect(prompt).toContain("repoFacts");
    expect(prompt).toContain("specClaims");
    expect(prompt).toContain("gaps");
    expect(prompt).toContain("Every repoFact must cite concrete evidence using real repo paths and line references.");
    expect(prompt).toContain("Output ONLY the JSON object — no markdown, no explanation.");
  });

  test("does not interpolate the workdir argument into the rendered prompt", () => {
    const builder = new GrounderPromptBuilder();
    const packageStory = render(builder.build(SPEC, CONTEXT, "/repo/packages/app"));
    const rootStory = render(builder.build(SPEC, CONTEXT, "/repo"));

    // `_workdir` is unused by contract; a package-scoped caller and a
    // repo-rooted caller must read byte-for-byte the same prompt.
    expect(packageStory).toBe(rootStory);
    expect(packageStory).not.toContain("/repo/packages/app");
  });
});
