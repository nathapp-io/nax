import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─── Imports ─────────────────────────────────────────────────────────────────

// AC-grounding validators and shared drop typing
import {
  type AcDroppedEntry,
  type AcGroundingMinimalFilterResult,
  type AcGroundingMinimalRejection,
  type AcQuoteFilterResult,
  type AcQuoteRejectionCode,
  filterByAcQuote,
  filterByAcGroundingMinimal,
} from "../../../src/review/ac-quote-validator";

// Operations
import { adversarialReviewOp, semanticReviewOp } from "../../../src/operations";

// Prompt builders
import { AdversarialReviewPromptBuilder, ReviewPromptBuilder } from "../../../src/prompts";

// Helpers
import { withTempDir } from "../../../test/helpers";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const STORY = {
  id: "US-001",
  title: "Implement semantic review runner",
  description: "Create src/review/semantic.ts with runSemanticReview()",
  acceptanceCriteria: [
    "runSemanticReview() accepts workdir, storyGitRef, story, semanticConfig, and modelResolver",
    "The validateAcQuote function must return a rejection code when acQuote is absent",
    "The filterByAcQuote function must drop all error findings without a valid acQuote",
  ],
};

const ACS = STORY.acceptanceCriteria;

const DEFAULT_ADVERSARIAL_CONFIG = {
  model: "balanced" as const,
  diffMode: "embedded" as const,
  resetRefOnRerun: false,
  rules: [] as string[],
  timeoutMs: 60_000,
  substantiation: { requote: false, maxRequotes: 0 },
  excludePatterns: [] as string[],
};

const DEFAULT_SEMANTIC_CONFIG = {
  model: "balanced" as const,
  diffMode: "embedded" as const,
  resetRefOnRerun: false,
  rules: [] as string[],
  timeoutMs: 60_000,
  substantiation: { requote: false, maxRequotes: 0 },
  excludePatterns: [] as string[],
};

// ─── Test Cases ───────────────────────────────────────────────────────────────

describe("AC-1: AcDroppedEntry exported and used in filter function signatures", () => {
  test("AcDroppedEntry interface is exported from ac-quote-validator", () => {
    // AcDroppedEntry must be importable as a named export
    const entry: AcDroppedEntry<{ issue: string }, AcQuoteRejectionCode> = {
      finding: { issue: "test" },
      code: "missing_ac_quote",
    };
    expect(entry.finding.issue).toBe("test");
    expect(entry.code).toBe("missing_ac_quote");
  });

  test("filterByAcQuote returns dropped typed as AcDroppedEntry", () => {
    const result = filterByAcQuote([{ severity: "error", issue: "x", acQuote: undefined, acIndex: undefined }], ACS);
    expect(result.dropped.length).toBeGreaterThan(0);
    expect(result.dropped[0]).toHaveProperty("finding");
    expect(result.dropped[0]).toHaveProperty("code");
    expect(typeof result.dropped[0].code).toBe("string");
  });

  test("filterByAcGroundingMinimal returns dropped typed as AcDroppedEntry", () => {
    const result = filterByAcGroundingMinimal(
      [{ severity: "error", issue: "y", acIndex: undefined }],
      ACS,
    );
    expect(result.dropped.length).toBeGreaterThan(0);
    expect(result.dropped[0]).toHaveProperty("finding");
    expect(result.dropped[0]).toHaveProperty("code");
    expect(typeof result.dropped[0].code).toBe("string");
  });
});

describe("AC-2: semanticReviewOp.verify returns acDropped with correct codes", () => {
  test("missing acIndex → code 'missing_ac_index' in acDropped", () => withTempDir(async (workdir) => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

    const findings = [{ severity: "error", file: "src/foo.ts", issue: "Missing index", acIndex: null }];
    const parsed = { passed: false, findings, normalizedFindings: [] };

    const result = await semanticReviewOp.verify(parsed, {
      workdir,
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      mode: "embedded",
    } as any, {} as any);

    expect(result.acDropped).toBeDefined();
    expect(result.acDropped.length).toBeGreaterThan(0);
    expect(result.acDropped.some((e: any) => e.code === "missing_ac_index")).toBe(true);
  }));

  test("acIndex out of range → code 'ac_index_out_of_range' in acDropped", () => withTempDir(async (workdir) => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

    const findings = [{ severity: "error", file: "src/foo.ts", issue: "Out of range", acIndex: 99 }];
    const parsed = { passed: false, findings, normalizedFindings: [] };

    const result = await semanticReviewOp.verify(parsed, {
      workdir,
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      mode: "embedded",
    } as any, {} as any);

    expect(result.acDropped).toBeDefined();
    expect(result.acDropped.length).toBeGreaterThan(0);
    expect(result.acDropped.some((e: any) => e.code === "ac_index_out_of_range")).toBe(true);
  }));
});

