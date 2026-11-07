/**
 * Regression guards for buildDispatchPrologue's prompt assembly.
 *
 * The prologue used to append a `# Acceptance execution` section for run-kind
 * fix-role operations, driven by `CallContext.acceptanceExecution`. Nothing in
 * src/ ever set that field, so the append was always empty and both the field
 * and the append were deleted (pipeline-surface-delete US-003). These tests pin
 * the surviving behaviour: the prompt is exactly the op's composed sections
 * joined, and a throwing `build` still escapes as the same Error instance
 * rather than being swallowed into a partial prompt.
 */

import { describe, expect, test } from "bun:test";
import { makeMockCallContext } from "@test/helpers";
import { buildDispatchPrologue } from "@/operations/call-dispatch-prologue";
import type { CallContext, RunOperation } from "@/operations/types";
import type { PromptSection } from "@/prompts";
import { join } from "@/prompts";

const SECTION_CONTENT = "fix it";

const SECTION: PromptSection = { id: "task", content: SECTION_CONTENT, overridable: false };

type OpInput = Record<string, never>;
type OpOutput = string;

/** A run-kind implementer/rectification op whose build emits exactly one section. */
function makeRectificationOp(
  build: RunOperation<OpInput, OpOutput, unknown>["build"],
): RunOperation<OpInput, OpOutput, unknown> {
  return {
    name: "rectify",
    kind: "run",
    stage: "rectification",
    config: ["agent"],
    session: { role: "implementer", lifetime: "fresh" },
    build,
    parse: (output) => output,
  };
}

const oneSectionBuild: RunOperation<OpInput, OpOutput, unknown>["build"] = () => ({
  role: SECTION,
  task: { id: "empty-task", content: "", overridable: false },
});

function makeCtx(): CallContext {
  return makeMockCallContext();
}

describe("buildDispatchPrologue — prompt assembly", () => {
  test("AC-1: the prompt is the op's sections joined, with no acceptance-execution heading", () => {
    const out = buildDispatchPrologue(makeCtx(), makeRectificationOp(oneSectionBuild), {});

    expect(out.prompt).toBe(join([SECTION]));
    expect(out.prompt).toBe(SECTION_CONTENT);
    expect(out.prompt).not.toContain("# Acceptance execution");
  });

  test("AC-2: a build error escapes as the same Error instance, never a partial prompt", () => {
    const ctx = makeCtx();
    const failure = new Error("build failed");
    const op = makeRectificationOp(() => {
      throw failure;
    });

    let thrown: unknown;
    try {
      buildDispatchPrologue(ctx, op, {});
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBe(failure);
  });
});
