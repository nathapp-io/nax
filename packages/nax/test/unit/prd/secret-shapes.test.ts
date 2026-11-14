import { describe, expect, test } from "bun:test";
import { makePRD, makeStory } from "@test/helpers";
import { findPrdSecretShapes as fromBarrel } from "@/prd";
import { findPrdSecretShapes, PROVIDER_SECRET_KINDS } from "@/prd/secret-shapes";

const github = "ghp_aaaaaaaaaaaaaaaaaaaa";
const openai = "sk-aaaaaaaaaaaaaaaaaaaa";
const pem = "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";
/** Code-unit ascending, so the expectation does not depend on the runtime's collation. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

describe("findPrdSecretShapes", () => {
  test.each([
    ["title", makeStory({ title: github }), "title", "github"],
    ["description", makeStory({ description: github }), "description", "github"],
    [
      "criterion",
      makeStory({ id: "US-002", acceptanceCriteria: ["one", "two", "three", openai] }),
      "acceptanceCriteria[3]",
      "openai",
    ],
  ])("AC-4/5: finds %s", (_label, story, field, kind) => {
    expect(findPrdSecretShapes(makePRD({ userStories: [story] }))).toEqual([{ storyId: story.id, field, kind }]);
  });

  test("ignores clean strings and task-shaped text", () => {
    expect(
      findPrdSecretShapes(makePRD({ userStories: [makeStory({ description: "task-abcdefghijklmnopqrst" })] })),
    ).toEqual([]);
  });

  test.each([
    ["AC-1: api_key assignment", "api_key: abcdefghijklmnop"],
    ["AC-2: key=value assignment", "TOKEN=abcdefghijklmnop"],
    ["AC-3: bearer authorization", "Authorization: Bearer abc123def456ghi789"],
  ])("%s is not a provider-format secret", (_label, description) => {
    expect(findPrdSecretShapes(makePRD({ userStories: [makeStory({ description })] }))).toEqual([]);
  });

  test("AC-6: reports an AWS access key id", () => {
    const prd = makePRD({ userStories: [makeStory({ description: "AKIAABCDEFGHIJKLMNOP" })] });
    expect(findPrdSecretShapes(prd)).toEqual([{ storyId: "US-001", field: "description", kind: "aws" }]);
  });

  test("AC-7: reports a PEM private key block", () => {
    const prd = makePRD({ userStories: [makeStory({ description: pem })] });
    expect(findPrdSecretShapes(prd)).toEqual([{ storyId: "US-001", field: "description", kind: "pem" }]);
  });

  test("AC-8: a field yields one finding, carrying the first matching pattern's kind", () => {
    const prd = makePRD({ userStories: [makeStory({ description: `${github} ${openai}` })] });
    expect(findPrdSecretShapes(prd)).toEqual([{ storyId: "US-001", field: "description", kind: "openai" }]);
  });

  test("AC-9: honors scope", () => {
    const prd = makePRD({
      userStories: [makeStory({ id: "US-001", description: github }), makeStory({ id: "US-002", description: github })],
    });
    expect(findPrdSecretShapes(prd, new Set(["US-002"]))).toEqual([
      { storyId: "US-002", field: "description", kind: "github" },
    ]);
  });

  test("AC-10: repeated calls return the same finding", () => {
    const prd = makePRD({ userStories: [makeStory({ description: github })] });
    expect(findPrdSecretShapes(prd)).toHaveLength(1);
    expect(findPrdSecretShapes(prd)).toHaveLength(1);
  });

  test("AC-11: PROVIDER_SECRET_KINDS is exactly the provider-format allowlist", () => {
    expect([...PROVIDER_SECRET_KINDS].sort(byCodeUnit)).toEqual([
      "aws",
      "github",
      "github-pat",
      "gitlab",
      "google",
      "jwt",
      "npm",
      "openai",
      "pem",
      "slack",
      "stripe",
      "telegram",
    ]);
  });

  test("orders one finding per string and honors scope and barrel export", () => {
    const prd = makePRD({
      userStories: [
        makeStory({ title: `${github} ${github}`, description: github, acceptanceCriteria: [openai, "ok", github] }),
        makeStory({ id: "US-002", description: github }),
      ],
    });
    const expected = [
      { storyId: "US-001", field: "title", kind: "github" },
      { storyId: "US-001", field: "description", kind: "github" },
      { storyId: "US-001", field: "acceptanceCriteria[0]", kind: "openai" },
      { storyId: "US-001", field: "acceptanceCriteria[2]", kind: "github" },
      { storyId: "US-002", field: "description", kind: "github" },
    ];
    expect(findPrdSecretShapes(prd)).toEqual(expected);
    expect(fromBarrel(prd)).toEqual(expected);
    expect(findPrdSecretShapes(prd, new Set(["US-002"]))).toEqual(expected.slice(-1));
  });
});
