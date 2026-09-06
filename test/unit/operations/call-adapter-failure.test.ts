import { afterEach, describe, expect, test } from "bun:test";
import { makeMockAgentManager, makeSessionManager, makeTestRuntime } from "@test/helpers";
import type { AgentRunRequest } from "@/agents/manager-types";
import type { DEFAULT_CONFIG } from "@/config";
import { pickSelector } from "@/config";
import type { AdapterFailure } from "@/context/engine";
import type { RunOperation } from "@/operations";
import { callOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";

let runtime: NaxRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
});

const testSel = pickSelector("routing-op-test", "routing");

// Mirrors the echoOp shape used elsewhere in test/unit/operations/call*.test.ts.
// Lives next to the describe block instead of in a shared module so each test
// file is self-contained and the split-by-concern rule does not require a new
// helper file just for fixture ops.
const runEchoOp: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
  kind: "run",
  name: "run-echo-test",
  stage: "run",
  config: testSel,
  session: { role: "implementer", lifetime: "fresh" },
  build: (input) => ({
    role: { id: "role", content: "You echo text.", overridable: false },
    task: { id: "task", content: input.text, overridable: false },
  }),
  parse: (output) => output.trim(),
};

// US-001 — Preserve dispatch failure on acceptance operation output. The run-kind
// branch of callOp must attach outcome.result.adapterFailure to the parsed value
// when (a) the outcome carries one and (b) the parsed value does not already carry
// its own. Strings and parsed objects that already carry a failure are returned
// unchanged (AC5-AC8).
describe("callOp — kind:run — attach adapterFailure from dispatch outcome (US-001 AC5-AC8)", () => {
  // Acceptance-shaped op: parses the run outcome's stdout to { testCode }.
  const acceptanceOp: RunOperation<
    { text: string },
    { testCode: string | null; adapterFailure?: AdapterFailure },
    Pick<typeof DEFAULT_CONFIG, "routing">
  > = {
    kind: "run",
    name: "acceptance-generate",
    stage: "run",
    config: testSel,
    session: { role: "implementer", lifetime: "fresh" },
    build: (input) => ({
      role: { id: "role", content: "Echo text.", overridable: false },
      task: { id: "task", content: input.text, overridable: false },
    }),
    parse: (output) => {
      // A trivial fixture parser — emit the literal {"testCode": null} for the
      // SENTINEL_NULL marker, otherwise echo whatever it was given.
      if (output === "SENTINEL_NULL") return { testCode: null };
      if (output === "SENTINEL_OBJECT") {
        return {
          testCode: "code",
          adapterFailure: { outcome: "fail-quality", category: "quality", retriable: false, message: "producer" },
        };
      }
      return { testCode: output };
    },
  };

  function makeRunResultWithFailure(output: string, failure: AdapterFailure | undefined) {
    return async (_req: AgentRunRequest) => ({
      result: {
        success: true,
        exitCode: 0,
        output,
        rateLimited: false,
        durationMs: 1,
        estimatedCostUsd: 0,
        agentFallbacks: [],
        ...(failure !== undefined ? { adapterFailure: failure } : {}),
      },
      fallbacks: [],
    });
  }

  // US-001 AC5: outcome carries adapterFailure, parse returns { testCode: null } —
  // the parsed value's adapterFailure is the dispatch outcome's.
  test("AC5: attaches adapterFailure from outcome when parse returns { testCode: null }", async () => {
    const failure: AdapterFailure = {
      outcome: "fail-service-down",
      category: "availability",
      retriable: false,
      message: "dispatch service down",
    };
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: makeRunResultWithFailure("SENTINEL_NULL", failure),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const result = await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      acceptanceOp,
      { text: "x" },
    );

    expect(result.testCode).toBeNull();
    expect(result.adapterFailure).toEqual(failure);
    expect(result.adapterFailure?.outcome).toBe("fail-service-down");
  });

  // US-001 AC6: outcome carries no adapterFailure — the parsed value
  // has no adapterFailure property.
  test("AC6: leaves parsed value untouched when outcome carries no adapterFailure", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: makeRunResultWithFailure("some code", undefined),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const result = await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      acceptanceOp,
      { text: "x" },
    );

    expect(result.testCode).toBe("some code");
    expect("adapterFailure" in result).toBe(false);
  });

  // US-001 AC7: outcome carries adapterFailure fail-service-down, but parse
  // returns an object already carrying fail-quality — the producer's
  // adapterFailure wins; the dispatch outcome's is not overwritten.
  test("AC7: preserves producer's adapterFailure over dispatch outcome's", async () => {
    const failure: AdapterFailure = {
      outcome: "fail-service-down",
      category: "availability",
      retriable: false,
      message: "dispatch service down",
    };
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: makeRunResultWithFailure("SENTINEL_OBJECT", failure),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const result = await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      acceptanceOp,
      { text: "x" },
    );

    expect(result.testCode).toBe("code");
    expect(result.adapterFailure?.outcome).toBe("fail-quality");
  });

  // US-001 AC8: parse returns a string — the value is returned verbatim
  // regardless of the dispatch outcome's adapterFailure.
  test("AC8: returns the same string when parse returns a string", async () => {
    const failure: AdapterFailure = {
      outcome: "fail-service-down",
      category: "availability",
      retriable: true,
      message: "dispatch failure",
    };
    // Use the runEchoOp (parse: output.trim()) — the strict case from
    // runEchoOp returns whatever the dispatch outcome's output was.
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: makeRunResultWithFailure("hello-string-output", failure),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const result = await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      runEchoOp,
      { text: "x" },
    );

    expect(result).toBe("hello-string-output");
  });
});