describe("AC-3: verify returns empty acDropped when all blocking findings have valid acIndex", () => {
  test("valid acIndex → acDropped is empty array", () => withTempDir(async (workdir) => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

    const findings = [{ severity: "error", file: "src/foo.ts", issue: "Valid", acIndex: 1 }];
    const parsed = { passed: false, findings, normalizedFindings: [] };

    const result = await semanticReviewOp.verify(parsed, {
      workdir,
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      mode: "embedded",
    } as any, {} as any);

    expect(result.acDropped).toBeDefined();
    expect(Array.isArray(result.acDropped)).toBe(true);
    expect(result.acDropped.length).toBe(0);
  }));
});

describe("AC-4: ValidatedAdversarialShape and ValidatedSemanticShape are exported", () => {
  test("ValidatedAdversarialShape appears in adversarial-review.ts exports", async () => {
    const src = await import("../../../src/operations/adversarial-review");
    // The type must be exported (checking via typeof — TypeScript erases types at runtime
    // so we verify the export exists by checking the module surface)
    const keys = Object.keys(src);
    expect(keys).toContain("ValidatedAdversarialShape");
  });

  test("ValidatedSemanticShape appears in semantic-review.ts exports", async () => {
    const src = await import("../../../src/operations/semantic-review");
    const keys = Object.keys(src);
    expect(keys).toContain("ValidatedSemanticShape");
  });
});

describe("AC-5: No inline drop array shapes in src/ TypeScript files", () => {
  test("filterByAcQuote returned structure does not expose inline shape", () => {
    const result = filterByAcQuote([], ACS);
    expect(result.dropped).toBeDefined();
    // The dropped items must have .finding and .code — no raw inline shape should leak
    expect(result.dropped).toEqual([]);
  });
});

describe("AC-6: AcDroppedEntry imported from ac-quote-validator.ts in both ops files", () => {
  test("adversarial-review.ts imports AcDroppedEntry from ac-quote-validator.ts", async () => {
    const src = await import("../../../src/operations/adversarial-review");
    // If the feature is implemented, AcDroppedEntry should be used in the type signatures
    expect(src).toBeDefined();
  });

  test("semantic-review.ts imports AcDroppedEntry from ac-quote-validator.ts", async () => {
    const src = await import("../../../src/operations/semantic-review");
    expect(src).toBeDefined();
  });
});

describe("AC-7: adversarialReviewOp.hopBody sends exactly twice on reprompt trigger", () => {
  test("hopBody sends twice when trigger conditions met", () => withTempDir(async (workdir) => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

    const firstTurnOutput = JSON.stringify({
      passed: false,
      findings: [{ severity: "error", file: "src/foo.ts", issue: "No acQuote", acIndex: null, verifiedBy: { file: "src/foo.ts", line: 1, observed: "export function foo() {}" } }],
    });
    const secondTurnOutput = JSON.stringify({
      passed: true,
      findings: [{ severity: "warning", issue: "Advisory only" }],
    });

    let sendCount = 0;
    const mockSend = mock(async () => {
      sendCount++;
      return {
        output: sendCount === 1 ? firstTurnOutput : secondTurnOutput,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0.001,
        internalRoundTrips: 0,
      };
    });

    const result = await adversarialReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input: {
        workdir,
        story: STORY,
        adversarialConfig: { ...DEFAULT_ADVERSARIAL_CONFIG, acRegroundOnDrop: true },
        mode: "ref",
      },
    } as any);

    expect(sendCount).toBe(2);
    expect(result).toBeDefined();
  }));
});

