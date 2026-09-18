/**
 * US-003 — Make scratchpad tools available to every operation.
 *
 * The story threads the scratchpad tools through `declaredWithProviders` in
 * `resolveCodingToolSupport` and adds them to `DEFAULT_CODING_TOOLS`, so a
 * callTool to any of them reaches the policy seam on every op. These tests
 * live in a sibling file from `coding-tool-support.test.ts` because adding
 * them inline pushed that file past the 800-line test hard limit; splitting
 * by concern follows the pattern documented in `.claude/rules/project-
 * conventions.md`.
 *
 * Each AC has at least one assertion. AC4 (the scoped-without-grant refusal
 * path) doubles as a regression guard for "no declaration gate" -- the
 * current implementation already returns a structured denial for an
 * ungranted tool, so the assertion is documenting an invariant the
 * implementer must not regress by introducing a declaration check.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeNaxConfig } from "@test/helpers";
import { resolveCodingToolSupport } from "@/agents/coding-tool-support";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nax-support-scratchpad-"));
  // Read on a missing path returns kind "error"; the AC5 reviewer-declared
  // test does NOT exercise Read, but having a writable fs surface means
  // resolved-paths are real paths and AC4's denied-outcome reflects the
  // policy verdict, not an unrelated tool-lookup miss.
  writeFileSync(join(root, "file.txt"), "x");
});

describe("US-003 AC1: an op declaring tools: ['Read'] advertises Read and the three scratchpad tools", () => {
  test("resolveCodingToolSupport includes the three scratchpad tools in the advertised set", async () => {
    // Going through resolveCodingToolSupport -- the path that does the
    // declaredWithProviders append -- so the test exercises the seam that
    // the story changes. The intersection invariant (grants caps what gets
    // advertised) is asserted alongside the scratchpad inclusion: under
    // unrestricted, every tool is granted, so the test only fails when the
    // declaredWithProviders append is missing.
    const support = await resolveCodingToolSupport({
      declaredTools: ["Read"],
      codingToolRoot: root,
      pipelineStage: "run",
      config: makeNaxConfig({ execution: { permissionProfile: "unrestricted" } }),
    });
    const advertised = support?.tools.map((t) => t.name) ?? [];
    expect(advertised).toContain("Read");
    expect(advertised).toContain("ScratchpadWrite");
    expect(advertised).toContain("ScratchpadRead");
    expect(advertised).toContain("ScratchpadList");
  });
});

describe("US-003 AC6: a read-only review declaration advertises scratchpad tools but no repository mutating tool", () => {
  test("the review declaration advertises ScratchpadWrite/Read/List and excludes Write/Edit/Delete", async () => {
    // AC6 (companion to AC1): a read-only review declaration advertises the
    // scratchpad tools but none of Write / Edit / Delete. The op's
    // declaration is the ceiling on REPOSITORY tools; the scratchpad tools
    // are the universal layer appended on every op.
    const support = await resolveCodingToolSupport({
      declaredTools: ["Read", "Glob", "Grep", "Git"],
      codingToolRoot: root,
      pipelineStage: "review",
      config: makeNaxConfig({ execution: { permissionProfile: "unrestricted" } }),
    });
    const advertised = support?.tools.map((t) => t.name) ?? [];
    expect(advertised).toContain("ScratchpadWrite");
    expect(advertised).toContain("ScratchpadRead");
    expect(advertised).toContain("ScratchpadList");
    // Read/Glob/Grep/Git were declared, so they reach the advertised set.
    expect(advertised).toContain("Read");
    expect(advertised).toContain("Glob");
    expect(advertised).toContain("Grep");
    expect(advertised).toContain("Git");
    // Repository mutating tools are not declared and must stay out of the set.
    expect(advertised).not.toContain("Write");
    expect(advertised).not.toContain("Edit");
    expect(advertised).not.toContain("Delete");
  });
});

describe("US-003 AC4: under scoped with no scratchpad rule, callTool returns a refused outcome naming the tool", () => {
  test("callTool('ScratchpadWrite') returns denied with a reason that contains 'ScratchpadWrite'", async () => {
    // The scoped profile lists only what the project wrote in
    // `execution.permissions.<stage>.allow`. With no scratchpad rule, no
    // grant for ScratchpadWrite reaches the compile, and callTool consults
    // the policy alone (not the op declaration) to refuse. The refusing
    // reason must name the tool so the model can react.
    //
    // Mirror the `cfg(execution: Record<string, unknown>)` helper from
    // test/unit/config/permissions.test.ts: `permissions.run.allow` is in
    // the zod schema but not in the narrow runtime-types alias, so the
    // execution block is widened at the boundary, the same idiom the
    // permissions suite uses for rule-list fields.
    const execution: Record<string, unknown> = {
      permissionProfile: "scoped",
      permissions: { run: { allow: ["Read"] } },
    };
    const support = await resolveCodingToolSupport({
      declaredTools: ["Read"],
      codingToolRoot: root,
      pipelineStage: "run",
      config: makeNaxConfig({ execution }),
    });
    expect(support).toBeDefined();
    // The AC pins "rather than raising or silently succeeding". A future
    // refactor that throws on an ungranted call surfaces here: the catch
    // turns the throw into a structured absence, `outcome` is undefined,
    // and the assertions below fail uniformly. A future regression that
    // silently succeeds surfaces as `outcome.kind !== "denied"`.
    let outcome: Awaited<ReturnType<NonNullable<typeof support>["runtime"]["callTool"]>> | undefined;
    try {
      outcome = await support?.runtime.callTool("ScratchpadWrite", {
        path: "notes.md",
        content: "x",
      });
    } catch {
      // intentional: surfaced below through outcome being undefined
    }
    expect(outcome).toBeDefined();
    expect(outcome?.kind).toBe("denied");
    if (outcome?.kind !== "denied") throw new Error("expected a denied outcome");
    expect(outcome.reason).toContain("ScratchpadWrite");
  });
});

describe("US-003 AC5: under unrestricted with a read-only review declaration, ScratchpadWrite returns a non-error outcome", () => {
  test("callTool('ScratchpadWrite', {path:'findings.md',...}) returns kind: 'ok'", async () => {
    // The review op declares ["Read", "Glob", "Grep", "Git"]. None of those
    // are repository-mutating, so without the declaredWithProviders append
    // the reviewer never receives ScratchpadWrite. AC5 pins that the append
    // makes ScratchpadWrite reachable AND that the policy approves a
    // `findings.md` write under the confined scope.
    const support = await resolveCodingToolSupport({
      declaredTools: ["Read", "Glob", "Grep", "Git"],
      codingToolRoot: root,
      pipelineStage: "review",
      config: makeNaxConfig({ execution: { permissionProfile: "unrestricted" } }),
    });
    expect(support).toBeDefined();
    const outcome = await support?.runtime.callTool("ScratchpadWrite", {
      path: "findings.md",
      content: "the review passed",
    });
    expect(outcome?.kind).toBe("ok");
  });
});
