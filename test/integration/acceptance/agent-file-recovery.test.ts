/**
 * Integration test: verify hook recovers agent-written test files (ADR-020 Wave 3 / bug #774)
 *
 * ACP agents write the test file as a tool-call side effect and return a
 * conversational summary. The verify hook on acceptanceGenerateOp detects this
 * pattern and recovers the file content so the caller receives real testCode
 * instead of null (which would trigger the skeleton fallback in acceptance-setup).
 *
 * Test coverage:
 *   1. Agent writes real test file + returns conversational stdout → verify recovers it
 *   2. Agent writes stub test file + returns conversational stdout → verify returns null
 *   3. Agent returns conversational stdout, no file written → verify returns null
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { acceptanceGenerateOp, callOp } from "../../../src/operations";
import type { AcceptanceGenerateInput, CallContext } from "../../../src/operations";
import { makeMockAgentManager, makeTestRuntime } from "../../helpers";
import { withTempDir } from "../../helpers/temp";

const REAL_TEST_CODE = `import { describe, test, expect } from "bun:test";
describe("test-feature - Acceptance Tests", () => {
  test("AC-1: do X", () => {
    expect(1 + 1).toBe(2);
  });
});
`;

const STUB_TEST_CODE = `import { describe, test, expect } from "bun:test";
describe("test-feature - Acceptance Tests", () => {
  test("AC-1: do X", () => {
    expect(true).toBe(false);
  });
});
`;

const CONVERSATIONAL_OUTPUT =
  "I have written the acceptance tests to the target file. The tests cover all specified ACs.";

describe("acceptanceGenerateOp.verify — agent-file recovery (bug #774)", () => {
  test("agent writes real test file to disk + returns conversational stdout — verify recovers file", async () => {
    await withTempDir(async (dir) => {
      const testFilePath = join(dir, "test-feature.nax-acceptance.test.ts");

      const agentManager = makeMockAgentManager({
        completeAsFn: async () => {
          await Bun.write(testFilePath, REAL_TEST_CODE);
          return { output: CONVERSATIONAL_OUTPUT, costUsd: 0, source: "exact" as const };
        },
      });
      const runtime = makeTestRuntime({ agentManager, workdir: dir });
      const ctx: CallContext = {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: dir,
        agentName: "claude",
        storyId: "US-001",
        featureName: "test-feature",
      };
      const input: AcceptanceGenerateInput = {
        featureName: "test-feature",
        criteriaList: "AC-1: do X",
        frameworkOverrideLine: "",
        targetTestFilePath: testFilePath,
      };

      const result = await callOp(ctx, acceptanceGenerateOp, input);

      expect(result.testCode).not.toBeNull();
      expect(result.testCode).toContain("describe");
      expect(result.testCode).not.toContain("expect(true).toBe(false)");
    });
  });

  test("agent writes stub test file to disk + returns conversational stdout — verify returns null", async () => {
    await withTempDir(async (dir) => {
      const testFilePath = join(dir, "test-feature.nax-acceptance.test.ts");

      const agentManager = makeMockAgentManager({
        completeAsFn: async () => {
          await Bun.write(testFilePath, STUB_TEST_CODE);
          return { output: CONVERSATIONAL_OUTPUT, costUsd: 0, source: "exact" as const };
        },
      });
      const runtime = makeTestRuntime({ agentManager, workdir: dir });
      const ctx: CallContext = {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: dir,
        agentName: "claude",
        storyId: "US-001",
        featureName: "test-feature",
      };
      const input: AcceptanceGenerateInput = {
        featureName: "test-feature",
        criteriaList: "AC-1: do X",
        frameworkOverrideLine: "",
        targetTestFilePath: testFilePath,
      };

      const result = await callOp(ctx, acceptanceGenerateOp, input);

      expect(result.testCode).toBeNull();
    });
  });

  test("agent returns conversational stdout with no file written — verify returns null", async () => {
    await withTempDir(async (dir) => {
      const testFilePath = join(dir, "test-feature.nax-acceptance.test.ts");

      const agentManager = makeMockAgentManager({
        completeAsFn: async () => ({ output: CONVERSATIONAL_OUTPUT, costUsd: 0, source: "exact" as const }),
      });
      const runtime = makeTestRuntime({ agentManager, workdir: dir });
      const ctx: CallContext = {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: dir,
        agentName: "claude",
        storyId: "US-001",
        featureName: "test-feature",
      };
      const input: AcceptanceGenerateInput = {
        featureName: "test-feature",
        criteriaList: "AC-1: do X",
        frameworkOverrideLine: "",
        targetTestFilePath: testFilePath,
      };

      const result = await callOp(ctx, acceptanceGenerateOp, input);

      expect(result.testCode).toBeNull();
    });
  });
});
