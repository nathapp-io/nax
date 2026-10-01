import { describe, expect, test } from "bun:test";
import { makeNaxConfig, makeStory, makeTestRuntime } from "@test/helpers";
import { autofixConfigSelector } from "@/config";
import type { AutofixConfig } from "@/config/selectors";
import type { Finding } from "@/findings/types";
import { fullSuiteRectifyOp } from "@/operations";
import type { BuildContext } from "@/operations/types";
import { RectifierPromptBuilder, repoScopedRectification } from "@/prompts";

const finding: Finding = {
  source: "test-runner",
  severity: "error",
  category: "failed-test",
  rule: "should work",
  file: "test/unit/foo.test.ts",
  message: "AssertionError: expected true to be false",
};

const story = makeStory({
  routing: { testStrategy: "three-session-tdd", complexity: "medium", reasoning: "tdd" },
});

// The op's build/parse/keepOpen never read the context — it only needs to
// satisfy BuildContext<AutofixConfig>, which the real runtime's package view does.
function makeCtx(): BuildContext<AutofixConfig> {
  const view = makeTestRuntime().packages.repo();
  return { packageView: view, config: view.select(autofixConfigSelector) };
}

const ctx = makeCtx();

describe("fullSuiteRectifyOp — shape (AC-1)", () => {
  test("kind is 'run'", () => {
    expect(fullSuiteRectifyOp.kind).toBe("run");
  });

  test("name is 'full-suite-rectify'", () => {
    expect(fullSuiteRectifyOp.name).toBe("full-suite-rectify");
  });

  test("stage is 'rectification'", () => {
    expect(fullSuiteRectifyOp.stage).toBe("rectification");
  });

  test("session role is 'implementer' and lifetime is 'warm'", () => {
    expect(fullSuiteRectifyOp.session.role).toBe("implementer");
    expect(fullSuiteRectifyOp.session.lifetime).toBe("warm");
  });
});

describe("fullSuiteRectifyOp.build (AC-2)", () => {
  test("task content equals RectifierPromptBuilder.failingTestRectification", () => {
    const result = fullSuiteRectifyOp.build({ story, findings: [finding] }, ctx);
    const expected = RectifierPromptBuilder.failingTestRectification([finding], story);
    expect(result.task.content).toBe(expected);
  });

  test("task content contains TEST_EDIT_REASON", () => {
    const result = fullSuiteRectifyOp.build({ story, findings: [finding] }, ctx);
    expect(result.task.content).toContain("TEST_EDIT_REASON");
  });
});

describe("fullSuiteRectifyOp.parse (AC-3)", () => {
  const input = { story, findings: [finding] };

  test("mock_structure block yields applied=true with parsed declaration", () => {
    const output = `Fixed the mock.

TEST_EDIT_REASON: mock_structure
FILES: test/unit/foo.test.ts, test/unit/bar.test.ts
REASON: The mock structure was incompatible with the updated API surface.`;

    const result = fullSuiteRectifyOp.parse(output, input, ctx);
    expect(result.applied).toBe(true);
    expect(result.testEditDeclarations).toHaveLength(1);
    expect(result.testEditDeclarations[0].reason).toBe("mock_structure");
    expect(result.testEditDeclarations[0].files).toContain("test/unit/foo.test.ts");
  });
});

describe("fullSuiteRectifyOp.parse (AC-4)", () => {
  const input = { story, findings: [finding] };

  test("no TEST_EDIT_REASON block yields applied=true and empty declarations", () => {
    const result = fullSuiteRectifyOp.parse("Fixed the implementation.", input, ctx);
    expect(result.applied).toBe(true);
    expect(result.testEditDeclarations).toEqual([]);
  });
});

describe("fullSuiteRectifyOp.parse — UNRESOLVED sentinel (AC-5)", () => {
  const input = { story, findings: [finding] };

  test("UNRESOLVED: line sets unresolvedReason", () => {
    const output =
      "Tried several approaches.\n\nUNRESOLVED: The test passes relative URLs that the library rejects — cannot satisfy without modifying the test.";
    const result = fullSuiteRectifyOp.parse(output, input, ctx);
    expect(result.unresolvedReason).toBe(
      "The test passes relative URLs that the library rejects — cannot satisfy without modifying the test.",
    );
  });

  test("output without UNRESOLVED: leaves unresolvedReason undefined", () => {
    const result = fullSuiteRectifyOp.parse("Fixed everything.", input, ctx);
    expect(result.unresolvedReason).toBeUndefined();
  });

  test("UNRESOLVED: coexists with test-edit declarations", () => {
    const output = `TEST_EDIT_REASON: lint_only
FILE: test/unit/foo.test.ts
FINDING: no-unused-vars
CHANGE: const x = 1; → // removed

UNRESOLVED: AC6 cannot be satisfied without changing the assertion.`;
    const result = fullSuiteRectifyOp.parse(output, input, ctx);
    expect(result.testEditDeclarations).toHaveLength(1);
    expect(result.unresolvedReason).toBe("AC6 cannot be satisfied without changing the assertion.");
  });
});

