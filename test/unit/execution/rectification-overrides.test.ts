// test/unit/execution/rectification-overrides.test.ts
import { describe, expect, test } from "bun:test";
import { phasesToRevalidate } from "../../../src/execution/story-orchestrator";

// phasesToRevalidate is the pure function the overrides path relies on: stripping
// review phases from the input set must remove them from the selected set even
// when the strategy mapping lists them.
describe("review-stripped revalidation", () => {
  test("excluding review phases removes them from autofix-implementer's selected set", () => {
    const mk = (kind: string) => ({ kind, slot: { op: { name: kind } } }) as never;
    const all = [
      mk("lint-check"),
      mk("typecheck-check"),
      mk("full-suite-gate"),
      mk("semantic-review"),
      mk("adversarial-review"),
    ];
    const stripped = all.filter((p) => !["semantic-review", "adversarial-review"].includes((p as { kind: string }).kind));
    const selected = phasesToRevalidate(["autofix-implementer"], stripped);
    expect(selected.map((p) => (p as { kind: string }).kind)).toEqual(["lint-check", "typecheck-check", "full-suite-gate"]);
  });
});
