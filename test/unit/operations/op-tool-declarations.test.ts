/**
 * Every op declaring Write or Edit must also declare Exec (Task 9,
 * spec section 4). The verifier is the deliberate exception: it judges
 * the implementer's work and must not itself be able to install
 * packages.
 *
 * Iterates the barrel with resolveDeclaredTools rather than reading
 * `op.tools` directly, so this exercises the same path dispatch does --
 * an op that omits the field resolves to DEFAULT_CODING_TOOLS, and
 * reading the literal would hide that.
 */

import { describe, expect, test } from "bun:test";
import * as ops from "@/operations";
import { resolveDeclaredTools } from "@/operations/types";
import type { CodingToolName } from "@/tools";

interface DeclaresTools {
  tools?: readonly CodingToolName[];
}

function declaresTools(value: unknown): value is DeclaresTools {
  return typeof value === "object" && value !== null && "tools" in value;
}

describe("Exec declarations", () => {
  test("every op that can write can also install", () => {
    for (const value of Object.values(ops)) {
      if (!declaresTools(value) || value.tools === undefined) continue;
      const tools = resolveDeclaredTools(value);
      if (tools.includes("Write") || tools.includes("Edit")) {
        expect(tools).toContain("Exec");
      }
    }
  });

  test("the verifier cannot install", () => {
    const tools = resolveDeclaredTools(ops.verifierOp);
    expect(tools).toContain("RunCommand");
    expect(tools).not.toContain("Exec");
  });
});
