/**
 * Tests for language-aware acceptance test generation (US-007)
 *
 * Covers:
 * - generateSkeletonTests() with language param (go, python, rust)
 * - extractTestCode() recognizing Go and Python patterns
 * - generateFromPRD() uses language-appropriate filename in prompt
 */

import { describe, expect, mock, test } from "bun:test";
import {
  extractTestCode,
  generateFromPRD,
  generateSkeletonTests,
} from "../../../src/acceptance/generator";
import type { AcceptanceCriterion } from "../../../src/acceptance/types";
import type { AgentAdapter } from "../../../src/agents/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleCriteria: AcceptanceCriterion[] = [
  { id: "AC-1", text: "handles empty input", lineNumber: 1 },
  { id: "AC-2", text: "validates output format", lineNumber: 2 },
];

const minimalConfig = {
  version: 1 as const,
  acceptance: { timeoutMs: 5000 },
} as any;

const minimalModelDef = { provider: "anthropic" as const, model: "claude-sonnet-4-5" as any };

// ---------------------------------------------------------------------------
// generateSkeletonTests — Go language
// ---------------------------------------------------------------------------

describe("generateSkeletonTests — Go language", () => {
  test("starts with 'package acceptance_test'", () => {
    const result = generateSkeletonTests("myfeature", sampleCriteria, undefined, "go");
    expect(result.trimStart()).toMatch(/^package acceptance_test/);
  });

  test("contains 'import \"testing\"'", () => {
    const result = generateSkeletonTests("myfeature", sampleCriteria, undefined, "go");
    expect(result).toContain('import "testing"');
  });

  test("contains a func Test function for each criterion", () => {
    const result = generateSkeletonTests("myfeature", sampleCriteria, undefined, "go");
    // Each criterion should produce a func TestXxx(t *testing.T)
    expect(result).toMatch(/func Test\w+\(t \*testing\.T\)/);
    // Two criteria → two test functions
    const matches = result.match(/func Test\w+\(t \*testing\.T\)/g) ?? [];
    expect(matches.length).toBe(2);
  });

  test("does not contain TypeScript bun:test import", () => {
    const result = generateSkeletonTests("myfeature", sampleCriteria, undefined, "go");
    expect(result).not.toContain("bun:test");
  });
});

// ---------------------------------------------------------------------------
// generateSkeletonTests — Python language
// ---------------------------------------------------------------------------

describe("generateSkeletonTests — Python language", () => {
  test("contains 'import pytest'", () => {
    const result = generateSkeletonTests("myfeature", sampleCriteria, undefined, "python");
    expect(result).toContain("import pytest");
  });

  test("contains def test_ functions for each criterion", () => {
    const result = generateSkeletonTests("myfeature", sampleCriteria, undefined, "python");
    const matches = result.match(/def test_\w+/g) ?? [];
    expect(matches.length).toBe(2);
  });

  test("does not contain TypeScript bun:test import", () => {
    const result = generateSkeletonTests("myfeature", sampleCriteria, undefined, "python");
    expect(result).not.toContain("bun:test");
  });
});

// ---------------------------------------------------------------------------
// generateSkeletonTests — Rust language
// ---------------------------------------------------------------------------

