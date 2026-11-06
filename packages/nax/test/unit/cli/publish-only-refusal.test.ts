import { describe, expect, test } from "bun:test";
import { makePRD, makeStory } from "@test/helpers";
import { type PublishOnlyRunFlags, publishOnlyRefusal } from "@/cli";

describe("publishOnlyRefusal (#2819)", () => {
  const base = { feature: "f", dryRun: false } satisfies PublishOnlyRunFlags;
  const allPassed = makePRD({ userStories: [makeStory({ id: "US-001", status: "passed", passes: true })] });

  test("a run without --publish-only is never refused", () => {
    expect(publishOnlyRefusal(base, makePRD())).toBeUndefined();
  });

  test("a finished feature may publish", () => {
    expect(publishOnlyRefusal({ ...base, publishOnly: true }, allPassed)).toBeUndefined();
  });

  test("pending stories are refused, naming the count and the next command", () => {
    const prd = makePRD({
      userStories: [
        makeStory({ id: "US-001", status: "passed", passes: true }),
        makeStory({ id: "US-002", status: "pending", passes: false }),
      ],
    });
    const message = publishOnlyRefusal({ ...base, publishOnly: true }, prd);
    expect(message).toContain("1 story still pending");
    expect(message).toContain("nax run -f f");
  });

  test.each([
    ["--plan", { plan: true }],
    ["--compare", { compare: "claude,codex" }],
    ["--dry-run", { dryRun: true }],
  ] as const)("cannot be combined with %s", (flag, over) => {
    expect(publishOnlyRefusal({ ...base, ...over, publishOnly: true }, allPassed)).toContain(flag);
  });
});
