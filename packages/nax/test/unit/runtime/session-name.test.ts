import { describe, expect, test } from "bun:test";
import { formatSessionName } from "@/runtime";

describe("formatSessionName", () => {
  test("includes featureName and storyId when they differ", () => {
    const name = formatSessionName({ workdir: "/repo", featureName: "my-feature", storyId: "US-001", role: "main" });
    expect(name).toContain("my-feature");
    expect(name).toContain("us-001");
  });

  test("deduplicates when storyId equals featureName — plan-op regression", () => {
    // plan op passes both storyId and featureName as options.feature (same value).
    // Previously produced: nax-<hash>-mock-structure-handoff-mock-structure-handoff-plan
    const name = formatSessionName({
      workdir: "/repo",
      featureName: "mock-structure-handoff",
      storyId: "mock-structure-handoff",
      role: "plan",
    });
    const segments = name.split("-");
    const occurrences = segments.filter((s: string) => s === "mock").length;
    expect(occurrences).toBe(1);
    expect(name).toMatch(/^nax-[a-f0-9]{8}-mock-structure-handoff-plan$/);
  });

  test("deduplicates case-insensitively (sanitized form comparison)", () => {
    const name = formatSessionName({
      workdir: "/repo",
      featureName: "My Feature",
      storyId: "my-feature",
      role: "plan",
    });
    expect(name).not.toMatch(/my-feature-my-feature/);
  });

  test("omits storyId segment when featureName is absent", () => {
    const name = formatSessionName({ workdir: "/repo", storyId: "US-001", role: "plan" });
    expect(name).toContain("us-001");
  });

  test("omits role segment when role is 'main'", () => {
    const name = formatSessionName({ workdir: "/repo", featureName: "feat", storyId: "US-001", role: "main" });
    expect(name).not.toMatch(/main/);
  });
});