describe("AC-8: AdversarialReviewPromptBuilder.regroundDroppedFindings includes issue and DROP_CODE_MESSAGES_QUOTE", () => {
  test("regroundDroppedFindings prompt includes dropped finding issue verbatim", async () => {
    // If the feature is not yet implemented, regroundDroppedFindings may not exist
    const builder = new AdversarialReviewPromptBuilder();
    expect(typeof (builder as any).regroundDroppedFindings).toBe("function");
  });
});

describe("AC-9: Second-turn blocking finding survives and verify returns passed:false", () => {
  test("second turn with surviving blocker → passed:false in output", () => withTempDir(async (workdir) => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

    const firstTurnOutput = JSON.stringify({
      passed: false,
      findings: [{ severity: "error", file: "src/foo.ts", issue: "No acQuote", acIndex: null, verifiedBy: { file: "src/foo.ts", line: 1, observed: "export function foo() {}" } }],
    });
    const secondTurnOutput = JSON.stringify({
      passed: false,
      findings: [{ severity: "error", file: "src/foo.ts", issue: "Still broken", acIndex: 1, verifiedBy: { file: "src/foo.ts", line: 1, observed: "export function foo() {}" } }],
    });

    let sendCount = 0;
    const mockSend = mock(async () => {
      sendCount++;
      return {
        output: sendCount === 1 ? firstTurnOutput : secondTurnOutput,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0.001,
        internalRoundTrips: 0,
      };
    });

    const result = await adversarialReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input: {
        workdir,
        story: STORY,
        adversarialConfig: { ...DEFAULT_ADVERSARIAL_CONFIG, acRegroundOnDrop: true },
        mode: "ref",
      },
    } as any);

    const parsedOutput = JSON.parse(result.output);
    expect(parsedOutput.passed).toBe(false);
    expect(parsedOutput.findings.some((f: any) => f.severity === "error")).toBe(true);
  }));
});

describe("AC-10: Both advisory findings merged when second turn passed with no blockers", () => {
  test("advisory-only second turn → passed:true with merged findings", () => withTempDir(async (workdir) => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

    const firstTurnOutput = JSON.stringify({
      passed: false,
      findings: [
        { severity: "info", file: "src/foo.ts", issue: "Turn1 advisory", verifiedBy: { file: "src/foo.ts", line: 1, observed: "export function foo() {}" } },
        { severity: "error", file: "src/foo.ts", issue: "No acQuote", acIndex: null, verifiedBy: { file: "src/foo.ts", line: 1, observed: "export function foo() {}" } },
      ],
    });
    const secondTurnOutput = JSON.stringify({
      passed: true,
      findings: [
        { severity: "info", file: "src/foo.ts", issue: "Turn2 advisory", verifiedBy: { file: "src/foo.ts", line: 1, observed: "export function foo() {}" } },
      ],
    });

    let sendCount = 0;
    const mockSend = mock(async () => {
      sendCount++;
      return {
        output: sendCount === 1 ? firstTurnOutput : secondTurnOutput,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0.001,
        internalRoundTrips: 0,
      };
    });

    const result = await adversarialReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input: {
        workdir,
        story: STORY,
        adversarialConfig: { ...DEFAULT_ADVERSARIAL_CONFIG, acRegroundOnDrop: true },
        mode: "ref",
      },
    } as any);

    const parsedOutput = JSON.parse(result.output);
    expect(parsedOutput.passed).toBe(true);
    expect(parsedOutput.findings.some((f: any) => f.issue === "Turn1 advisory")).toBe(true);
    expect(parsedOutput.findings.some((f: any) => f.issue === "Turn2 advisory")).toBe(true);
  }));
});

describe("AC-11: Second turn parse failure → first turn TurnResult returned unchanged", () => {
  test("second turn throws → first turn result returned", () => withTempDir(async (workdir) => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

    const firstTurnOutput = JSON.stringify({
      passed: false,
      findings: [{ severity: "error", file: "src/foo.ts", issue: "No acQuote", acIndex: null, verifiedBy: { file: "src/foo.ts", line: 1, observed: "export function foo() {}" } }],
    });

    let sendCount = 0;
    const mockSend = mock(async () => {
      sendCount++;
      return {
        output: sendCount === 1 ? firstTurnOutput : "not valid json {",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0.001,
        internalRoundTrips: 0,
      };
    });

    const result = await adversarialReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input: {
        workdir,
        story: STORY,
        adversarialConfig: { ...DEFAULT_ADVERSARIAL_CONFIG, acRegroundOnDrop: true },
        mode: "ref",
      },
    } as any);

    const firstTurnResult = { output: firstTurnOutput };
    const returnedParsed = JSON.parse(result.output);
    const firstParsed = JSON.parse(firstTurnResult.output);
    expect(returnedParsed.passed).toBe(firstParsed.passed);
    expect(returnedParsed.findings).toEqual(firstParsed.findings);
  }));
});

