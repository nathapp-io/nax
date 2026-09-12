import { describe, expect, test } from "bun:test";
import type { ToolGrant } from "@/tools";
import { narrowGrants } from "@/tools";

const VERDICT = ".nax-verifier-verdict.json";

describe("narrowGrants", () => {
  test("replaces an unconditional grant with the op's patterns", () => {
    const grants: ToolGrant[] = [
      { tool: "Read", patterns: ["*"] },
      { tool: "Write", patterns: ["*"] },
    ];

    const narrowed = narrowGrants(grants, { Write: [VERDICT] });

    expect(narrowed).toEqual([
      { tool: "Read", patterns: ["*"] },
      { tool: "Write", patterns: [VERDICT] },
    ]);
  });

  test("keeps only op patterns the scoped grant already names verbatim", () => {
    const grants: ToolGrant[] = [{ tool: "Write", patterns: [VERDICT, "src/**"] }];

    const narrowed = narrowGrants(grants, { Write: [VERDICT] });

    expect(narrowed).toEqual([{ tool: "Write", patterns: [VERDICT] }]);
  });

  test("drops a tool whose scoped grant does not name the op's pattern", () => {
    const grants: ToolGrant[] = [{ tool: "Write", patterns: ["src/**"] }];

    const narrowed = narrowGrants(grants, { Write: [VERDICT] });

    expect(narrowed).toEqual([]);
  });

  test("never grants a tool the profile withheld", () => {
    const grants: ToolGrant[] = [{ tool: "Read", patterns: ["*"] }];

    const narrowed = narrowGrants(grants, { Write: [VERDICT] });

    expect(narrowed.some((grant) => grant.tool === "Write")).toBe(false);
  });

  test("returns the same array when there is no narrowing", () => {
    const grants: ToolGrant[] = [{ tool: "Write", patterns: ["*"] }];

    expect(narrowGrants(grants, undefined)).toBe(grants);
    expect(narrowGrants(grants, {})).toBe(grants);
  });
});
