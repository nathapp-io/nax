import { describe, expect, test } from "bun:test";
import { makeStory } from "@test/helpers";
import { buildModifiedFilesLines, buildStorySection } from "@/prompts/sections";

const ENTRY = {
  path: "test/unit/engine/orchestrator.test.ts",
  reason: "the identity no longer holds under the corrected accounting",
};

describe("buildModifiedFilesLines", () => {
  test.each([
    ["undefined", undefined],
    ["an empty list", []],
  ])("renders nothing for %s", (_label, entries) => {
    expect(buildModifiedFilesLines(entries)).toEqual([]);
  });

  test("renders the path and the spec's reason verbatim", () => {
    const rendered = buildModifiedFilesLines([ENTRY]).join("\n");

    expect(rendered).toContain("**Existing files this story is authorised to modify:**");
    expect(rendered).toContain(`\`${ENTRY.path}\` — ${ENTRY.reason}`);
  });

  test("tells the implementer to update the assertion rather than revert its change", () => {
    const rendered = buildModifiedFilesLines([ENTRY]).join("\n");

    expect(rendered).toContain("do NOT revert your change");
  });

  test("renders a bare path when the spec gave no reason", () => {
    const rendered = buildModifiedFilesLines([{ path: "src/bare.ts", reason: "" }]).join("\n");

    expect(rendered).toContain("- `src/bare.ts`");
    // No dangling separator when there is nothing after it.
    expect(rendered).not.toContain("src/bare.ts` —");
  });
});

describe("buildStorySection carries modifiedFiles", () => {
  const story = makeStory({ id: "US-001", acceptanceCriteria: ["it works"], modifiedFiles: [ENTRY] });

  test("renders the authorisation block", () => {
    const rendered = buildStorySection(story);

    expect(rendered).toContain("**Existing files this story is authorised to modify:**");
    expect(rendered).toContain(ENTRY.path);
  });

  test("omits the block entirely for a story with no authorisations", () => {
    expect(buildStorySection(makeStory({ id: "US-002" }))).not.toContain("authorised to modify");
  });

  test("renders the block even for a story with no acceptance criteria", () => {
    const noCriteria = makeStory({ id: "US-003", acceptanceCriteria: [], modifiedFiles: [ENTRY] });

    expect(buildStorySection(noCriteria)).toContain("authorised to modify");
  });
});
