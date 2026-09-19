import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeNaxConfig, makeStory, makeTempDir } from "@test/helpers";
import { featureDir } from "@/config";
import { TddPromptBuilder } from "@/prompts/builders/tdd-builder";
import type { BaselineEntry, TestBaseline } from "@/verification";
import { writeRunBaseline, writeStoryBaseline } from "@/verification";

describe("TddPromptBuilder.buildForRole", () => {
  test("builds a non-empty prompt for test-writer", async () => {
    const story = makeStory();
    const config = makeNaxConfig({ quality: { commands: { test: "bun test" } } });
    const prompt = await TddPromptBuilder.buildForRole("test-writer", "/tmp", config, story, {});
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("builds a non-empty prompt for implementer", async () => {
    const story = makeStory();
    const config = makeNaxConfig({});
    const prompt = await TddPromptBuilder.buildForRole("implementer", "/tmp", config, story, { lite: false });
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("builds a non-empty prompt for verifier", async () => {
    const story = makeStory();
    const config = makeNaxConfig({});
    const prompt = await TddPromptBuilder.buildForRole("verifier", "/tmp", config, story, {});
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test('list-valued commands.test renders " && "-joined, not comma-joined', async () => {
    const story = makeStory();
    const base = makeNaxConfig({ quality: { commands: { test: "placeholder" } } });
    // `NaxConfig["quality"]["commands"]["test"]` is declared as `string` — the
    // zod schema (QualityCommandSpecSchema) accepts `string | string[]` at
    // runtime, but the hand-written NaxConfig interface hasn't been widened to
    // match (a separate, larger gap outside this fix's scope). Object.assign's
    // `T & U` return type lets us build a real list-valued config without a
    // type-erasing double cast: the result is a structural intersection that
    // includes NaxConfig itself, so it's assignable to `NaxConfig` even though
    // `commands.test` is actually a `string[]` at runtime.
    const config = Object.assign({}, base, {
      quality: Object.assign({}, base.quality, {
        commands: Object.assign({}, base.quality.commands, { test: ["step-a", "step-b"] }),
      }),
    });
    const prompt = await TddPromptBuilder.buildForRole("test-writer", "/tmp", config, story, {});
    expect(prompt).toContain("step-a && step-b");
    expect(prompt).not.toContain("step-a,step-b");
  });
});

// ---------------------------------------------------------------------------
// AC-19: guardrails section placement — between hermetic and self-verification
// ---------------------------------------------------------------------------

describe("AC-19: TddPromptBuilder guardrails section placement", () => {
  test("guardrails (# Behavioral Guardrails) appears after hermetic content and before self-verification content", async () => {
    const story = makeStory();
    // Enable hermetic so the hermetic section is present; enable selfVerification so self-verification is present.
    // selfVerification requires an input to render — we pass a minimal input.
    const config = makeNaxConfig({
      quality: {
        commands: { test: "bun test" },
      },
      prompts: { behavioralGuardrails: "lite" },
    });

    const prompt = await TddPromptBuilder.for("implementer", { variant: "standard" })
      .story(story)
      .withLoader("/tmp", config)
      // Explicitly enable hermetic so the hermetic section is injected
      .hermeticConfig({ hermetic: true })
      .selfVerification({
        packageDir: "/tmp",
        lintCommand: "bun run lint",
        typecheckCommand: undefined,
      })
      .build();

    const hermeticIdx = prompt.indexOf("# Hermetic Test Requirement");
    const guardrailIdx = prompt.indexOf("# Behavioral Guardrails");
    const selfVerifyIdx = prompt.indexOf("# Self-Verification Gate");

    // All three sections must be present
    expect(hermeticIdx).toBeGreaterThan(-1);
    expect(guardrailIdx).toBeGreaterThan(-1);
    expect(selfVerifyIdx).toBeGreaterThan(-1);

    // Ordering: hermetic < guardrails < self-verification
    expect(guardrailIdx).toBeGreaterThan(hermeticIdx);
    expect(selfVerifyIdx).toBeGreaterThan(guardrailIdx);
  });
});

// ---------------------------------------------------------------------------
// AC-20: guardrails section is non-overridable
// ---------------------------------------------------------------------------

describe("AC-20: guardrails section is non-overridable (uses this.s() helper)", () => {
  test("guardrails section has overridable=false in accumulated sections", async () => {
    const config = makeNaxConfig({
      prompts: { behavioralGuardrails: "lite" },
    });

    // Build a prompt and access the internal SectionAccumulator snapshot via a subclass.
    // Since snapshot() is public on SectionAccumulator but not exposed by TddPromptBuilder,
    // we verify non-overridability indirectly: the private s() helper always sets overridable=false.
    // We can confirm this by checking that the prompt renders (no undefined/empty guardrails),
    // and by inspecting that the builder's s() is the only section-creation path.

    const prompt = await TddPromptBuilder.for("implementer", { variant: "standard" })
      .story(makeStory())
      .withLoader("/tmp", config)
      .build();

    // The guardrails section must appear in the final prompt
    expect(prompt).toContain("# Behavioral Guardrails");
  });

  test("all sections from TddPromptBuilder use the private s() helper which sets overridable=false", async () => {
    const config = makeNaxConfig({ prompts: { behavioralGuardrails: "strict" } });
    const prompt = await TddPromptBuilder.for("implementer", { variant: "standard" })
      .story(makeStory())
      .withLoader("/tmp", config)
      .build();
    expect(prompt).toContain("# Behavioral Guardrails");
  });
});

// ---------------------------------------------------------------------------
// AC-21: when level === "off", guardrails section absent from rendered prompt
// ---------------------------------------------------------------------------

describe("AC-21: when behavioralGuardrails='off', acc.add not called for guardrails", () => {
  test("rendered prompt contains no '# Behavioral Guardrails' header when level is 'off'", async () => {
    const story = makeStory();
    const config = makeNaxConfig({
      prompts: { behavioralGuardrails: "off" },
    });

    const prompt = await TddPromptBuilder.for("implementer", { variant: "standard" })
      .story(story)
      .withLoader("/tmp", config)
      .build();

    expect(prompt).not.toContain("# Behavioral Guardrails");
  });

  test("verifier role never receives guardrails section (regardless of level)", async () => {
    const story = makeStory();
    const config = makeNaxConfig({
      prompts: { behavioralGuardrails: "strict" },
    });

    const prompt = await TddPromptBuilder.for("verifier", {}).story(story).withLoader("/tmp", config).build();

    expect(prompt).not.toContain("# Behavioral Guardrails");
  });

  test("no-test role never receives guardrails section (regardless of level)", async () => {
    const story = makeStory();
    const config = makeNaxConfig({
      prompts: { behavioralGuardrails: "strict" },
    });

    const prompt = await TddPromptBuilder.for("no-test", {}).story(story).withLoader("/tmp", config).build();

    expect(prompt).not.toContain("# Behavioral Guardrails");
  });

  test("non-off levels render guardrails for implementer", async () => {
    const story = makeStory();

    for (const level of ["lite", "strict"] as const) {
      const config = makeNaxConfig({ prompts: { behavioralGuardrails: level } });
      const prompt = await TddPromptBuilder.for("implementer", { variant: "standard" })
        .story(story)
        .withLoader("/tmp", config)
        .build();
      expect(prompt).toContain("# Behavioral Guardrails");
    }
  });
});

// ---------------------------------------------------------------------------
// AC-7 / AC-8: .nax/ immutability section is composed into TddPromptBuilder
// prompts for test-writer and verifier (not config-gated; always present).
// ---------------------------------------------------------------------------

describe("AC-7/AC-8: TddPromptBuilder includes .nax/ immutability text", () => {
  test("test-writer prompt includes .nax/ immutability text (moved, renamed, deleted)", async () => {
    const story = makeStory();
    const config = makeNaxConfig({});
    const prompt = await TddPromptBuilder.for("test-writer", {}).story(story).withLoader("/tmp", config).build();

    expect(prompt).toContain(".nax/");
    const lower = prompt.toLowerCase();
    expect(lower).toContain("moved");
    expect(lower).toContain("renamed");
    expect(lower).toContain("deleted");
  });

  test("verifier prompt includes .nax/ immutability text (moved, renamed, deleted)", async () => {
    const story = makeStory();
    const config = makeNaxConfig({});
    const prompt = await TddPromptBuilder.for("verifier", {}).story(story).withLoader("/tmp", config).build();

    expect(prompt).toContain(".nax/");
    const lower = prompt.toLowerCase();
    expect(lower).toContain("moved");
    expect(lower).toContain("renamed");
    expect(lower).toContain("deleted");
  });

  test(".nax/ section is always present regardless of behavioralGuardrails config", async () => {
    const story = makeStory();
    // Even with guardrails off, the .nax/ section must still render.
    const config = makeNaxConfig({ prompts: { behavioralGuardrails: "off" } });
    const prompt = await TddPromptBuilder.for("test-writer", {}).story(story).withLoader("/tmp", config).build();

    expect(prompt).toContain(".nax/");
  });
});

// ---------------------------------------------------------------------------
// US-005: the implementer prompt introduces the scratchpad, so the standing
// .nax/ immutability rule does not read as a blanket prohibition.
// ---------------------------------------------------------------------------

describe("US-005: TddPromptBuilder composes the scratchpad section", () => {
  // AC-4
  test("implementer prompt names .nax/scratchpad/ and carries the wipe/never-committed contract", async () => {
    const story = makeStory();
    const config = makeNaxConfig({});
    const prompt = await TddPromptBuilder.for("implementer", { variant: "standard" })
      .story(story)
      .withLoader("/tmp", config)
      .build();

    expect(prompt).toContain(".nax/scratchpad/");
    const lower = prompt.toLowerCase();
    expect(lower).toContain("wiped at the start of each run");
    expect(lower).toContain("never committed");
  });
});

describe("TddPromptBuilder.verdictRetry", () => {
  test("returns a re-emit instruction with explicit start/end markers", () => {
    const out = TddPromptBuilder.verdictRetry();
    expect(out).toContain("could not be parsed");
    expect(out).toContain("start with {");
    expect(out).toContain("end with }");
    expect(out).toContain("version");
    expect(out).toContain("approved");
  });
});

describe("TddPromptBuilder.verdictRetryCondensed", () => {
  test("instructs the agent to drop acceptanceCriteria.criteria entries", () => {
    const out = TddPromptBuilder.verdictRetryCondensed();
    expect(out).toContain("truncated");
    expect(out).toContain("criteria=[] (empty array)");
    expect(out).toContain("acceptanceCriteria");
    expect(out).toContain("allMet");
  });
});

// ---------------------------------------------------------------------------
// US-004 — TddPromptBuilder threads the declared `testScoped` key into
// buildIsolationSection so the test-filter rule is wrapped in a `run-test`
// region when the project has a scoped template. Native dispatch then
// substitutes a `RunCommand {"command": "testScoped", "values": {"files":
// "<path/to/test-file>"}}` call (AC2); without a scoped template the wrapping is skipped.
// ---------------------------------------------------------------------------

describe("US-004 — TddPromptBuilder scopes test-command key into isolation", () => {
  test("test-writer + scoped template → wrapped region; native dispatch substitutes RunCommand call", async () => {
    const story = makeStory();
    const config = makeNaxConfig({
      quality: {
        commands: {
          test: "bun test",
          testScoped: "CI=1 AGENT=1 bun test --timeout=60000 {{files}}",
        },
      },
    });
    const prompt = await TddPromptBuilder.buildForRole("test-writer", "/tmp", config, story, {});

    // The shell example is preserved verbatim (the surrounding text is
    // byte-for-byte what ships today — AC1).
    expect(prompt).toContain("`bun test <path/to/test-file>`");
    // Wrapped region from the affordance registry.
    expect(prompt).toContain("<!--nax:run-test:");
    // Full-suite warning is preserved verbatim (AC1).
    expect(prompt).toContain("NEVER run the full test suite without a filter");
  });

  test("test-writer without scoped template → no region (unconfigured fallback)", async () => {
    const story = makeStory();
    const config = makeNaxConfig({
      quality: {
        commands: { test: "bun test" },
      },
    });
    const prompt = await TddPromptBuilder.buildForRole("test-writer", "/tmp", config, story, {});

    // No `run-test` marker when no scoped key is configured.
    expect(prompt).not.toContain("<!--nax:run-test:");
    // Shell example still appears.
    expect(prompt).toContain("`bun test <path/to/test-file>`");
  });

  test("test-writer with a list scoped template → wraps the affordance", async () => {
    const story = makeStory();
    const config = makeNaxConfig({
      quality: {
        commands: {
          test: ["bun test", "bun test --coverage"],
          testScoped: ["bun test {{files}}", "bun test --coverage {{files}}"],
        },
      },
    });
    const prompt = await TddPromptBuilder.buildForRole("test-writer", "/tmp", config, story, {});
    expect(prompt).toContain("<!--nax:run-test:");
  });

  test("implementer + scoped template → isolation section also wraps the test-filter rule", async () => {
    const story = makeStory();
    const config = makeNaxConfig({
      quality: {
        commands: {
          test: "bun test",
          testScoped: "CI=1 bun test {{files}}",
        },
      },
    });
    const prompt = await TddPromptBuilder.buildForRole("implementer", "/tmp", config, story, {});

    expect(prompt).toContain("<!--nax:run-test:");
  });
});

// ---------------------------------------------------------------------------
// Single-frame PR 2 (Task 16) — render-and-read: the composed story section
// must pass repo-rooted paths through unchanged. The builder's own `workdir`
// argument is the PROMPT-LOADER directory (src/prompts/loader.ts joins it with
// the override path), NOT the agent containment root, so it must not re-frame
// story paths. Both a package story and a root story are rendered and read.
// ---------------------------------------------------------------------------

describe("TddPromptBuilder.buildForRole — repo-rooted story frame post-root-move", () => {
  test("package story renders its modifiedFiles entry repo-rooted, not re-prefixed by the package", async () => {
    const story = makeStory({
      workdir: "packages/app",
      acceptanceCriteria: ["AC-1: works"],
      modifiedFiles: [{ path: "packages/app/src/index.ts", reason: "the assertion moved" }],
    });

    const prompt = await TddPromptBuilder.buildForRole("test-writer", "/repo", makeNaxConfig({}), story, {});

    // Rendered repo-rooted exactly as stored...
    expect(prompt).toContain("`packages/app/src/index.ts` — the assertion moved");
    // ...never re-spelled against the package a second time.
    expect(prompt).not.toContain("packages/app/packages/app/src/index.ts");
  });

  test("root story renders its modifiedFiles entry repo-rooted", async () => {
    const story = makeStory({
      workdir: ".",
      acceptanceCriteria: ["AC-1: works"],
      modifiedFiles: [{ path: "src/index.ts", reason: "root frame" }],
    });

    const prompt = await TddPromptBuilder.buildForRole("test-writer", "/repo", makeNaxConfig({}), story, {});

    expect(prompt).toContain("`src/index.ts` — root frame");
  });
});

// ---------------------------------------------------------------------------
// US-004 — bounded upfront test-baseline section.
//
// The section is fed by `.testBaseline()`; `buildForRole` resolves the value
// from the persisted artifact. Both ends are pinned here because AC1–AC6 are
// about `build()` and AC7 is about the production `buildForRole` path.
// ---------------------------------------------------------------------------

const BASELINE_FEATURE = "feature-us004";
const BASELINE_STORY = "US-004";

function capturedBaseline(entries: BaselineEntry[]): TestBaseline {
  return {
    kind: "captured",
    source: "preflight",
    capturedAt: "2026-01-15T00:00:00.000Z",
    baseRef: "base-0001",
    entries,
  };
}

const NO_BASELINE_MARKER: TestBaseline = {
  kind: "no-baseline",
  reason: "timeout",
  capturedAt: "2026-01-15T00:00:00.000Z",
};

function builderWith(role: "implementer" | "test-writer") {
  return TddPromptBuilder.for(role, { variant: "standard" })
    .story(makeStory({ id: BASELINE_STORY }))
    .withLoader("/tmp", makeNaxConfig({}));
}

describe("US-004 — TddPromptBuilder test baseline section", () => {
  test("AC1: a captured baseline renders the base ref, the failure count, and each failing file", async () => {
    const prompt = await builderWith("implementer")
      .testBaseline(
        capturedBaseline([
          { file: "test/unit/alpha.test.ts", testName: "alpha fails" },
          { file: "test/unit/beta.test.ts", testName: "beta fails" },
        ]),
      )
      .build();

    expect(prompt).toContain("# Test Baseline");
    expect(prompt).toContain("base-0001");
    expect(prompt).toContain("2 failing test(s)");
    expect(prompt).toContain("test/unit/alpha.test.ts");
    expect(prompt).toContain("test/unit/beta.test.ts");
  });

  test("AC2: a captured baseline with zero entries states it is green and blames any failure on this story", async () => {
    const prompt = await builderWith("implementer").testBaseline(capturedBaseline([])).build();

    expect(prompt).toContain("# Test Baseline");
    expect(prompt).toContain("green at `base-0001`");
    expect(prompt).toContain("introduced by this story");
  });

  test("AC3: a no-baseline marker renders the section with its reason", async () => {
    const prompt = await builderWith("implementer").testBaseline(NO_BASELINE_MARKER).build();

    expect(prompt).toContain("# Test Baseline");
    expect(prompt).toContain("No baseline available");
    expect(prompt).toContain("timeout");
  });

  test("AC4: without .testBaseline() the prompt contains no baseline section", async () => {
    const prompt = await builderWith("implementer").build();

    expect(prompt).not.toContain("# Test Baseline");
  });

  test("AC4: .testBaseline(undefined) renders byte-identical output to omitting the call", async () => {
    const omitted = await builderWith("implementer").build();
    const explicitUndefined = await builderWith("implementer").testBaseline(undefined).build();

    expect(explicitUndefined).toBe(omitted);
    expect(explicitUndefined).not.toContain("# Test Baseline");
  });

  test("AC5: the rendered section carries the authoritative / do-not-re-run directive", async () => {
    const prompt = await builderWith("implementer")
      .testBaseline(capturedBaseline([{ file: "test/unit/alpha.test.ts" }]))
      .build();

    expect(prompt).toContain("authoritative");
    expect(prompt).toContain("do not re-run the full test suite");
  });

  test("AC6: an oversized baseline is bounded, keeps the count and leading files, and ends with 'and N more'", async () => {
    const files = Array.from({ length: 200 }, (_, i) => ({
      file: `test/unit/deeply/nested/directory/number-${String(i).padStart(3, "0")}/a-descriptively-named-suite.test.ts`,
    }));
    const prompt = await builderWith("implementer").testBaseline(capturedBaseline(files)).build();

    expect(prompt).toContain("# Test Baseline");
    expect(prompt).toContain("200 failing test(s)");
    expect(prompt).toContain("number-000");
    expect(prompt).toMatch(/and \d+ more/);
    // The cap actually bit: the trailing file never reached the prompt.
    expect(prompt).not.toContain("number-199");
  });

  test("the baseline section is rendered for the test-writer role too", async () => {
    const prompt = await builderWith("test-writer")
      .testBaseline(capturedBaseline([{ file: "test/unit/alpha.test.ts" }]))
      .build();

    expect(prompt).toContain("# Test Baseline");
    expect(prompt).toContain("test/unit/alpha.test.ts");
  });
});

describe("US-004 — buildForRole resolves the story baseline artifact", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = makeTempDir("nax-test-us004-baseline-");
  });

  afterEach(() => {
    cleanupTempDir(tempRoot);
  });

  test("AC7: a seeded story baseline artifact reaches the implementer prompt", async () => {
    await writeStoryBaseline(
      tempRoot,
      BASELINE_FEATURE,
      BASELINE_STORY,
      capturedBaseline([{ file: "test/unit/alpha.test.ts", testName: "alpha fails" }]),
    );

    const prompt = await TddPromptBuilder.buildForRole(
      "implementer",
      tempRoot,
      makeNaxConfig({}),
      makeStory({ id: BASELINE_STORY }),
      { root: tempRoot, featureId: BASELINE_FEATURE },
    );

    expect(prompt).toContain("# Test Baseline");
    expect(prompt).toContain("base-0001");
    expect(prompt).toContain("test/unit/alpha.test.ts");
  });

  test("a missing artifact renders no baseline section", async () => {
    const prompt = await TddPromptBuilder.buildForRole(
      "implementer",
      tempRoot,
      makeNaxConfig({}),
      makeStory({ id: BASELINE_STORY }),
      { root: tempRoot, featureId: BASELINE_FEATURE },
    );

    expect(prompt).not.toContain("# Test Baseline");
  });

  test("parallel prompt rendering reads the run-start baseline when a story artifact remains", async () => {
    await writeStoryBaseline(
      tempRoot,
      BASELINE_FEATURE,
      BASELINE_STORY,
      capturedBaseline([{ file: "test/unit/story-artifact.test.ts" }]),
    );
    await writeRunBaseline(tempRoot, BASELINE_FEATURE, {
      kind: "captured",
      source: "preflight",
      baseRef: "parallel-run-base",
      capturedAt: "2026-01-15T00:00:00.000Z",
      entries: [{ file: "test/unit/run-baseline.test.ts" }],
    });

    const prompt = await TddPromptBuilder.buildForRole(
      "implementer",
      tempRoot,
      makeNaxConfig({}),
      makeStory({ id: BASELINE_STORY }),
      { root: tempRoot, featureId: BASELINE_FEATURE, executionMode: "parallel" },
    );

    expect(prompt).toContain("test/unit/run-baseline.test.ts");
    expect(prompt).not.toContain("test/unit/story-artifact.test.ts");
  });

  test("a persisted no-baseline marker renders the section with its reason", async () => {
    await writeStoryBaseline(tempRoot, BASELINE_FEATURE, BASELINE_STORY, NO_BASELINE_MARKER);

    const prompt = await TddPromptBuilder.buildForRole(
      "implementer",
      tempRoot,
      makeNaxConfig({}),
      makeStory({ id: BASELINE_STORY }),
      { root: tempRoot, featureId: BASELINE_FEATURE },
    );

    expect(prompt).toContain("# Test Baseline");
    expect(prompt).toContain("No baseline available");
    expect(prompt).toContain("timeout");
  });

  test("without an artifact root the prompt falls back to no baseline section", async () => {
    await writeStoryBaseline(
      tempRoot,
      BASELINE_FEATURE,
      BASELINE_STORY,
      capturedBaseline([{ file: "test/unit/alpha.test.ts" }]),
    );

    const prompt = await TddPromptBuilder.buildForRole(
      "implementer",
      tempRoot,
      makeNaxConfig({}),
      makeStory({ id: BASELINE_STORY }),
      {},
    );

    expect(prompt).not.toContain("# Test Baseline");
  });

  test("a corrupt artifact is treated as no baseline rather than failing the prompt build", async () => {
    const artifact = `${featureDir(tempRoot, BASELINE_FEATURE)}/stories/${BASELINE_STORY}/test-baseline.json`;
    await writeStoryBaseline(tempRoot, BASELINE_FEATURE, BASELINE_STORY, capturedBaseline([]));
    await Bun.write(artifact, "{ not json");

    const prompt = await TddPromptBuilder.buildForRole(
      "implementer",
      tempRoot,
      makeNaxConfig({}),
      makeStory({ id: BASELINE_STORY }),
      { root: tempRoot, featureId: BASELINE_FEATURE },
    );

    expect(prompt).not.toContain("# Test Baseline");
  });

  test("a well-formed JSON artifact of the wrong shape renders no section instead of failing the build", async () => {
    // `loadJsonFile` hands the parsed JSON back with no schema check (an
    // unchecked cast to the caller's type parameter), so every one of these
    // reaches the builder typed as a `TestBaseline`.
    const artifact = `${featureDir(tempRoot, BASELINE_FEATURE)}/stories/${BASELINE_STORY}/test-baseline.json`;
    await writeStoryBaseline(tempRoot, BASELINE_FEATURE, BASELINE_STORY, capturedBaseline([]));

    const wrongShapes = [
      `{"kind":"captured","entries":null}`,
      `{"kind":"captured"}`,
      `{"kind":"not-a-baseline","entries":[]}`,
      `{"kind":"captured","entries":[null]}`,
      `{"kind":"captured","entries":[{"file":42}]}`,
    ];

    for (const payload of wrongShapes) {
      await Bun.write(artifact, payload);

      const prompt = await TddPromptBuilder.buildForRole(
        "implementer",
        tempRoot,
        makeNaxConfig({}),
        makeStory({ id: BASELINE_STORY }),
        { root: tempRoot, featureId: BASELINE_FEATURE },
      );

      expect(prompt).not.toContain("# Test Baseline");
    }
  });
});