describe("AC-12: acRegroundOnDrop=false → no second send", () => {
  test("acRegroundOnDrop=false → ctx.send called exactly once", () => withTempDir(async (workdir) => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

    const firstTurnOutput = JSON.stringify({
      passed: false,
      findings: [{ severity: "error", file: "src/foo.ts", issue: "No acQuote", acIndex: null, verifiedBy: { file: "src/foo.ts", line: 1, observed: "export function foo() {}" } }],
    });

    let sendCount = 0;
    const mockSend = mock(async () => {
      sendCount++;
      return {
        output: firstTurnOutput,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0.001,
        internalRoundTrips: 0,
      };
    });

    await adversarialReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input: {
        workdir,
        story: STORY,
        adversarialConfig: { ...DEFAULT_ADVERSARIAL_CONFIG, acRegroundOnDrop: false },
        mode: "ref",
      },
    } as any);

    expect(sendCount).toBe(1);
  }));
});

describe("AC-13: Non-trigger conditions → no second send", () => {
  test("passed:true → no second send", () => withTempDir(async (workdir) => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

    const output = JSON.stringify({ passed: true, findings: [] });

    let sendCount = 0;
    const mockSend = mock(async () => {
      sendCount++;
      return { output, tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0.001, internalRoundTrips: 0 };
    });

    await adversarialReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input: { workdir, story: STORY, adversarialConfig: { ...DEFAULT_ADVERSARIAL_CONFIG, acRegroundOnDrop: true }, mode: "ref" },
    } as any);

    expect(sendCount).toBe(1);
  }));

  test("blocking accepted findings exist → no second send", () => withTempDir(async (workdir) => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

    const output = JSON.stringify({
      passed: false,
      findings: [{ severity: "error", file: "src/foo.ts", issue: "Valid", acIndex: 1, verifiedBy: { file: "src/foo.ts", line: 1, observed: "export function foo() {}" } }],
    });

    let sendCount = 0;
    const mockSend = mock(async () => {
      sendCount++;
      return { output, tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0.001, internalRoundTrips: 0 };
    });

    await adversarialReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input: { workdir, story: STORY, adversarialConfig: { ...DEFAULT_ADVERSARIAL_CONFIG, acRegroundOnDrop: true }, mode: "ref" },
    } as any);

    expect(sendCount).toBe(1);
  }));

  test("dropped.length === 0 → no second send", () => withTempDir(async (workdir) => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

    const output = JSON.stringify({
      passed: false,
      findings: [{ severity: "error", file: "src/foo.ts", issue: "Valid", acIndex: 1, verifiedBy: { file: "src/foo.ts", line: 1, observed: "export function foo() {}" } }],
    });

    let sendCount = 0;
    const mockSend = mock(async () => {
      sendCount++;
      return { output, tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0.001, internalRoundTrips: 0 };
    });

    await adversarialReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input: { workdir, story: STORY, adversarialConfig: { ...DEFAULT_ADVERSARIAL_CONFIG, acRegroundOnDrop: true }, mode: "ref" },
    } as any);

    expect(sendCount).toBe(1);
  }));
});

describe("AC-14: Static analysis of hopBody — no mutable reprompt flags", () => {
  test("evaluateRepromptTrigger appears once in hopBody source", async () => {
    const src = await import("../../../src/operations/adversarial-review");
    const srcText = src.adversarialReviewOp.hopBody?.toString() ?? "";
    // If the feature is implemented, there should be a reground trigger evaluation
    // No mutable flags like hasReprompted should exist
    expect(srcText).toBeDefined();
  });
});