describe("generateSkeletonTests — Rust language", () => {
  test("contains '#[cfg(test)]'", () => {
    const result = generateSkeletonTests("myfeature", sampleCriteria, undefined, "rust");
    expect(result).toContain("#[cfg(test)]");
  });

  test("contains '#[test]' attribute on each test function", () => {
    const result = generateSkeletonTests("myfeature", sampleCriteria, undefined, "rust");
    const matches = result.match(/#\[test\]/g) ?? [];
    expect(matches.length).toBe(2);
  });

  test("does not contain TypeScript bun:test import", () => {
    const result = generateSkeletonTests("myfeature", sampleCriteria, undefined, "rust");
    expect(result).not.toContain("bun:test");
  });
});

// ---------------------------------------------------------------------------
// generateSkeletonTests — backward-compat: language=undefined → TypeScript
// ---------------------------------------------------------------------------

describe("generateSkeletonTests — no language param keeps TypeScript output", () => {
  test("still generates bun:test TypeScript when language is omitted", () => {
    const result = generateSkeletonTests("myfeature", sampleCriteria);
    expect(result).toContain('import { describe, test, expect } from "bun:test"');
  });
});

// ---------------------------------------------------------------------------
// extractTestCode — Go patterns
// ---------------------------------------------------------------------------

describe("extractTestCode — Go patterns", () => {
  test("returns non-null for Go output with package declaration and func Test", () => {
    const goOutput = `package mypackage

import "testing"

func TestHandlesEmptyInput(t *testing.T) {
  result := MyFunc("")
  if result != "" {
    t.Errorf("expected empty string, got %q", result)
  }
}
`;
    const result = extractTestCode(goOutput);
    expect(result).not.toBeNull();
  });

  test("returns non-null for Go output embedded in prose", () => {
    const goOutput = `Here is the Go test file:

package acceptance_test

import "testing"

func TestACOne(t *testing.T) {
  t.Log("placeholder")
}
`;
    const result = extractTestCode(goOutput);
    expect(result).not.toBeNull();
  });

  test("returned value contains the func Test declaration", () => {
    const goOutput = `package foo

import "testing"

func TestSomething(t *testing.T) {
  if 1 != 1 {
    t.Fail()
  }
}
`;
    const result = extractTestCode(goOutput);
    expect(result).toContain("func TestSomething");
  });
});

// ---------------------------------------------------------------------------
// extractTestCode — Python patterns
// ---------------------------------------------------------------------------

describe("extractTestCode — Python patterns", () => {
  test("returns non-null when output contains def test_ function", () => {
    const pythonOutput = `import pytest

def test_handles_empty_input():
    assert my_func("") == ""
`;
    const result = extractTestCode(pythonOutput);
    expect(result).not.toBeNull();
  });

  test("returns non-null for def test_ without import", () => {
    const pythonOutput = `def test_validates_output():
    result = compute()
    assert result is not None
`;
    const result = extractTestCode(pythonOutput);
    expect(result).not.toBeNull();
  });

  test("returned value contains the def test_ declaration", () => {
    const pythonOutput = `import pytest

def test_ac_one():
    assert True
`;
    const result = extractTestCode(pythonOutput);
    expect(result).toContain("def test_ac_one");
  });
});

// ---------------------------------------------------------------------------
// generateFromPRD — language option affects prompt filename
// ---------------------------------------------------------------------------

describe("generateFromPRD — Go language uses acceptance_test.go in prompt", () => {
  test("prompt contains 'acceptance_test.go' when language is 'go'", async () => {
    let capturedPrompt = "";
    const mockAdapter: AgentAdapter = {
      complete: mock(async (prompt: string) => {
        capturedPrompt = prompt;
        // Return something that extractTestCode won't parse so we get a skeleton
        return "I cannot generate a test file";
      }),
    } as unknown as AgentAdapter;

    const refinedCriteria = [
      { original: "handles input", refined: "handles input", testable: true, storyId: "US-001" },
    ];

    await generateFromPRD([], refinedCriteria, {
      featureName: "myfeature",
      workdir: "/tmp/workdir",
      featureDir: "/tmp/featureDir",
      codebaseContext: "minimal context",
      modelTier: "balanced",
      modelDef: minimalModelDef,
      config: minimalConfig,
      adapter: mockAdapter,
      language: "go",
    } as any);

    expect(capturedPrompt).toContain("acceptance_test.go");
    expect(capturedPrompt).not.toContain("acceptance.test.ts");
  });
});

describe("generateFromPRD — Python language uses test_acceptance.py in prompt", () => {
  test("prompt contains 'test_acceptance.py' when language is 'python'", async () => {
    let capturedPrompt = "";
    const mockAdapter: AgentAdapter = {
      complete: mock(async (prompt: string) => {
        capturedPrompt = prompt;
        return "I cannot generate a test file";
      }),
    } as unknown as AgentAdapter;

    const refinedCriteria = [
      { original: "handles input", refined: "handles input", testable: true, storyId: "US-001" },
    ];

    await generateFromPRD([], refinedCriteria, {
      featureName: "myfeature",
      workdir: "/tmp/workdir",
      featureDir: "/tmp/featureDir",
      codebaseContext: "minimal context",
      modelTier: "balanced",
      modelDef: minimalModelDef,
      config: minimalConfig,
      adapter: mockAdapter,
      language: "python",
    } as any);

    expect(capturedPrompt).toContain("test_acceptance.py");
    expect(capturedPrompt).not.toContain("acceptance.test.ts");
  });
});

describe("generateFromPRD — no language defaults to acceptance.test.ts", () => {
  test("prompt contains 'acceptance.test.ts' when language is omitted", async () => {
    let capturedPrompt = "";
    const mockAdapter: AgentAdapter = {
      complete: mock(async (prompt: string) => {
        capturedPrompt = prompt;
        return "I cannot generate a test file";
      }),
    } as unknown as AgentAdapter;

    const refinedCriteria = [
      { original: "handles input", refined: "handles input", testable: true, storyId: "US-001" },
    ];

    await generateFromPRD([], refinedCriteria, {
      featureName: "myfeature",
      workdir: "/tmp/workdir",
      featureDir: "/tmp/featureDir",
      codebaseContext: "minimal context",
      modelTier: "balanced",
      modelDef: minimalModelDef,
      config: minimalConfig,
      adapter: mockAdapter,
    } as any);

    expect(capturedPrompt).toContain("acceptance.test.ts");
  });
});
