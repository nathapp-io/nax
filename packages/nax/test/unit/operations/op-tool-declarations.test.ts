/**
 * Every op declaring Edit must also declare Exec (Task 9, spec section 4;
 * narrowed from "Write or Edit" in fix round 1 -- see the report). `Edit`
 * is the discriminator, not `Write`: an op only edits EXISTING source when
 * it declares `Edit`, and only that op can hit a missing dependency while
 * changing code. The fileOutput-shaped ops (plan, plan-refine,
 * acceptance-generate) declare `Write` because each writes ONE fresh
 * artifact (a PRD, an acceptance file) -- never source -- and have no
 * business installing packages, so they must NOT carry Exec. The verifier
 * is the deliberate exception on the other side: it judges the
 * implementer's work and must not itself be able to install packages, even
 * though it can run commands.
 *
 * US-001 later gave plan-refine and acceptance-generate `Edit` as well: those
 * ops now revise the single artifact they just wrote, which is still not
 * EXISTING source. Edit on such an op therefore does NOT imply Exec, and those
 * two are exempted by name below. Every op that edits existing source keeps
 * the Edit-implies-Exec rule.
 *
 * Iterates the barrel with resolveDeclaredTools rather than reading
 * `op.tools` directly, so this exercises the same path dispatch does --
 * an op that omits the field resolves to DEFAULT_CODING_TOOLS, and
 * reading the literal would hide that.
 */

import { describe, expect, test } from "bun:test";
import type { CodingToolName } from "@nathapp/nax-agent";
import * as ops from "@/operations";
import { resolveDeclaredTools } from "@/operations/types";

/**
 * Ops this story gives `Edit` to without `Exec`: they edit only the single
 * fresh artifact they just wrote (a PRD, an acceptance file), never EXISTING
 * source, so Edit does not imply Exec for them. Named explicitly rather than by
 * a trait, so adding `Edit` to any other op cannot slip past the Edit-implies-
 * Exec rule above by matching a shape.
 */
const EDIT_OWN_ARTIFACT_OPS: ReadonlySet<string> = new Set([
  "plan-refine",
  "acceptance-generate",
  // US-004: repairs the acceptance file acceptance-generate wrote — again a
  // single fresh artifact, never existing source. Its `outputTail` is a
  // compiler fragment, so it needs no package manager.
  "acceptance-repair",
]);

interface DeclaresTools {
  tools?: readonly CodingToolName[];
  name?: string;
}

function declaresTools(value: unknown): value is DeclaresTools {
  return typeof value === "object" && value !== null && "tools" in value;
}

describe("Exec declarations", () => {
  test("every op that can edit existing source can also install", () => {
    for (const value of Object.values(ops)) {
      if (!declaresTools(value) || value.tools === undefined) continue;
      if (value.name !== undefined && EDIT_OWN_ARTIFACT_OPS.has(value.name)) continue;
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

  test("an op this story gives Edit (but no Exec) cannot install", () => {
    for (const value of Object.values(ops)) {
      if (!declaresTools(value) || value.tools === undefined) continue;
      if (value.name === undefined || !EDIT_OWN_ARTIFACT_OPS.has(value.name)) continue;
      const tools = resolveDeclaredTools(value);
      expect(tools).toContain("Edit");
      expect(tools).not.toContain("Exec");
    }
  });

  test("the verifier cannot install", () => {
    const tools = resolveDeclaredTools(ops.verifierOp);
    expect(tools).toContain("RunCommand");
    expect(tools).not.toContain("Exec");
  });
});
