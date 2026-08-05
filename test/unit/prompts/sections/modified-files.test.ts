import { describe, expect, test } from "bun:test";
import { buildModifiedFilesLines } from "@/prompts/sections";
import { buildBatchStorySection, buildStoryReminderSection, buildStorySection } from "@/prompts/sections";
import { makeStory } from "@test/helpers";

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

describe("story sections carry modifiedFiles to every builder", () => {
  const story = makeStory({ id: "US-001", acceptanceCriteria: ["it works"], modifiedFiles: [ENTRY] });

  test.each([
    ["buildStorySection", () => buildStorySection(story)],
    ["buildStoryReminderSection", () => buildStoryReminderSection(story)],
    ["buildBatchStorySection", () => buildBatchStorySection([story])],
  ])("%s renders the authorisation block", (_label, build) => {
    const rendered = build();

    expect(rendered).toContain("**Existing files this story is authorised to modify:**");
    expect(rendered).toContain(ENTRY.path);
  });

  test("omits the block entirely for a story with no authorisations", () => {
    expect(buildStorySection(makeStory({ id: "US-002" }))).not.toContain("authorised to modify");
  });

  // Pre-existing shape, pinned here so it is a decision rather than a surprise:
  // the reminder section short-circuits to a one-line nudge when a story has no
  // acceptance criteria, which drops the out-of-scope block too. A story with no
  // ACs is degenerate — nothing to implement, so nothing to authorise.
  test("reminder section drops the block for a story with no acceptance criteria", () => {
    const noCriteria = makeStory({ id: "US-003", acceptanceCriteria: [], modifiedFiles: [ENTRY] });

    expect(buildStoryReminderSection(noCriteria)).not.toContain("authorised to modify");
    expect(buildStorySection(noCriteria)).toContain("authorised to modify");
  });
});
