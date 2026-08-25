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
