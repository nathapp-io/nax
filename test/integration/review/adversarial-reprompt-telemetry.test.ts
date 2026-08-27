/**
 * Integration tests for review-reprompt-on-drop telemetry emission (AC4–AC6).
 *
 * Exercises runAdversarialReview end-to-end with mocked LLM sessions,
 * verifying that the reprompt event wires through hopBody → parse → emitReviewReprompt.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeMockRuntime, makeSpawn, withTempDir } from "@test/helpers";
import type { AdversarialReviewOutput, adversarialReviewOp } from "@/operations/adversarial-review";
import { _adversarialDeps, runAdversarialReview } from "@/review/adversarial";
import { _diffUtilsDeps } from "@/review/diff-utils";
import type { NaxRuntime } from "@/runtime";
import type { ReviewRepromptEvent } from "@/runtime/dispatch-events";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

function makeRuntime(workdir: string): NaxRuntime {
  const rt = makeMockRuntime({ workdir });
  createdRuntimes.push(rt);
  return rt;
}

const STORY = {
  id: "int-story-reprompt",
  title: "Integration test story",
  description: "reprompt telemetry integration test",
  acceptanceCriteria: ["AC1: must not allow SQL injection in auth module"],
};

const ADVERSARIAL_CONFIG = {
  model: "balanced" as const,
  diffMode: "ref" as const,
  rules: [],
  timeoutMs: 60_000,
  parallel: false,
  maxConcurrentSessions: 2,
  substantiation: { requote: true, maxRequotes: 5 },
  acRegroundOnDrop: true as const,
};

// First turn: acQuote does NOT appear in any AC → filterByAcQuote drops all blocking findings → reprompt fires
const FIRST_TURN_OUTPUT = JSON.stringify({
  passed: false,
  findings: [
    {
      severity: "error",
      category: "security",
      file: "src/auth.ts",
      line: 1,
      issue: "rawQuery SQL injection vulnerability",
      acIndex: 1,
      acQuote: "completely unrelated phrase not in any AC",
      verifiedBy: { file: "src/auth.ts", line: 1, observed: "db.rawQuery" },
    },
  ],
});

// Second turn (success path): acQuote IS a substring of AC1 and contains locus keyword
// "SQL injection" ⊆ "must not allow SQL injection in auth module", and acQuote
// contains keyword "sql" / "injection" extracted from the issue text.
const SECOND_TURN_GROUNDED = JSON.stringify({
  passed: false,
  findings: [
    {
      severity: "error",
      category: "security",
      file: "src/auth.ts",
      line: 1,
      issue: "rawQuery SQL injection vulnerability",
      acIndex: 1,
      acQuote: "SQL injection",
      verifiedBy: { file: "src/auth.ts", line: 1, observed: "db.rawQuery" },
    },
  ],
});

// Second turn (parse-failed path): invalid JSON
const SECOND_TURN_INVALID = "not valid json at all";

type SavedAdversarialDeps = Pick<typeof _adversarialDeps, "callOp" | "collectDiffFileList" | "writeReviewAudit">;
type SavedDiffUtilsDeps = Pick<typeof _diffUtilsDeps, "isGitRefValid" | "getMergeBase" | "spawn">;

function saveDeps(): { adversarial: SavedAdversarialDeps; diffUtils: SavedDiffUtilsDeps } {
  return {
    adversarial: {
      callOp: _adversarialDeps.callOp,
      collectDiffFileList: _adversarialDeps.collectDiffFileList,
      writeReviewAudit: _adversarialDeps.writeReviewAudit,
    },
    diffUtils: {
      isGitRefValid: _diffUtilsDeps.isGitRefValid,
      getMergeBase: _diffUtilsDeps.getMergeBase,
      spawn: _diffUtilsDeps.spawn,
    },
  };
}

function restoreDeps(saved: { adversarial: SavedAdversarialDeps; diffUtils: SavedDiffUtilsDeps }): void {
  _adversarialDeps.callOp = saved.adversarial.callOp;
  _adversarialDeps.collectDiffFileList = saved.adversarial.collectDiffFileList;
  _adversarialDeps.writeReviewAudit = saved.adversarial.writeReviewAudit;
  _diffUtilsDeps.isGitRefValid = saved.diffUtils.isGitRefValid;
  _diffUtilsDeps.getMergeBase = saved.diffUtils.getMergeBase;
  _diffUtilsDeps.spawn = saved.diffUtils.spawn;
}

/**
 * Build a mock callOp that calls adversarialReviewOp.hopBody internally with
 * controlled send responses, then runs parse + verify. Tracks how many LLM
 * sends the hopBody triggered.
 */
function makeMockedCallOpWithSendTracking(opts: { secondTurnOutput: string; onSendCount: (count: number) => void }) {
  return async (
    _ctx: unknown,
    op: typeof adversarialReviewOp,
    input: import("@/operations/adversarial-review").AdversarialReviewInput,
  ) => {
    let sendCount = 0;

    const mockSend = async () => {
      sendCount += 1;
      const output = sendCount === 1 ? FIRST_TURN_OUTPUT : opts.secondTurnOutput;
      return {
        output,
        estimatedCostUsd: 0.001,
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        internalRoundTrips: 0,
      };
    };

    const hopFn = op.hopBody as (
      prompt: string,
      ctx: unknown,
    ) => Promise<{ output: string; estimatedCostUsd?: number }>;
    const hopResult = await hopFn("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input,
    });

    opts.onSendCount(sendCount);

    const parseFn = op.parse as (
      output: string,
      input: import("@/operations/adversarial-review").AdversarialReviewInput,
      ctx: unknown,
    ) => AdversarialReviewOutput;
    const parsed = parseFn(hopResult.output, input, {});
    const verifyFn = op.verify as (
      parsed: AdversarialReviewOutput,
      input: import("@/operations/adversarial-review").AdversarialReviewInput,
      ctx: unknown,
    ) => Promise<AdversarialReviewOutput>;
    const verified = await verifyFn(parsed, input, {});
    return verified;
  };
}