// ─── Repo-scoped dispatch (#1654) ────────────────────────────────────────────
//
// The same op serves both the story-scoped rectifier and the repo-scoped
// regression fixer; only the mandate differs. Sharing the op keeps one
// UNRESOLVED protocol and one declaration parser across both dispatches.

describe("fullSuiteRectifyOp.build — scope: 'repo'", () => {
  test("uses the repo-scoped mandate, not the story-scoped one", () => {
    const result = fullSuiteRectifyOp.build({ story, findings: [finding], scope: "repo" }, ctx);
    expect(result.task.content).toBe(repoScopedRectification([finding], story));
    expect(result.task.content).not.toBe(RectifierPromptBuilder.failingTestRectification([finding], story));
  });

  test("omitting scope keeps the story-scoped prompt byte-identical", () => {
    const withoutScope = fullSuiteRectifyOp.build({ story, findings: [finding] }, ctx);
    const withStoryScope = fullSuiteRectifyOp.build({ story, findings: [finding], scope: "story" }, ctx);
    const expected = RectifierPromptBuilder.failingTestRectification([finding], story);
    expect(withoutScope.task.content).toBe(expected);
    expect(withStoryScope.task.content).toBe(expected);
  });

  test("still carries the test-edit declaration protocol", () => {
    // Lifting the scope constraint must not lift the test-integrity rules — an
    // agent free to touch any file is exactly the one that must not be free to
    // delete the failing assertion.
    const result = fullSuiteRectifyOp.build({ story, findings: [finding], scope: "repo" }, ctx);
    expect(result.task.content).toContain("TEST_EDIT_REASON");
  });
});

// ─── US-004 — affordance-rendered test-command section in production wiring
//
// The story-scoped dispatch reads the resolved package's test command out of
// the package view's config and, when set, appends a `# TEST COMMAND` block
// (wrapped in a `run-check` protocol region) to the pre-change
// `RectifierPromptBuilder.failingTestRectification` prompt. The dispatch seam
// then substitutes a `RunCommand {"command": "test"}` call under native +
// advertised `RunCommand` (AC5); ACP keeps the shell string the verifier
// replays (AC6). Without a configured test command the op emits that
// pre-change prompt unchanged, so the ACP text stays byte-for-byte what
// shipped before US-004 (the story's Out of Scope #2).