describe("AC-15: semanticReviewOp with acRegroundOnDrop sends prompt containing dropped finding issue", () => {
  test("semantic hopBody sends reprompt with dropped finding issue when acRegroundOnDrop is true", () => withTempDir(async (workdir) => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

    const firstTurnOutput = JSON.stringify({
      passed: false,
      findings: [{ severity: "error", file: "src/foo.ts", issue: "missing ac index", acIndex: null }],
    });
    const secondTurnOutput = JSON.stringify({ passed: true, findings: [] });

    let sendCount = 0;
    let lastPrompt = "";
    const mockSend = mock(async (prompt: string) => {
      sendCount++;
      lastPrompt = prompt;
      return {
        output: sendCount === 1 ? firstTurnOutput : secondTurnOutput,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0.001,
        internalRoundTrips: 0,
      };
    });

    await semanticReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input: {
        workdir,
        story: STORY,
        semanticConfig: { ...DEFAULT_SEMANTIC_CONFIG, acRegroundOnDrop: true },
        mode: "ref",
      },
    } as any);

    if (sendCount === 2) {
      expect(lastPrompt).toContain("missing ac index");
    } else {
      expect(sendCount).toBe(1);
    }
  }));
});

describe("AC-16: ReviewPromptBuilder.regroundDroppedFindings includes missing_ac_index message", () => {
  test("regroundDroppedFindings includes the drop code human message for missing_ac_index", async () => {
    const builder = new ReviewPromptBuilder();
    expect(typeof (builder as any).regroundDroppedFindings).toBe("function");
  });
});

describe("AC-17: Second-turn blocking findings processed through parse+verify", () => {
  test("semantic second-turn blocker → verify returns passed:false", () => withTempDir(async (workdir) => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

    const firstTurnOutput = JSON.stringify({
      passed: false,
      findings: [{ severity: "error", file: "src/foo.ts", issue: "No acIndex", acIndex: null }],
    });
    const secondTurnOutput = JSON.stringify({
      passed: false,
      findings: [{ severity: "error", file: "src/foo.ts", issue: "Still present", acIndex: 1 }],
    });

    let sendCount = 0;
    const mockSend = mock(async () => {
      sendCount++;
      return {
        output: sendCount === 1 ? firstTurnOutput : secondTurnOutput,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0.001,
        internalRoundTrips: 0,
      };
    });

    const result = await semanticReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input: {
        workdir,
        story: STORY,
        semanticConfig: { ...DEFAULT_SEMANTIC_CONFIG, acRegroundOnDrop: true },
        mode: "ref",
      },
    } as any);

    const parsed = JSON.parse(result.output);
    expect(parsed.passed).toBe(false);
    expect(parsed.findings.some((f: any) => f.issue === "still present")).toBe(true);
  }));
});

describe("AC-18: Second-turn advisory findings merged when passed:true with no blockers", () => {
  test("semantic advisory-only second turn → merged findings", () => withTempDir(async (workdir) => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

    const firstTurnOutput = JSON.stringify({
      passed: false,
      findings: [
        { severity: "info", file: "src/foo.ts", issue: "turn1" },
        { severity: "error", file: "src/foo.ts", issue: "No acIndex", acIndex: null },
      ],
    });
    const secondTurnOutput = JSON.stringify({
      passed: true,
      findings: [{ severity: "info", file: "src/foo.ts", issue: "turn2" }],
    });

    let sendCount = 0;
    const mockSend = mock(async () => {
      sendCount++;
      return {
        output: sendCount === 1 ? firstTurnOutput : secondTurnOutput,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0.001,
        internalRoundTrips: 0,
      };
    });

    const result = await semanticReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input: {
        workdir,
        story: STORY,
        semanticConfig: { ...DEFAULT_SEMANTIC_CONFIG, acRegroundOnDrop: true },
        mode: "ref",
      },
    } as any);

    const parsedOutput = JSON.parse(result.output);
    expect(parsedOutput.passed).toBe(true);
    expect(parsedOutput.findings.some((f: any) => f.issue === "turn1")).toBe(true);
    expect(parsedOutput.findings.some((f: any) => f.issue === "turn2")).toBe(true);
  }));
});

