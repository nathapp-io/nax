/**
 * nax#2115 regression: a declared `fileOutput` path must be WRITABLE under the
 * policy the op's own declared tools compile to.
 *
 * #2095 added a blanket refusal on the feature PRD while the three plan ops were
 * already declaring `Write` plus `fileOutput: (input) => input.outputPath` pointing
 * at exactly that path. Both halves were individually tested and both were
 * individually correct; nothing asserted them TOGETHER, so `nax plan` shipped unable
 * to write a PRD in any mode.
 *
 * This asserts the pair, which is the only form that catches the class.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolScope } from "@nathapp/nax-agent";
import { compileToolPolicy } from "@nathapp/nax-agent";
import { buildCodingToolSupport } from "@nathapp/nax-agent/internal";
import { makeNaxConfig } from "@test/helpers";
import { resolveCodingToolSupport } from "@/agents/coding-tool-support-resolve";
import { naxOwnedPathsPolicy } from "@/agents/nax-owned-writes";
import type { PlanInteractiveInput, PlanRefineInput } from "@/operations";
import { planInteractiveOp, planRefineOp } from "@/operations";

const PATH_SCOPE: ToolScope = { pathFields: ["path"] };
const root = mkdtempSync(join(tmpdir(), "nax-2115-"));
const OWNED_REL = ".nax/features/auth/prd.json";
const outputPath = join(root, OWNED_REL);

const planInput: PlanInteractiveInput = {
  specContent: "spec",
  codebaseContext: "context",
  featureName: "auth",
  branchName: "feat/auth",
  outputPath,
};

const refineInput: PlanRefineInput = { ...planInput };

/**
 * The ops that actually name the guarded feature PRD.
 */
const PRD_WRITING_OPS = [
  ["plan-interactive", planInteractiveOp.tools ?? [], planInteractiveOp.fileOutput?.(planInput)],
  ["plan-refine", planRefineOp.tools ?? [], planRefineOp.fileOutput?.(refineInput)],
] as const;

describe("plan ops can write their own declared fileOutput (nax#2115)", () => {
  for (const [name, tools, declaredOutput] of PRD_WRITING_OPS) {
    const grants = tools.filter((t) => t === "Write").map((tool) => ({ tool, patterns: ["**"] }));

    test(`${name} declares Write and names the PRD as its fileOutput`, () => {
      expect(tools).toContain("Write");
      expect(declaredOutput).toBe(outputPath);
    });

    test(`${name} may write that path under its own compiled policy, but not a PRD it does not own`, () => {
      const policy = compileToolPolicy(grants, root, {
        ownedPaths: naxOwnedPathsPolicy,
        ownedWriteExemption: outputPath,
      });
      expect(policy.check("Write", PATH_SCOPE, { path: OWNED_REL }).allowed).toBe(true);
      expect(policy.check("Write", PATH_SCOPE, { path: ".nax/features/other/prd.json" }).allowed).toBe(false);
    });
  }
});

/**
 * US-001 AC3: the Edit grant plan-refine now declares is scoped by the same
 * `ownedWriteExemption` guard -- the op may edit the single PRD its `fileOutput`
 * names, and a sibling feature's PRD stays refused.
 */
describe("plan-refine may edit its own declared fileOutput (US-001)", () => {
  const editGrants = (planRefineOp.tools ?? [])
    .filter((tool) => tool === "Edit")
    .map((tool) => ({ tool, patterns: ["**"] }));

  test("Edit on the owned path is allowed, a sibling feature's PRD is denied (US-001 AC3)", () => {
    expect(editGrants).toHaveLength(1);
    const policy = compileToolPolicy(editGrants, root, {
      ownedPaths: naxOwnedPathsPolicy,
      ownedWriteExemption: planRefineOp.fileOutput?.(refineInput),
    });
    expect(policy.check("Edit", PATH_SCOPE, { path: OWNED_REL }).allowed).toBe(true);
    expect(policy.check("Edit", PATH_SCOPE, { path: ".nax/features/other/prd.json" }).allowed).toBe(false);
  });
});

/**
 * The WIRING, not the leaf.
 *
 * #2115 was a plumbing bug: both the op declaration and the guard were individually
 * correct and individually tested. Every other test here hands `ownedWriteExemption`
 * to `compileToolPolicy` by hand, so deleting the forwarding line in
 * `src/operations/call.ts` or in `resolveCodingToolSupport` would leave them all green
 * while `nax plan` broke again. This crosses the seam instead.
 */
describe("fileOutputPath reaches the compiled policy (nax#2115)", () => {
  const declared = ["Write"] as const;
  const grants = [{ tool: "Write", patterns: ["**"] }];
  const build = (fileOutputPath?: string) =>
    buildCodingToolSupport({
      root,
      declared: [...declared],
      grants,
      ownedPaths: naxOwnedPathsPolicy,
      ...(fileOutputPath !== undefined ? { fileOutputPath } : {}),
    });

  test("with fileOutputPath, the Write actually lands on disk", async () => {
    const support = build(outputPath);
    expect(support).toBeDefined();
    const outcome = await support?.runtime.callTool("Write", { path: OWNED_REL, content: "{}" });
    expect(outcome?.kind).toBe("ok");
    expect(existsSync(outputPath)).toBe(true);
  });

  test("without fileOutputPath the identical call is denied", async () => {
    const support = build();
    const outcome = await support?.runtime.callTool("Write", {
      path: ".nax/features/unexempt/prd.json",
      content: "{}",
    });
    expect(outcome?.kind).toBe("denied");
    expect(outcome?.kind === "denied" && outcome.reason).toContain("nax's own run state");
  });

  test("the exemption does not travel to another feature's PRD", async () => {
    const support = build(outputPath);
    const outcome = await support?.runtime.callTool("Write", {
      path: ".nax/features/billing/prd.json",
      content: "{}",
    });
    expect(outcome?.kind).toBe("denied");
  });

  test("the path forwarded is exactly what the op declares for the same input", () => {
    expect(planInteractiveOp.fileOutput?.(planInput)).toBe(outputPath);
    expect(planRefineOp.fileOutput?.(refineInput)).toBe(outputPath);
  });
});

/**
 * The hop the fix's own first draft got wrong: `resolveCodingToolSupport` takes a
 * `Pick<AgentRunOptions, ...>` that enumerates its keys, and adding the field to
 * `AgentRunOptions` without adding it to that Pick left the forward silently absent
 * to `tsc` while every runtime test stayed green. Pinned at runtime here so the
 * plumbing is not carried by the typechecker alone.
 */
describe("codingToolFileOutput survives resolveCodingToolSupport (nax#2115)", () => {
  test("an exempt PRD write is allowed end to end", async () => {
    const support = await resolveCodingToolSupport({
      declaredTools: ["Write"],
      codingToolRoot: root,
      codingToolFileOutput: outputPath,
      pipelineStage: "plan",
      config: makeNaxConfig(),
    });
    const outcome = await support?.runtime.callTool("Write", { path: OWNED_REL, content: "{}" });
    expect(outcome?.kind).toBe("ok");
  });

  test("omitting codingToolFileOutput denies the same write", async () => {
    const support = await resolveCodingToolSupport({
      declaredTools: ["Write"],
      codingToolRoot: root,
      pipelineStage: "plan",
      config: makeNaxConfig(),
    });
    const outcome = await support?.runtime.callTool("Write", { path: OWNED_REL, content: "{}" });
    expect(outcome?.kind).toBe("denied");
  });
});