describe("fullSuiteRectifyOp.build — US-004 affordance wiring (AC5/AC6)", () => {
  test("story-scoped dispatch with a configured `quality.commands.test` appends the affordance block", () => {
    const config = makeNaxConfig({
      quality: { commands: { test: "bun test test/unit/" } },
    });
    const view = makeTestRuntime({ config, workdir: "/tmp/test" }).packages.repo();
    const localCtx: BuildContext<AutofixConfig> = {
      packageView: view,
      config: view.select(autofixConfigSelector),
    };

    const result = fullSuiteRectifyOp.build({ story, findings: [finding] }, localCtx);

    // The # TEST COMMAND block is the affordance-gated section: it carries the
    // run-check region so native dispatch can substitute the RunCommand call.
    expect(result.task.content).toContain("# TEST COMMAND");
    expect(result.task.content).toContain("`bun test test/unit/`");
    expect(result.task.content).toContain("<!--nax:run-check:");
  });

  test("the same dispatch with a declared scoped key emits the `test` key name in the run-check region AND run-test regions per file", () => {
    const config = makeNaxConfig({
      quality: {
        commands: {
          test: "bun test test/unit/",
          // The presence of a scoped key is what flips the run-check spec
          // from "key was auto-detected" to "key was declared" — but the
          // full-suite block is `test`, not `testScoped`. The per-failing-file
          // block uses the `testScoped` key, since the scoped template
          // expands per file.
          testScoped: "CI=1 AGENT=1 bun test --timeout=60000 {{files}}",
        },
      },
    });
    const view = makeTestRuntime({ config, workdir: "/tmp/test" }).packages.repo();
    const localCtx: BuildContext<AutofixConfig> = {
      packageView: view,
      config: view.select(autofixConfigSelector),
    };

    const result = fullSuiteRectifyOp.build({ story, findings: [finding] }, localCtx);

    // AC5 — full-suite block: the run-check region names the declared `test` key.
    expect(result.task.content).toContain("<!--nax:run-check:");
    expect(result.task.content).toContain('"command":"test"');
    // AC4 — per-failing-file block: a `run-test` region per failing file,
    // naming the declared `testScoped` key.
    expect(result.task.content).toContain("<!--nax:run-test:");
    expect(result.task.content).toContain('"command":"testScoped"');
    expect(result.task.content).toContain('"files":"test/unit/foo.test.ts"');
  });

  // Regression for the post-reviewer fix: the per-failing-file block must NOT
  // be wrapped in a `run-test` region when the project has `commands.test`
  // but no `commands.testScoped`. The `test` template declares no
  // `{{files}}` placeholder, so a region naming command `"test"` with a
  // `values.files` value renders a tool call the `RunCommand` runtime
  // always rejects — a guaranteed dispatch failure on the common case.
  test("per-failing-file block stays as plain shell strings when no scoped template is declared", () => {
    const config = makeNaxConfig({
      quality: {
        commands: { test: "bun test test/unit/" },
      },
    });
    const view = makeTestRuntime({ config, workdir: "/tmp/test" }).packages.repo();
    const localCtx: BuildContext<AutofixConfig> = {
      packageView: view,
      config: view.select(autofixConfigSelector),
    };

    const result = fullSuiteRectifyOp.build({ story, findings: [finding] }, localCtx);

    // The full-suite block still carries the run-check region (AC5).
    expect(result.task.content).toContain("<!--nax:run-check:");
    expect(result.task.content).toContain('"command":"test"');
    // The per-failing-file block is plain shell strings — no `run-test`
    // region. The failing-file path is appended as `bun test <file>` with
    // no marker wrapping it.
    expect(result.task.content).not.toContain("<!--nax:run-test:");
    expect(result.task.content).toContain("## Per-failing-file run");
    expect(result.task.content).toContain("bun test test/unit/ test/unit/foo.test.ts");
  });

  // Regression for the post-reviewer fix: a `testScoped` template that does
  // NOT carry the `{{files}}` placeholder must NOT trigger a `run-test`
  // region. `RunCommand` resolves a declared key by exact placeholder
  // match; a template that takes `{{file}}` / `{{package}}` / no placeholder
  // hands the agent a tool call the runtime always rejects.
  test("per-failing-file block stays as plain shell strings when testScoped template does not use {{files}}", () => {
    const config = makeNaxConfig({
      quality: {
        commands: {
          test: "bun test test/unit/",
          // A `{{file}}` (singular) template — different placeholder
          // shape than the `{{files}}` (plural) that `RunCommand` matches.
          testScoped: "CI=1 bun test --timeout=60000 {{file}}",
        },
      },
    });
    const view = makeTestRuntime({ config, workdir: "/tmp/test" }).packages.repo();
    const localCtx: BuildContext<AutofixConfig> = {
      packageView: view,
      config: view.select(autofixConfigSelector),
    };

    const result = fullSuiteRectifyOp.build({ story, findings: [finding] }, localCtx);

    // The full-suite block still carries the run-check region (AC5).
    expect(result.task.content).toContain("<!--nax:run-check:");
    // No `run-test` region — a `{{file}}` template would not match the
    // `values.files` field the region would render.
    expect(result.task.content).not.toContain("<!--nax:run-test:");
    // The per-failing-file block is plain shell strings using the full-suite
    // command (a guaranteed-run, which is what the dispatch needs when
    // there is no runnable scoped command that accepts `{{files}}`).
    expect(result.task.content).toContain("## Per-failing-file run");
    expect(result.task.content).toContain("bun test test/unit/ test/unit/foo.test.ts");
  });
});

describe("fullSuiteRectifyOp.keepOpen — scope: 'repo'", () => {
  test("repo scope does not keep the session open", () => {
    // The repo-scoped dispatch runs under its own session role and gets one
    // attempt; leaving it warm would strand a session nothing resumes.
    expect(fullSuiteRectifyOp.keepOpen?.({ story, findings: [finding], scope: "repo" }, ctx)).toBe(false);
  });

  test("story scope keeps the warm session the op declares", () => {
    expect(fullSuiteRectifyOp.keepOpen?.({ story, findings: [finding] }, ctx)).toBe(true);
  });
});
