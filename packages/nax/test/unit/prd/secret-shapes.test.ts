import { describe, expect, test } from "bun:test";
import { makePRD, makeStory } from "@test/helpers";
import { findPrdSecretShapes as fromBarrel } from "@/prd";
import { findPrdSecretShapes } from "@/prd/secret-shapes";

const github = "ghp_aaaaaaaaaaaaaaaaaaaa";
const openai = "sk-aaaaaaaaaaaaaaaaaaaa";

describe("findPrdSecretShapes", () => {
  test.each([
    ["title", makeStory({ title: github }), "title"],
    ["description", makeStory({ description: github }), "description"],
    [
      "criterion",
      makeStory({ id: "US-002", acceptanceCriteria: ["one", "two", "three", openai] }),
      "acceptanceCriteria[3]",
    ],
  ])("finds %s", (_label, story, field) => {
    expect(findPrdSecretShapes(makePRD({ userStories: [story] }))).toEqual([{ storyId: story.id, field }]);
  });

  test("ignores clean strings and task-shaped text", () => {
    expect(
      findPrdSecretShapes(makePRD({ userStories: [makeStory({ description: "task-abcdefghijklmnopqrst" })] })),
    ).toEqual([]);
  });

  test("orders one finding per string and honors scope and barrel export", () => {
    const prd = makePRD({
      userStories: [
        makeStory({ title: `${github} ${github}`, description: github, acceptanceCriteria: [openai, "ok", github] }),
        makeStory({ id: "US-002", description: github }),
      ],
    });
    const expected = [
      { storyId: "US-001", field: "title" },
      { storyId: "US-001", field: "description" },
      { storyId: "US-001", field: "acceptanceCriteria[0]" },
      { storyId: "US-001", field: "acceptanceCriteria[2]" },
      { storyId: "US-002", field: "description" },
    ];
    expect(findPrdSecretShapes(prd)).toEqual(expected);
    expect(fromBarrel(prd)).toEqual(expected);
    expect(findPrdSecretShapes(prd, new Set(["US-002"]))).toEqual(expected.slice(-1));
  });
});
