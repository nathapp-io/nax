/**
 * Every op declaring Edit must also declare Exec (Task 9, spec section 4;
 * narrowed from "Write or Edit" in fix round 1 -- see the report). `Edit`
 * is the discriminator, not `Write`: an op only edits EXISTING source when
 * it declares `Edit`, and only that op can hit a missing dependency while
 * changing code. The fileOutput-shaped ops (plan, plan-refine, debate-plan,
 * acceptance-generate) declare `Write` because each writes ONE fresh
 * artifact (a PRD, an acceptance file) -- never source -- and have no
 * business installing packages, so they must NOT carry Exec. The verifier
 * is the deliberate exception on the other side: it judges the
 * implementer's work and must not itself be able to install packages, even
 * though it can run commands.
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
  test("every op that can edit existing source can also install", () => {
    for (const value of Object.values(ops)) {
      if (!declaresTools(value) || value.tools === undefined) continue;
      const tools = resolveDeclaredTools(value);
      if (tools.includes("Edit")) {
        expect(tools).toContain("Exec");
      }
    }
  });

  test("a fileOutput-shaped op (Write but not Edit) cannot install", () => {
    for (const value of Object.values(ops)) {
      if (!declaresTools(value) || value.tools === undefined) continue;
      const tools = resolveDeclaredTools(value);
      if (tools.includes("Write") && !tools.includes("Edit")) {
        expect(tools).not.toContain("Exec");
      }
    }
  });

  test("the verifier cannot install", () => {
    const tools = resolveDeclaredTools(ops.verifierOp);
    expect(tools).toContain("RunCommand");
    expect(tools).not.toContain("Exec");
  });
});