describe("AC4 + AC5: reprompt with grounded second turn", () => {
  test("adversarial session send count equals 2 and exactly one review-reprompt-on-drop event is emitted", async () => {
    return withTempDir(async (workdir) => {
      // Create file so substantiateAdversarialFindings can match the observed text
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      const saved = saveDeps();
      afterEach(() => restoreDeps(saved));

      let capturedSendCount = 0;
      _diffUtilsDeps.isGitRefValid = mock(async () => true);
      _diffUtilsDeps.getMergeBase = mock(async () => undefined);
      _diffUtilsDeps.spawn = makeSpawn(() => "1 file changed").spawn;
      _adversarialDeps.collectDiffFileList = async () => ["src/auth.ts"];
      _adversarialDeps.writeReviewAudit = async () => {};
      _adversarialDeps.callOp = makeMockedCallOpWithSendTracking({
        secondTurnOutput: SECOND_TURN_GROUNDED,
        onSendCount: (n) => {
          capturedSendCount = n;
        },
      }) as typeof _adversarialDeps.callOp;

      const runtime = makeRuntime(workdir);
      const repromptEvents: ReviewRepromptEvent[] = [];
      runtime.dispatchEvents.onReviewReprompt((e) => repromptEvents.push(e));

      await runAdversarialReview({
        workdir,
        storyGitRef: "abc123",
        story: STORY,
        adversarialConfig: ADVERSARIAL_CONFIG,
        agentManager: undefined,
        runtime,
      });

      expect(capturedSendCount).toBe(2);
      expect(repromptEvents).toHaveLength(1);
      expect(repromptEvents[0].kind).toBe("review-reprompt-on-drop");
      expect(repromptEvents[0].storyId).toBe(STORY.id);
      expect(repromptEvents[0].reviewer).toBe("adversarial");
    });
  });

  test("AC5: final review result is passed:true or passed:false with findings visible in output", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      const saved = saveDeps();
      // biome-ignore lint/suspicious/noDuplicateTestHooks: pre-existing — three tests each register a restore hook from inside the test body; belongs at describe level, deferred to the per-file drain (#1514)
      afterEach(() => restoreDeps(saved));

      _diffUtilsDeps.isGitRefValid = mock(async () => true);
      _diffUtilsDeps.getMergeBase = mock(async () => undefined);
      _diffUtilsDeps.spawn = makeSpawn(() => "1 file changed").spawn;
      _adversarialDeps.collectDiffFileList = async () => ["src/auth.ts"];
      _adversarialDeps.writeReviewAudit = async () => {};
      _adversarialDeps.callOp = makeMockedCallOpWithSendTracking({
        secondTurnOutput: SECOND_TURN_GROUNDED,
        onSendCount: () => {},
      }) as typeof _adversarialDeps.callOp;

      const runtime = makeRuntime(workdir);

      const result = await runAdversarialReview({
        workdir,
        storyGitRef: "abc123",
        story: STORY,
        adversarialConfig: ADVERSARIAL_CONFIG,
        agentManager: undefined,
        runtime,
      });

      // Result must be either passed (success:true) or failed with at least one finding in output
      const isPassed = result.success === true;
      const isFailedWithFindings =
        result.success === false && typeof result.output === "string" && result.output.length > 0;
      expect(isPassed || isFailedWithFindings).toBe(true);
    });
  });
});

describe("AC6: parse-failed outcome when second turn is invalid JSON", () => {
  test("one telemetry event is emitted with repromptOutcome:parse-failed", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      const saved = saveDeps();
      afterEach(() => restoreDeps(saved));

      _diffUtilsDeps.isGitRefValid = mock(async () => true);
      _diffUtilsDeps.getMergeBase = mock(async () => undefined);
      _diffUtilsDeps.spawn = makeSpawn(() => "1 file changed").spawn;
      _adversarialDeps.collectDiffFileList = async () => ["src/auth.ts"];
      _adversarialDeps.writeReviewAudit = async () => {};
      _adversarialDeps.callOp = makeMockedCallOpWithSendTracking({
        secondTurnOutput: SECOND_TURN_INVALID,
        onSendCount: () => {},
      }) as typeof _adversarialDeps.callOp;

      const runtime = makeRuntime(workdir);
      const repromptEvents: ReviewRepromptEvent[] = [];
      runtime.dispatchEvents.onReviewReprompt((e) => repromptEvents.push(e));

      await runAdversarialReview({
        workdir,
        storyGitRef: "abc123",
        story: STORY,
        adversarialConfig: ADVERSARIAL_CONFIG,
        agentManager: undefined,
        runtime,
      });

      expect(repromptEvents).toHaveLength(1);
      expect(repromptEvents[0].kind).toBe("review-reprompt-on-drop");
      expect(repromptEvents[0].repromptOutcome).toBe("parse-failed");
    });
  });
});