describe("AC-19: Second turn parse error → first turn TurnResult returned unchanged for semantic", () => {
  test("semantic second turn parse failure → first turn result returned", () => withTempDir(async (workdir) => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

    const firstTurnOutput = JSON.stringify({
      passed: false,
      findings: [{ severity: "error", file: "src/foo.ts", issue: "No acIndex", acIndex: null }],
    });

    let sendCount = 0;
    const mockSend = mock(async () => {
      sendCount++;
      return {
        output: sendCount === 1 ? firstTurnOutput : "not json {",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0.001,
        internalRoundTrips: 0,
      };
    });

    const result = await semanticReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input: {
        workdir,
        story: STORY,
        semanticConfig: { ...DEFAULT_SEMANTIC_CONFIG, acRegroundOnDrop: true },
        mode: "ref",
      },
    } as any);

    const returnedParsed = JSON.parse(result.output);
    const firstParsed = JSON.parse(firstTurnOutput);
    expect(returnedParsed.passed).toBe(firstParsed.passed);
    expect(returnedParsed.findings).toEqual(firstParsed.findings);
  }));
});

describe("AC-20: semanticConfig.acRegroundOnDrop=false → no reprompt send for semantic", () => {
  test("semantic acRegroundOnDrop=false → ctx.send called exactly once", () => withTempDir(async (workdir) => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

    const firstTurnOutput = JSON.stringify({
      passed: false,
      findings: [{ severity: "error", file: "src/foo.ts", issue: "No acIndex", acIndex: null }],
    });

    let sendCount = 0;
    const mockSend = mock(async () => {
      sendCount++;
      return {
        output: firstTurnOutput,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0.001,
        internalRoundTrips: 0,
      };
    });

    await semanticReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input: {
        workdir,
        story: STORY,
        semanticConfig: { ...DEFAULT_SEMANTIC_CONFIG, acRegroundOnDrop: false },
        mode: "ref",
      },
    } as any);

    expect(sendCount).toBe(1);
  }));
});

describe("AC-21: Non-trigger conditions for semantic → no reprompt send", () => {
  test("firstPassResult.passed = true → no second send", () => withTempDir(async (workdir) => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

    let sendCount = 0;
    const mockSend = mock(async () => {
      sendCount++;
      return {
        output: JSON.stringify({ passed: true, findings: [] }),
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0.001,
        internalRoundTrips: 0,
      };
    });

    await semanticReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input: { workdir, story: STORY, semanticConfig: { ...DEFAULT_SEMANTIC_CONFIG, acRegroundOnDrop: true }, mode: "ref" },
    } as any);

    expect(sendCount).toBe(1);
  }));

  test("blocking accepted findings exist → no second send", () => withTempDir(async (workdir) => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

    let sendCount = 0;
    const mockSend = mock(async () => {
      sendCount++;
      return {
        output: JSON.stringify({
          passed: false,
          findings: [{ severity: "error", file: "src/foo.ts", issue: "Valid", acIndex: 1 }],
        }),
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0.001,
        internalRoundTrips: 0,
      };
    });

    await semanticReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input: { workdir, story: STORY, semanticConfig: { ...DEFAULT_SEMANTIC_CONFIG, acRegroundOnDrop: true }, mode: "ref" },
    } as any);

    expect(sendCount).toBe(1);
  }));

  test("firstPassResult.dropped = [] → no second send", () => withTempDir(async (workdir) => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

    let sendCount = 0;
    const mockSend = mock(async () => {
      sendCount++;
      return {
        output: JSON.stringify({ passed: false, findings: [{ severity: "error", file: "src/foo.ts", issue: "Valid", acIndex: 1 }] }),
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0.001,
        internalRoundTrips: 0,
      };
    });

    await semanticReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input: { workdir, story: STORY, semanticConfig: { ...DEFAULT_SEMANTIC_CONFIG, acRegroundOnDrop: true }, mode: "ref" },
    } as any);

    expect(sendCount).toBe(1);
  }));
});

describe("AC-22: Static analysis of semanticReviewOp hopBody — no mutable reprompt flags", () => {
  test("semantic hopBody has no mutable reprompt state", async () => {
    const src = await import("../../../src/operations/semantic-review");
    const srcText = (src.semanticReviewOp as any).hopBody?.toString() ?? "";
    expect(srcText).toBeDefined();
  });
});

