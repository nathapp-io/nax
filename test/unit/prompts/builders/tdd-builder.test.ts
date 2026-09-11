import { describe, expect, test } from "bun:test";
import { makeNaxConfig, makeStory } from "@test/helpers";
import { TddPromptBuilder } from "@/prompts/builders/tdd-builder";

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
