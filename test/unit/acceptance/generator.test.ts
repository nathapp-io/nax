/**
 * Tests for acceptanceTestFilename() and buildAcceptanceRunCommand()
 * in src/acceptance/generator.ts.
 *
 * US-001 (ACC-002): acceptanceTestFilename() now returns dot-prefixed filenames
 * placed at the package root (.nax-acceptance.test.ts) instead of the old
 * acceptance.test.ts in the .nax/features/ directory.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  _generatorPRDDeps,
  acceptanceTestFilename,
  buildAcceptanceRunCommand,
  generateFromPRD,
} from "../../../src/acceptance/generator";
import type { GenerateFromPRDOptions, RefinedCriterion } from "../../../src/acceptance/types";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";

// ---------------------------------------------------------------------------
// acceptanceTestFilename — US-001 AC-5
// ---------------------------------------------------------------------------

describe("acceptanceTestFilename — dot-prefixed package-root filenames", () => {
  test("returns .nax-acceptance.test.ts when no language is given", () => {
    expect(acceptanceTestFilename()).toBe(".nax-acceptance.test.ts");
  });

  test("returns .nax-acceptance.test.ts for undefined language", () => {
    expect(acceptanceTestFilename(undefined)).toBe(".nax-acceptance.test.ts");
  });

  test("returns .nax-acceptance_test.go for go", () => {
    expect(acceptanceTestFilename("go")).toBe(".nax-acceptance_test.go");
  });

  test("returns .nax-acceptance.test.py for python", () => {
    expect(acceptanceTestFilename("python")).toBe(".nax-acceptance.test.py");
  });

  test("returns .nax-acceptance.rs for rust", () => {
    expect(acceptanceTestFilename("rust")).toBe(".nax-acceptance.rs");
  });

  test("is case-insensitive for language", () => {
    expect(acceptanceTestFilename("GO")).toBe(".nax-acceptance_test.go");
    expect(acceptanceTestFilename("Python")).toBe(".nax-acceptance.test.py");
  });

  test("returns .nax-acceptance.test.ts for unknown language", () => {
    expect(acceptanceTestFilename("ruby")).toBe(".nax-acceptance.test.ts");
  });

  test("does not return the old acceptance.test.ts filename", () => {
    expect(acceptanceTestFilename()).not.toBe("acceptance.test.ts");
    expect(acceptanceTestFilename("go")).not.toBe("acceptance_test.go");
    expect(acceptanceTestFilename("python")).not.toBe("test_acceptance.py");
  });
});

// ---------------------------------------------------------------------------
// buildAcceptanceRunCommand — unchanged behavior
// ---------------------------------------------------------------------------

describe("buildAcceptanceRunCommand — builds correct command for test file", () => {
  test("returns bun test command for .nax-acceptance.test.ts by default", () => {
    const cmd = buildAcceptanceRunCommand("/project/.nax-acceptance.test.ts");
    expect(cmd).toEqual(["bun", "test", "/project/.nax-acceptance.test.ts", "--timeout=60000"]);
  });

  test("uses vitest for vitest framework", () => {
    const cmd = buildAcceptanceRunCommand("/pkg/.nax-acceptance.test.ts", "vitest");
    expect(cmd).toEqual(["npx", "vitest", "run", "/pkg/.nax-acceptance.test.ts"]);
  });

  test("substitutes {{FILE}} in command override", () => {
    const cmd = buildAcceptanceRunCommand("/pkg/.nax-acceptance.test.ts", undefined, "bun test {{FILE}}");
    expect(cmd).toEqual(["bun", "test", "/pkg/.nax-acceptance.test.ts"]);
  });
});

// ---------------------------------------------------------------------------
// US-002 AC-1 / AC-4: GenerateFromPRDOptions new optional fields
// ---------------------------------------------------------------------------

describe("GenerateFromPRDOptions — implementationContext and previousFailure fields", () => {
  test("accepts optional implementationContext field with array of path/content pairs", () => {
    const opts: GenerateFromPRDOptions = {
      featureName: "feat",
      workdir: "/tmp",
      featureDir: "/tmp/.nax/features/feat",
      codebaseContext: "",
      modelTier: "balanced",
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
      config: DEFAULT_CONFIG,
      implementationContext: [{ path: "src/add.ts", content: "export function add() {}" }],
    };
    expect(opts.implementationContext).toHaveLength(1);
    expect(opts.implementationContext?.[0].path).toBe("src/add.ts");
  });

  test("accepts undefined implementationContext (field is optional)", () => {
    const opts: Partial<GenerateFromPRDOptions> = { implementationContext: undefined };
    expect(opts.implementationContext).toBeUndefined();
  });

  test("accepts optional previousFailure field as a string", () => {
    const opts: GenerateFromPRDOptions = {
      featureName: "feat",
      workdir: "/tmp",
      featureDir: "/tmp/.nax/features/feat",
      codebaseContext: "",
      modelTier: "balanced",
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
      config: DEFAULT_CONFIG,
      previousFailure: "TypeError: Cannot read property 'x' of undefined",
    };
    expect(opts.previousFailure).toBe("TypeError: Cannot read property 'x' of undefined");
  });

  test("accepts undefined previousFailure (field is optional)", () => {
    const opts: Partial<GenerateFromPRDOptions> = { previousFailure: undefined };
    expect(opts.previousFailure).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// US-002 AC-2 / AC-3: generateFromPRD() prompt with implementationContext
// ---------------------------------------------------------------------------

const MOCK_TEST_OUTPUT = `\`\`\`typescript
import { test, expect } from "bun:test";
describe("feat", () => { test("AC-1: works", () => { expect(1).toBe(1); }); });
\`\`\``;

function makeBaseOptions(overrides: Partial<GenerateFromPRDOptions> = {}): GenerateFromPRDOptions {
  return {
    featureName: "test-feature",
    workdir: "/tmp/test-workdir",
    featureDir: "/tmp/test-workdir/.nax/features/test-feature",
    codebaseContext: "src/: index.ts",
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
    config: DEFAULT_CONFIG,
    ...overrides,
  };
}

function makeRefinedCriteria(): RefinedCriterion[] {
  return [{ original: "foo works", refined: "foo() returns correct value", testable: true, storyId: "US-001" }];
}

describe("generateFromPRD() prompt — implementationContext (US-002 AC-2 / AC-3)", () => {
  let capturedPrompt: string;
  let origAdapter: typeof _generatorPRDDeps.adapter;
  let origWriteFile: typeof _generatorPRDDeps.writeFile;

  beforeEach(() => {
    capturedPrompt = "";
    origAdapter = _generatorPRDDeps.adapter;
    origWriteFile = _generatorPRDDeps.writeFile;
    (_generatorPRDDeps as { adapter: unknown }).adapter = {
      complete: mock(async (prompt: string) => {
        capturedPrompt = prompt;
        return { output: MOCK_TEST_OUTPUT, costUsd: 0, source: "exact" as const };
      }),
    };
    (_generatorPRDDeps as { writeFile: unknown }).writeFile = mock(async () => {});
  });

  afterEach(() => {
    (_generatorPRDDeps as { adapter: unknown }).adapter = origAdapter;
    (_generatorPRDDeps as { writeFile: unknown }).writeFile = origWriteFile;
  });

  test("prompt includes 'Implementation (already exists)' section when implementationContext has entries", async () => {
    await generateFromPRD([], makeRefinedCriteria(), {
      ...makeBaseOptions(),
      implementationContext: [{ path: "src/add.ts", content: "export function add(a: number, b: number) { return a + b; }" }],
    });
    expect(capturedPrompt).toContain("Implementation (already exists)");
  });

  test("prompt includes each file path from implementationContext", async () => {
    await generateFromPRD([], makeRefinedCriteria(), {
      ...makeBaseOptions(),
      implementationContext: [
        { path: "src/add.ts", content: "export function add() {}" },
        { path: "src/utils.ts", content: "export function clamp() {}" },
      ],
    });
    expect(capturedPrompt).toContain("src/add.ts");
    expect(capturedPrompt).toContain("src/utils.ts");
  });

  test("prompt includes file content in fenced code blocks when implementationContext has entries", async () => {
    const content = "export function add(a: number, b: number) { return a + b; }";
    await generateFromPRD([], makeRefinedCriteria(), {
      ...makeBaseOptions(),
      implementationContext: [{ path: "src/add.ts", content }],
    });
    expect(capturedPrompt).toContain(content);
    expect(capturedPrompt).toContain("```");
  });

  test("prompt does NOT include 'Implementation (already exists)' when implementationContext is undefined", async () => {
    await generateFromPRD([], makeRefinedCriteria(), makeBaseOptions());
    expect(capturedPrompt).not.toContain("Implementation (already exists)");
  });

  test("prompt does NOT include 'Implementation (already exists)' when implementationContext is empty array", async () => {
    await generateFromPRD([], makeRefinedCriteria(), {
      ...makeBaseOptions(),
      implementationContext: [],
    });
    expect(capturedPrompt).not.toContain("Implementation (already exists)");
  });
});

// ---------------------------------------------------------------------------
// US-002 AC-4 / AC-5: generateFromPRD() prompt with previousFailure
// ---------------------------------------------------------------------------

describe("generateFromPRD() prompt — previousFailure (US-002 AC-4 / AC-5)", () => {
  let capturedPrompt: string;
  let origAdapter: typeof _generatorPRDDeps.adapter;
  let origWriteFile: typeof _generatorPRDDeps.writeFile;

  beforeEach(() => {
    capturedPrompt = "";
    origAdapter = _generatorPRDDeps.adapter;
    origWriteFile = _generatorPRDDeps.writeFile;
    (_generatorPRDDeps as { adapter: unknown }).adapter = {
      complete: mock(async (prompt: string) => {
        capturedPrompt = prompt;
        return { output: MOCK_TEST_OUTPUT, costUsd: 0, source: "exact" as const };
      }),
    };
    (_generatorPRDDeps as { writeFile: unknown }).writeFile = mock(async () => {});
  });

  afterEach(() => {
    (_generatorPRDDeps as { adapter: unknown }).adapter = origAdapter;
    (_generatorPRDDeps as { writeFile: unknown }).writeFile = origWriteFile;
  });

  test("prompt includes 'Previous test failed because:' when previousFailure is provided", async () => {
    const failureMsg = "TypeError: Cannot read property 'x' of undefined at line 42";
    await generateFromPRD([], makeRefinedCriteria(), {
      ...makeBaseOptions(),
      previousFailure: failureMsg,
    });
    expect(capturedPrompt).toContain("Previous test failed because:");
    expect(capturedPrompt).toContain(failureMsg);
  });

  test("prompt does NOT include previous failure section when previousFailure is undefined", async () => {
    await generateFromPRD([], makeRefinedCriteria(), makeBaseOptions());
    expect(capturedPrompt).not.toContain("Previous test failed because:");
  });

  test("prompt does NOT include previous failure section when previousFailure is empty string", async () => {
    await generateFromPRD([], makeRefinedCriteria(), {
      ...makeBaseOptions(),
      previousFailure: "",
    });
    expect(capturedPrompt).not.toContain("Previous test failed because:");
  });
});