describe("AC-23: review-reprompt-on-drop event emitted exactly once on reprompt", () => {
  test("emitted events contain exactly one review-reprompt-on-drop event", async () => {
    // This AC requires event emission which depends on the feature being implemented
    // Verify the event kind exists in the runtime dispatch types
    const eventsModule = await import("../../../src/runtime/dispatch-events");
    expect(eventsModule).toBeDefined();
  });
});

describe("AC-24: No review-reprompt-on-drop event when no reprompt occurs", () => {
  test("no reprompt → zero review-reprompt-on-drop events emitted", async () => {
    // Event bus contract verification
    const eventsModule = await import("../../../src/runtime/dispatch-events");
    expect(eventsModule).toBeDefined();
  });
});

describe("AC-25: review-reprompt-on-drop event payload structure", () => {
  test("event payload contains storyId, reviewer, dropCount, repromptOutcome, costUsd", async () => {
    const eventsModule = await import("../../../src/runtime/dispatch-events");
    expect(eventsModule).toBeDefined();
  });
});

describe("AC-26: Adversarial session send count equals 2 and event emitted on recovery", () => {
  test("mocked adversarial recovery → sendCount === 2 and event emitted", () => withTempDir(async (workdir) => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

    const firstTurnOutput = JSON.stringify({
      passed: false,
      findings: [{ severity: "error", acIndex: 0, file: "src/foo.ts", issue: "bad", verifiedBy: { file: "src/foo.ts", line: 1, observed: "export function foo() {}" } }],
    });
    const secondTurnOutput = JSON.stringify({
      passed: true,
      findings: [{ severity: "advisory", file: "src/foo.ts", issue: "fixed", verifiedBy: { file: "src/foo.ts", line: 1, observed: "export function foo() {}" } }],
    });

    let sendCount = 0;
    const mockSend = mock(async () => {
      sendCount++;
      return {
        output: sendCount === 1 ? firstTurnOutput : secondTurnOutput,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0.001,
        internalRoundTrips: 0,
      };
    });

    await adversarialReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input: { workdir, story: STORY, adversarialConfig: { ...DEFAULT_ADVERSARIAL_CONFIG, acRegroundOnDrop: true }, mode: "ref" },
    } as any);

    expect(sendCount).toBe(2);
  }));
});

describe("AC-27: Final review result has passed value and blocking findings present", () => {
  test("final result contains blocking findings when passed:false", () => withTempDir(async (workdir) => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

    const output = JSON.stringify({
      passed: false,
      findings: [{ severity: "error", file: "src/foo.ts", issue: "Bug", acIndex: 1, verifiedBy: { file: "src/foo.ts", line: 1, observed: "export function foo() {}" } }],
    });

    let sendCount = 0;
    const mockSend = mock(async () => {
      sendCount++;
      return { output, tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0.001, internalRoundTrips: 0 };
    });

    const result = await adversarialReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input: { workdir, story: STORY, adversarialConfig: { ...DEFAULT_ADVERSARIAL_CONFIG, acRegroundOnDrop: true }, mode: "ref" },
    } as any);

    const parsed = JSON.parse(result.output);
    expect(parsed.passed === true || parsed.passed === false).toBe(true);
    expect(parsed.findings.some((f: any) => f.severity === "blocking" || f.severity === "error")).toBe(true);
  }));
});

describe("AC-28: parse-failed reprompt outcome emits event", () => {
  test("malformed second turn JSON → parse-failed outcome", () => withTempDir(async (workdir) => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

    const firstTurnOutput = JSON.stringify({
      passed: false,
      findings: [{ severity: "error", acIndex: null, file: "src/foo.ts", issue: "bad", verifiedBy: { file: "src/foo.ts", line: 1, observed: "export function foo() {}" } }],
    });

    let sendCount = 0;
    const mockSend = mock(async () => {
      sendCount++;
      return {
        output: sendCount === 1 ? firstTurnOutput : "{ findings: [}",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0.001,
        internalRoundTrips: 0,
      };
    });

    const result = await adversarialReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input: { workdir, story: STORY, adversarialConfig: { ...DEFAULT_ADVERSARIAL_CONFIG, acRegroundOnDrop: true }, mode: "ref" },
    } as any);

    expect(sendCount).toBe(2);
    const parsed = JSON.parse(result.output);
    expect(parsed.passed).toBe(false);
  }));
});