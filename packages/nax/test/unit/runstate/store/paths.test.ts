import { describe, expect, test } from "bun:test";
import { classifyRunStatePath } from "@/runstate/store";

describe("classifyRunStatePath (#2497)", () => {
  test.each([
    ["/r/.nax/features/f/prd.json", "prd", "/r"],
    ["/r/.nax/features/f/status.json", "status", "/r"],
    ["/r/.nax/features/f/decisions.jsonl", "decisions", "/r"],
    ["/r/.nax/features/f/workflow/run-1/result.json", "workflow-result", "/r"],
    ["/r/.nax/features/f/workflow/run-1/ledger.md", "ledger", "/r"],
    ["/r/pkg/.nax/features/f/prd.json", "prd", "/r/pkg"],
  ])("%s is %s under %s", (path, kind, root) => {
    expect(classifyRunStatePath(path)).toMatchObject({ kind, root, feature: "f" });
  });

  test.each([
    "/r/.nax/features/f/context.md",
    "/r/.nax/features/f/workflow/run-1/brief.md",
    "/r/.nax/config.json",
    "/r/src/prd.json",
    "/r/.nax/features/f/stories/US-1/prd.json",
    "/r/.nax/features/f/constructor",
    "/r/.nax/features/f/workflow/run-1/__proto__",
  ])("%s is not run state", (path) => {
    expect(classifyRunStatePath(path)).toBeNull();
  });

  test("rel is root-relative", () => {
    expect(classifyRunStatePath("/r/.nax/features/f/workflow/run-1/ledger.md")?.rel).toBe(
      ".nax/features/f/workflow/run-1/ledger.md",
    );
  });
});
