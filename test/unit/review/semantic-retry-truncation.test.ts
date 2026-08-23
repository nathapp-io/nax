/**
 * Unit tests for truncation-aware condensed retry in semanticReviewOp.
 *
 * These tests exercise the parse-retry strategy's truncation detection via
 * callOp integration — the truncation prompt selection now lives in
 * makeParseRetryStrategy (parse-retry.ts), not in the hopBody directly.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentRunRequest } from "@/agents";
import * as loggerModule from "@/logger";
import { callOp, semanticReviewOp } from "@/operations";
import type { SemanticStory } from "@/review/semantic";
import type { SemanticReviewConfig } from "@/review/types";
import { makeMockAgentManager, makeSessionManager, makeTestRuntime } from "@test/helpers";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const STORY: SemanticStory = {
  id: "US-002",
  title: "Implement semantic review runner",
  description: "Create src/review/semantic.ts with runSemanticReview()",
  acceptanceCriteria: ["runSemanticReview() accepts workdir, storyGitRef, story, semanticConfig"],
};

const DEFAULT_SEMANTIC_CONFIG: SemanticReviewConfig = {
  model: "balanced",
  diffMode: "embedded",
  resetRefOnRerun: false,
  rules: [],
  timeoutMs: 60_000,
  substantiation: { requote: true, maxRequotes: 5 },
  excludePatterns: [":!test/", ":!*.test.ts"],
};

const PASSING_LLM_RESPONSE = JSON.stringify({ passed: true, findings: [] });

// A response whose JSON structure was opened and never closed — what
// looksLikeTruncatedJson() now detects. Long, so it also covers the case the old
// length-based rule conflated with truncation.
const UNFINISHED_JSON = `{"passed": false, "findings": [${'{"severity": "error", "file": "src/a.ts", "issue": "xxxxxxxxxx"},'.repeat(60)}{"severity": "error", "file": "src/b.ts", "issue": "cut off here`;

// ─── Logger mock helpers ─────────────────────────────────────────────────────

interface LogCall {
  stage: string;
  message: string;
  data?: Record<string, unknown>;
}

interface MockLogger {
  info: ReturnType<typeof mock>;
  warn: ReturnType<typeof mock>;
  debug: ReturnType<typeof mock>;
  infoCalls: LogCall[];
  warnCalls: LogCall[];
}

function makeLogger(): MockLogger {
  const infoCalls: LogCall[] = [];
  const warnCalls: LogCall[] = [];
  return {
    infoCalls,
    warnCalls,
    info: mock((stage: string, message: string, data?: Record<string, unknown>) => {
      infoCalls.push({ stage, message, data });
    }),
    warn: mock((stage: string, message: string, data?: Record<string, unknown>) => {
      warnCalls.push({ stage, message, data });
    }),
    debug: mock(() => {}),
  };
}

// ─── callOp helpers ───────────────────────────────────────────────────────────

function makeCallOpRuntime(responses: Array<{ output: string; cost?: number }>): {
  runtime: ReturnType<typeof makeTestRuntime>;
  capturedPrompts: string[];
} {
  const capturedPrompts: string[] = [];
  let callIdx = 0;

  const agentManager = makeMockAgentManager({
    runWithFallbackFn: async (req: AgentRunRequest) => {
      const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
      return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
    },
    runAsSessionFn: async (_agentName, _handle, prompt) => {
      capturedPrompts.push(prompt);
      const resp = responses[callIdx] ?? responses[responses.length - 1];
      callIdx++;
      return {
        output: resp.output,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: resp.cost ?? 0.001,
        internalRoundTrips: 0,
      };
    },
  });
  const runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager() });
  return { runtime, capturedPrompts };
}

async function runSemanticOp(runtime: ReturnType<typeof makeTestRuntime>): Promise<ReturnType<typeof callOp>> {
  return callOp(
    { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-002" },
    semanticReviewOp,
    { workdir: "/tmp/wd", story: STORY, semanticConfig: DEFAULT_SEMANTIC_CONFIG, mode: "embedded" },
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("truncation-detected condensed retry", () => {
  test("uses condensed retry prompt when the JSON structure is unfinished", async () => {
    const { runtime, capturedPrompts } = makeCallOpRuntime([
      { output: UNFINISHED_JSON },
      { output: PASSING_LLM_RESPONSE },
    ]);

    await runSemanticOp(runtime);

    expect(capturedPrompts).toHaveLength(2);
    expect(capturedPrompts[1]).toContain("truncated");
  });

  test("uses standard retry prompt when response is short unparseable text (structurally complete)", async () => {
    const { runtime, capturedPrompts } = makeCallOpRuntime([
      { output: "here is my analysis: the code looks fine overall" },
      { output: PASSING_LLM_RESPONSE },
    ]);

    await runSemanticOp(runtime);

    expect(capturedPrompts).toHaveLength(2);
    expect(capturedPrompts[1]).not.toContain("truncated");
  });

  test("fires retry when JSON is unfinished, even before attempting parse", async () => {
    const { runtime, capturedPrompts } = makeCallOpRuntime([
      { output: UNFINISHED_JSON },
      { output: PASSING_LLM_RESPONSE },
    ]);

    await runSemanticOp(runtime);

    expect(capturedPrompts).toHaveLength(2);
  });

  test("succeeds when condensed retry returns valid JSON after cap-length truncation", async () => {
    // Finding must carry a valid acQuote grounded in the AC text so verify() passes it through.
    // AC: "runSemanticReview() accepts workdir, storyGitRef, story, semanticConfig"
    // File: "src/semantic-review.ts" — locus keyword "semantic" appears in both file and AC.
    const condensedResponse = JSON.stringify({
      passed: false,
      findings: [
        {
          severity: "error",
          file: "src/semantic-review.ts",
          line: 1,
          issue: "missing impl",
          suggestion: "add it",
          acQuote: "runSemanticReview() accepts workdir",
          acIndex: 1,
        },
      ],
    });
    const { runtime } = makeCallOpRuntime([{ output: UNFINISHED_JSON }, { output: condensedResponse }]);

    const result = await runSemanticOp(runtime);

    // verify() is authoritative; finding has a valid acQuote → survives filter → passed:false.
    expect((result as { passed: boolean }).passed).toBe(false);
  });
});

describe("truncation logging", () => {
  let loggerSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    loggerSpy?.mockRestore();
  });

  test("logs warn 'truncated' when the JSON is unfinished", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);

    const { runtime } = makeCallOpRuntime([{ output: UNFINISHED_JSON }, { output: PASSING_LLM_RESPONSE }]);

    await runSemanticOp(runtime);

    const truncatedLog = logger.warnCalls.find((c) => c.message.includes("truncated"));
    expect(truncatedLog).toBeDefined();
    expect(truncatedLog?.stage).toBe("semantic");
  });

  test("does not log truncation warning when response is short unparseable text (structurally complete)", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);

    const { runtime } = makeCallOpRuntime([{ output: "not json text" }, { output: PASSING_LLM_RESPONSE }]);

    await runSemanticOp(runtime);

    const truncatedLog = logger.warnCalls.find((c) => c.message.includes("truncated"));
    expect(truncatedLog).toBeUndefined();
  });
});

describe("Bug 4 regression: parser-first, length is a hint not a veto", () => {
  test("parseable long response is NOT retried (Bug 4 regression)", async () => {
    const validNearCap = JSON.stringify({
      passed: false,
      findings: Array.from({ length: 7 }, (_, i) => ({
        severity: "error",
        file: `src/file${i}.ts`,
        line: 10 + i,
        issue: "x".repeat(500),
        suggestion: "y".repeat(150),
        verifiedBy: { command: "read", file: `src/file${i}.ts`, line: 10 + i, observed: "..." },
      })),
    });
    expect(validNearCap.length).toBeGreaterThanOrEqual(4900);

    const { runtime, capturedPrompts } = makeCallOpRuntime([{ output: validNearCap }]);

    await runSemanticOp(runtime);

    expect(capturedPrompts).toHaveLength(1);
  });

  test("unparseable unfinished response still triggers condensed retry", async () => {
    const { runtime, capturedPrompts } = makeCallOpRuntime([
      { output: UNFINISHED_JSON },
      { output: PASSING_LLM_RESPONSE },
    ]);

    await runSemanticOp(runtime);

    expect(capturedPrompts).toHaveLength(2);
    expect(capturedPrompts[1]).toContain("truncated");
  });

  test("parseable response with invalid shape triggers standard (non-condensed) retry", async () => {
    const wrongShape = JSON.stringify({ passed: true });
    const { runtime, capturedPrompts } = makeCallOpRuntime([{ output: wrongShape }, { output: PASSING_LLM_RESPONSE }]);

    await runSemanticOp(runtime);

    expect(capturedPrompts).toHaveLength(2);
    expect(capturedPrompts[1]).not.toContain("truncated");
  });
});
